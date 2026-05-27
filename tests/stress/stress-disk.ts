import app from '../../src/app';
import { prisma } from '../../src/services/db';
import { ExpiryService } from '../../src/services/expiry.service';
import { storageService } from '../../src/services/storage.service';
import { AssetState, AssetType } from '@prisma/client';

// Automatically inject Authorization header to all fetch requests
const originalFetch = global.fetch;
global.fetch = function(url: any, options: any = {}) {
  options.headers = options.headers || {};
  if (options.headers instanceof Headers) {
    options.headers.set('Authorization', 'Bearer test-api-key');
  } else if (Array.isArray(options.headers)) {
    options.headers.push(['Authorization', 'Bearer test-api-key']);
  } else {
    options.headers['Authorization'] = 'Bearer test-api-key';
  }
  return originalFetch(url, options);
} as any;
import { ResourceMonitor, buildMultipartBody, generateRandomBuffer } from './test-utils';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import assert from 'assert';

const PORT = 3009;
const BASE_URL = `http://127.0.0.1:${PORT}/api/v1`;

async function main() {
  console.log('🏁 Starting Part 4: Disk & File Descriptor Stress Test...\n');

  // Connect and clean tables
  await prisma.$connect();
  await prisma.asset.deleteMany({});
  await prisma.destinationPreset.deleteMany({});

  // Reset uploads dir
  const uploadsDir = path.resolve('./uploads');
  if (fs.existsSync(uploadsDir)) {
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(uploadsDir, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(uploadsDir, 'assets'), { recursive: true });

  const address = await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`📡 Disk Stress server online at ${address}`);

  const expiryService = new ExpiryService(prisma);
  const monitor = new ResourceMonitor();
  monitor.startLagMonitor(10);

  const durationMs = 25000; // 25 seconds of heavy disk IO
  const runUntil = Date.now() + durationMs;

  let uploadSuccessCount = 0;
  let uploadFailureCount = 0;
  let softDeleteSuccessCount = 0;
  let softDeleteFailureCount = 0;
  let cleanupRunCount = 0;
  let cleanupFailureCount = 0;

  const fileErrors: string[] = [];

  // Pre-generate file buffers to avoid crypto thrashing and keep CPU focused on Disk IO
  const file1MB = generateRandomBuffer(1 * 1024 * 1024);
  const file5MB = generateRandomBuffer(5 * 1024 * 1024);

  // Helper to record file-related errors
  function recordError(operation: string, err: any) {
    const errMsg = err.message || String(err);
    console.error(`❌ [${operation}] Error: ${errMsg}`);
    fileErrors.push(`${operation}: ${errMsg}`);
  }

  // 1. Upload Worker Loop (concurrency = 4)
  const uploadWorkers = Array.from({ length: 4 }).map(async (_, workerIdx) => {
    let index = 0;
    while (Date.now() < runUntil) {
      try {
        const sizeClass = index % 2 === 0 ? '1MB' : '5MB';
        const buffer = index % 2 === 0 ? file1MB : file5MB;
        
        const boundary = `----DiskStressBoundary${crypto.randomUUID()}`;
        const source = 'disk-stress-uploader';
        const filename = `disk-stress-w${workerIdx}-${index}-${crypto.randomUUID()}.dat`;
        const title = `Disk Stress Upload w${workerIdx} #${index}`;

        // Duplicate the buffer template and write unique signatures to it
        const payloadBuffer = Buffer.alloc(buffer.length);
        buffer.copy(payloadBuffer);
        payloadBuffer.write(`unique-sig-${workerIdx}-${index}-${crypto.randomUUID()}`, 0, 'utf8');

        const multipartBody = buildMultipartBody(
          filename,
          'application/octet-stream',
          payloadBuffer,
          { source, title },
          boundary
        );

        const res = await fetch(`${BASE_URL}/inbox`, {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`
          },
          body: multipartBody
        });

        if (res.status === 201 || res.status === 200) {
          uploadSuccessCount++;
        } else {
          uploadFailureCount++;
          const body = await res.text();
          recordError('UPLOAD', new Error(`HTTP Status ${res.status}: ${body}`));
        }
      } catch (err) {
        uploadFailureCount++;
        recordError('UPLOAD', err);
      }
      index++;
      // Sleep briefly to prevent pinning CPU
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  });

  // 2. Soft-Delete & Backdate Worker Loop (concurrency = 2)
  // Queries active assets, soft-deletes them, and updates deletedAt to be 31 days ago in the DB
  const deleteWorkers = Array.from({ length: 2 }).map(async (_, workerIdx) => {
    while (Date.now() < runUntil) {
      try {
        // Query some PROCESS_NOW assets
        const activeAssets = await prisma.asset.findMany({
          where: { state: AssetState.PROCESS_NOW },
          take: 10
        });

        if (activeAssets.length > 0) {
          // Select one randomly
          const target = activeAssets[Math.floor(Math.random() * activeAssets.length)];
          
          // Soft delete it
          const patchRes = await fetch(`${BASE_URL}/inbox/${target.id}/state`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: AssetState.DELETED })
          });

          if (patchRes.status === 200 || patchRes.status === 400) {
            if (patchRes.status === 200) {
              // Force-backdate deletedAt in the database directly to bypass expiry threshold
              const backdateThreshold = new Date();
              backdateThreshold.setDate(backdateThreshold.getDate() - 31); // 31 days ago

              await prisma.asset.update({
                where: { id: target.id },
                data: { deletedAt: backdateThreshold }
              });
            }
            softDeleteSuccessCount++;
          } else {
            softDeleteFailureCount++;
            const body = await patchRes.text();
            recordError('SOFT_DELETE', new Error(`HTTP Status ${patchRes.status}: ${body}`));
          }
        }
      } catch (err) {
        softDeleteFailureCount++;
        recordError('SOFT_DELETE', err);
      }
      // Sleep slightly longer to let assets accumulate
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  });

  // 3. Expiry Service Cleanup Loop
  const cleanupWorker = (async () => {
    while (Date.now() < runUntil) {
      try {
        await expiryService.runCleanup();
        cleanupRunCount++;
      } catch (err) {
        cleanupFailureCount++;
        recordError('CLEANUP', err);
      }
      // Trigger cleanup every 200ms
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  })();

  // Wait for all workers to finish
  await Promise.all([...uploadWorkers, ...deleteWorkers, cleanupWorker]);

  const stats = monitor.getStats();
  const lagStats = monitor.stopLagMonitor();

  console.log('\nDisk & File Descriptor Stress Run Summary:');
  console.log(`- Uploads: Success: ${uploadSuccessCount}, Failed: ${uploadFailureCount}`);
  console.log(`- Soft-Deletes: Success: ${softDeleteSuccessCount}, Failed: ${softDeleteFailureCount}`);
  console.log(`- Cleanup Cycles run: ${cleanupRunCount}, Failed: ${cleanupFailureCount}`);
  console.log(`- Total file operation errors: ${fileErrors.length}`);
  console.log(`- Peak RSS Memory: ${stats.rss.toFixed(2)} MB`);
  console.log(`- Max Event Loop Lag: ${lagStats.maxLagMs.toFixed(2)} ms`);

  // Verify that there are no serious descriptor/lock errors
  const criticalErrors = fileErrors.filter(err => 
    err.includes('EMFILE') || 
    err.includes('ENFILE') || 
    err.includes('EBUSY') || 
    err.includes('EPERM') ||
    err.includes('locked')
  );

  console.log(`- Critical OS File Errors (Descriptor/Locking): ${criticalErrors.length}`);
  assert.strictEqual(criticalErrors.length, 0, `Critical OS file errors were thrown: ${JSON.stringify(criticalErrors)}`);
  assert.strictEqual(uploadFailureCount, 0, 'No uploads should fail');
  assert.strictEqual(softDeleteFailureCount, 0, 'No soft-deletes should fail');
  assert.strictEqual(cleanupFailureCount, 0, 'No cleanup cycles should fail');

  // Verify DB <-> Storage Sync Integrity
  console.log('\n🔍 Verifying DB <-> Disk Storage Integrity...');
  const assetsInDb = await prisma.asset.findMany({});
  console.log(`- Active assets in DB: ${assetsInDb.length}`);

  // Fetch files in permanent storage folder
  const filesOnDisk: string[] = [];
  function readDirRecursive(dir: string, base: string = '') {
    if (!fs.existsSync(dir)) return;
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const relPath = base ? `${base}/${item}` : item;
      if (fs.statSync(fullPath).isDirectory()) {
        readDirRecursive(fullPath, relPath);
      } else {
        filesOnDisk.push(relPath);
      }
    }
  }

  const permanentDir = path.join(uploadsDir, 'assets');
  readDirRecursive(permanentDir);
  console.log(`- Files in permanent storage on disk: ${filesOnDisk.length}`);

  // Assert every asset in DB has its file on disk
  for (const asset of assetsInDb) {
    const relativeKey = asset.fileKey.replace('assets/', '');
    const pathExists = fs.existsSync(storageService.getFilePath(asset.fileKey));
    assert.ok(pathExists, `DB fileKey references missing file on disk: ${asset.fileKey}`);
  }
  console.log('✅ PASS: All DB assets have corresponding physical files on disk.');

  // Assert no orphan permanent files exist (all files on disk must have a DB record)
  for (const fileRel of filesOnDisk) {
    const fileKey = `assets/${fileRel}`.replace(/\\/g, '/');
    const asset = assetsInDb.find(a => a.fileKey === fileKey);
    assert.ok(asset !== undefined, `Orphan file detected in permanent storage: ${fileKey}`);
  }
  console.log('✅ PASS: No orphan files detected in permanent storage.');

  console.log('\n✅ PASS: Part 4 Disk and File Descriptor Stress test completed successfully.');
  
  await app.close();
  await prisma.$disconnect();
}

main().catch(err => {
  console.error('❌ Part 4 Stress Test crashed:', err);
  process.exit(1);
});
