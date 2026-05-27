import app from '../../src/app';
import { prisma } from '../../src/services/db';
import { storageService } from '../../src/services/storage.service';

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

const PORT = 3010;
const BASE_URL = `http://127.0.0.1:${PORT}/api/v1`;

async function main() {
  console.log('🏁 Starting Part 5: Large File Stress Test...\n');

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
  console.log(`📡 Large File Stress server online at ${address}`);

  const monitor = new ResourceMonitor();
  monitor.startLagMonitor(5);

  const fileSizes = [
    { name: '10MB', sizeBytes: 10 * 1024 * 1024 },
    { name: '50MB', sizeBytes: 50 * 1024 * 1024 },
    { name: '100MB (Max)', sizeBytes: 100 * 1024 * 1024 }
  ];

  try {
    for (const spec of fileSizes) {
      console.log(`\n--- Testing ${spec.name} file upload ---`);
      
      const gc = global.gc;
      if (gc) {
        console.log('Running garbage collector to clean memory before allocation...');
        gc();
      }

      const startMem = process.memoryUsage().rss / (1024 * 1024);
      console.log(`Starting memory: ${startMem.toFixed(2)} MB`);

      console.log(`Allocating random buffer of ${spec.name} (${spec.sizeBytes} bytes)...`);
      const buffer = generateRandomBuffer(spec.sizeBytes);
      
      const localHash = crypto.createHash('sha256').update(buffer).digest('hex');
      console.log(`Local SHA-256 Calculated: ${localHash}`);

      const boundary = `----LargeFileBoundary${crypto.randomUUID()}`;
      const filename = `large-file-${spec.name.replace(/[^a-zA-Z0-9]/g, '')}-${crypto.randomUUID()}.bin`;
      const title = `Large File ${spec.name}`;

      const multipartBody = buildMultipartBody(
        filename,
        'application/octet-stream',
        buffer,
        { source: 'large-file-stress', title },
        boundary
      );

      console.log('Dispatching request to /inbox...');
      const startTime = performance.now();
      
      const res = await fetch(`${BASE_URL}/inbox`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body: multipartBody
      });

      const endTime = performance.now();
      const elapsedMs = endTime - startTime;
      
      assert.strictEqual(res.status, 201, `Upload failed with status ${res.status}`);
      const data = await res.json() as any;

      console.log(`Upload completed in ${(elapsedMs / 1000).toFixed(2)}s (${(spec.sizeBytes / (1024 * 1024) / (elapsedMs / 1000)).toFixed(2)} MB/s)`);
      console.log(`Response Asset ID: ${data.id}`);
      console.log(`Response Checksum: ${data.checksum}`);

      // Verify DB asset record matches
      const asset = await prisma.asset.findUnique({ where: { id: data.id } });
      assert.ok(asset, 'Asset record should exist in the database');
      assert.strictEqual(asset.checksum, localHash, 'Database checksum should match locally calculated hash');
      assert.strictEqual(asset.fileSize, spec.sizeBytes, 'Database file size should match expected size');

      // Verify physical file size matches on disk
      const filePath = storageService.getFilePath(asset.fileKey);
      assert.ok(fs.existsSync(filePath), 'Physical file should exist on disk');
      const diskSize = fs.statSync(filePath).size;
      assert.strictEqual(diskSize, spec.sizeBytes, 'Physical file size should match expected size');

      // Verify file contents match (no corruption)
      console.log('Verifying integrity of file saved on disk (calculating hash)...');
      const diskStream = fs.createReadStream(filePath);
      const diskHash = await new Promise<string>((resolve, reject) => {
        const hashStream = crypto.createHash('sha256');
        diskStream.pipe(hashStream);
        hashStream.on('finish', () => resolve(hashStream.digest('hex')));
        hashStream.on('error', reject);
      });
      assert.strictEqual(diskHash, localHash, 'Saved disk file hash does not match original hash (corruption detected!)');
      console.log('✅ File integrity verified on disk.');

      const endStats = monitor.getStats();
      console.log(`End RSS Memory: ${endStats.rss.toFixed(2)} MB`);
      console.log(`CPU User: ${endStats.cpuUser.toFixed(2)}%, System: ${endStats.cpuSystem.toFixed(2)}%`);
    }

    console.log('\n✅ PASS: Part 5 Large File Stress test completed successfully.');
  } finally {
    const lagStats = monitor.stopLagMonitor();
    console.log(`\nEvent Loop Monitoring:`);
    console.log(`- Max Event Loop Lag: ${lagStats.maxLagMs.toFixed(2)} ms`);
    console.log(`- Avg Event Loop Lag: ${lagStats.avgLagMs.toFixed(2)} ms`);

    await app.close();
    await prisma.$disconnect();
    console.log('\n👋 Large File Stress server shut down cleanly.');
  }
}

main().catch(err => {
  console.error('❌ Part 5 Stress Test crashed:', err);
  process.exit(1);
});
