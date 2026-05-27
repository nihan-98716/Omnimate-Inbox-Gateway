import app from '../../src/app';
import { prisma } from '../../src/services/db';
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
import { ResourceMonitor, buildMultipartBody, generateRandomBuffer, runConcurrentRequests, RequestResult } from './test-utils';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import assert from 'assert';

const PORT = 3007;
const BASE_URL = `http://127.0.0.1:${PORT}/api/v1`;

async function main() {
  console.log('🏁 Starting Part 2: Ingestion & Deduplication Race Stress Tests...\n');

  // Establish DB connection and clean tables
  await prisma.$connect();
  await prisma.asset.deleteMany({});
  await prisma.destinationPreset.deleteMany({});

  // Clean uploads directory
  const uploadsDir = path.resolve('./uploads');
  if (fs.existsSync(uploadsDir)) {
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(uploadsDir, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(uploadsDir, 'assets'), { recursive: true });

  // Start Fastify server
  const address = await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`📡 Ingestion Stress server online at ${address}`);

  const monitor = new ResourceMonitor();
  monitor.startLagMonitor(10);
  const startStats = monitor.getStats();

  try {
    // =========================================================================
    // 1. Massive Upload Stress Test
    // =========================================================================
    console.log('\n--- 1. Running Massive Ingestion Stress Test ---');
    console.log('Generating file payloads of mixed types and sizes...');

    // We will generate 1000 requests.
    // 70% unique, 30% duplicate.
    // Mixed types: PDF, IMAGE, SCREENSHOT, TEXT, OTHER.
    // Mixed sizes: 1MB (800 files), 10MB (150 files), 50MB (40 files), 100MB (10 files).
    // To prevent disk space and CPU exhaustion, we pre-create the unique and duplicate data pools.
    const uniquePoolCount = 700;
    const duplicatePoolCount = 300;
    const totalUploads = 1000;
    const concurrency = 20; // 20 concurrent connections to prevent socket exhaustion

    // Size distribution mapping
    const sizes = {
      small: 1 * 1024 * 1024,      // 1MB
      medium: 10 * 1024 * 1024,    // 10MB
      large: 50 * 1024 * 1024,     // 50MB
      huge: 100 * 1024 * 1024      // 100MB
    };

    // Pre-create some large static buffers to avoid crypto thrashing
    const buffer1MB = generateRandomBuffer(sizes.small);
    const buffer10MB = generateRandomBuffer(sizes.medium);
    const buffer50MB = generateRandomBuffer(sizes.large);
    const buffer100MB = generateRandomBuffer(sizes.huge);

    console.log(`✅ File buffers generated in memory. Ready to dispatch ${totalUploads} uploads...`);

    // Helper to get size based on request index (scaled for 700 unique files)
    function getSizeAndBufferForIndex(index: number): { sizeName: string, buffer: Buffer } {
      if (index < 500) return { sizeName: '1MB', buffer: buffer1MB };
      if (index < 650) return { sizeName: '10MB', buffer: buffer10MB };
      if (index < 690) return { sizeName: '50MB', buffer: buffer50MB };
      return { sizeName: '100MB', buffer: buffer100MB };
    }

    // Pre-generate a list of duplicate index mappings
    const duplicateTargets = Array.from({ length: duplicatePoolCount }).map(() => Math.floor(Math.random() * uniquePoolCount));

    // To make sure duplicates are identical, we will assign them the same payload buffer and a slight alteration
    // (e.g. index-based unique signature for unique files, and shared signature for duplicates).
    const uniqueSignatures = Array.from({ length: uniquePoolCount }).map((_, i) => `unique-sig-${i}-${crypto.randomUUID()}`);

    // Define upload tasks so that duplicates and uniques have identical sizes and content
    interface UploadTask {
      index: number;
      uniqueIdx: number;
      sizeName: string;
      buffer: Buffer;
    }

    const tasks: UploadTask[] = [];
    for (let index = 0; index < totalUploads; index++) {
      const isDuplicate = index >= uniquePoolCount;
      const uniqueIdx = isDuplicate ? duplicateTargets[index - uniquePoolCount] : index;
      const { sizeName, buffer } = getSizeAndBufferForIndex(uniqueIdx);
      tasks.push({ index, uniqueIdx, sizeName, buffer });
    }

    // Group tasks by size class to run them with memory-safe concurrency limits
    const tasksByGroup: Record<string, { list: UploadTask[], concurrency: number }> = {
      '1MB': { list: [], concurrency: 10 },
      '10MB': { list: [], concurrency: 3 },
      '50MB': { list: [], concurrency: 1 },
      '100MB': { list: [], concurrency: 1 }
    };

    for (const task of tasks) {
      tasksByGroup[task.sizeName].list.push(task);
    }

    const uploadResults: RequestResult[] = [];

    // Execute uploads by size group sequentially to keep memory usage low
    for (const [groupName, group] of Object.entries(tasksByGroup)) {
      if (group.list.length === 0) continue;
      console.log(`🚀 Dispatching ${group.list.length} uploads of size ${groupName} (Concurrency: ${group.concurrency})...`);

      const groupResults = await runConcurrentRequests(group.list.length, group.concurrency, async (i) => {
        const task = group.list[i];
        const index = task.index;
        const uniqueIdx = task.uniqueIdx;
        const buffer = task.buffer;
        const sizeName = task.sizeName;

        const boundary = `----UploadBoundary${crypto.randomUUID()}`;
        const source = index % 2 === 0 ? 'scanbox' : 'shots';
        const fileSignature = uniqueSignatures[uniqueIdx];

        const payloadBuffer = Buffer.alloc(buffer.length);
        buffer.copy(payloadBuffer);
        payloadBuffer.write(fileSignature, 0, 'utf8');

        const mimeType = index % 4 === 0 ? 'application/pdf' : index % 4 === 1 ? 'image/jpeg' : index % 4 === 2 ? 'text/plain' : 'application/octet-stream';
        const ext = index % 4 === 0 ? 'pdf' : index % 4 === 1 ? 'jpg' : index % 4 === 2 ? 'txt' : 'dat';
        const filename = `stress-${index}.${ext}`;
        const title = `Stress Asset ${index} (${sizeName})`;

        const multipartBody = buildMultipartBody(
          filename,
          mimeType,
          payloadBuffer,
          { source, title },
          boundary
        );

        const res = await fetch(`${BASE_URL}/inbox`, {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Connection': 'keep-alive'
          },
          body: multipartBody
        });

        const data = await res.json() as any;
        return { statusCode: res.status, data };
      });

      uploadResults.push(...groupResults);
    }

    // Verify massive upload results
    const uploadStats = monitor.getStats();
    const successfulUploads = uploadResults.filter(r => r.success);
    const successRate = (successfulUploads.length / totalUploads) * 100;
    console.log(`\nMassive Upload Performance:`);
    console.log(`- Success Rate: ${successRate.toFixed(2)}% (${successfulUploads.length}/${totalUploads})`);
    console.log(`- Peak RSS Memory: ${uploadStats.rss.toFixed(2)} MB`);
    console.log(`- CPU User: ${uploadStats.cpuUser.toFixed(2)}%, System: ${uploadStats.cpuSystem.toFixed(2)}%`);

    assert.ok(successRate >= 99.9, `Success rate must be >= 99.9% (Got ${successRate.toFixed(2)}%)`);

    // Verify DB Integrity
    const dbAssetCount = await prisma.asset.count();
    console.log(`- Unique assets in DB: ${dbAssetCount}`);
    assert.strictEqual(dbAssetCount, uniquePoolCount, `Unique assets in DB should match unique pool count (${uniquePoolCount}) but got ${dbAssetCount}`);

    // Verify Storage Integrity
    const permanentFiles = fs.readdirSync(path.join(uploadsDir, 'assets'), { recursive: true })
      .filter((f): f is string => typeof f === 'string' && fs.statSync(path.join(uploadsDir, 'assets', f)).isFile());
    console.log(`- Promoted permanent files on disk: ${permanentFiles.length}`);
    assert.strictEqual(permanentFiles.length, uniquePoolCount, `Physical permanent files should match unique pool count (${uniquePoolCount})`);

    // Check for orphaned temp files
    const tempDir = path.join(uploadsDir, 'tmp');
    const tempFiles = fs.existsSync(tempDir) ? fs.readdirSync(tempDir) : [];
    console.log(`- Orphaned temp files remaining: ${tempFiles.length}`);
    assert.strictEqual(tempFiles.length, 0, 'No temporary staged file leaks should exist');

    // =========================================================================
    // 2. Deduplication Race Stress Test
    // =========================================================================
    console.log('\n--- 2. Running Deduplication Race Stress Test ---');
    console.log('Preparing 500 parallel pairs (1000 total requests) uploading identical files simultaneously...');

    const racePairs = 500;
    const raceRequests = racePairs * 2;
    const raceBuffer = generateRandomBuffer(2 * 1024 * 1024); // 2MB identical file
    const raceBoundary1 = `----RaceBoundaryA${crypto.randomUUID()}`;
    const raceBoundary2 = `----RaceBoundaryB${crypto.randomUUID()}`;

    // Pre-build bodies to save CPU overhead during the actual concurrent storm
    const bodyScanbox = buildMultipartBody('race-file.jpg', 'image/jpeg', raceBuffer, { source: 'scanbox', title: 'Scanbox Upload' }, raceBoundary1);
    const bodyShots = buildMultipartBody('race-file.jpg', 'image/jpeg', raceBuffer, { source: 'shots', title: 'Shots Upload' }, raceBoundary2);

    let raceSuccessCount = 0;
    const resultsScanbox: any[] = [];
    const resultsShots: any[] = [];

    // Firing in parallel batches
    const batchSize = 50; // 50 simultaneous pairs (100 total requests at once)
    const startRaceTime = performance.now();

    for (let i = 0; i < racePairs; i += batchSize) {
      const currentBatchSize = Math.min(batchSize, racePairs - i);
      const promises: Promise<any>[] = [];

      for (let j = 0; j < currentBatchSize; j++) {
        // Post from Scanbox
        promises.push(
          fetch(`${BASE_URL}/inbox`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${raceBoundary1}` },
            body: bodyScanbox
          }).then(async (res) => {
            const data = await res.json() as any;
            resultsScanbox.push({ status: res.status, data });
          }).catch(err => {
            resultsScanbox.push({ status: 500, error: err.message });
          })
        );

        // Post from Shots (Identical content)
        promises.push(
          fetch(`${BASE_URL}/inbox`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${raceBoundary2}` },
            body: bodyShots
          }).then(async (res) => {
            const data = await res.json() as any;
            resultsShots.push({ status: res.status, data });
          }).catch(err => {
            resultsShots.push({ status: 500, error: err.message });
          })
        );
      }

      await Promise.all(promises);
    }

    const endRaceTime = performance.now();
    const raceLatency = endRaceTime - startRaceTime;

    // Evaluate race test assertions
    const allResults = [...resultsScanbox, ...resultsShots];
    const successes = allResults.filter(r => r.status === 200 || r.status === 201);
    const status201 = allResults.filter(r => r.status === 201);
    const status200 = allResults.filter(r => r.status === 200);

    console.log(`Race Results:`);
    console.log(`- Total Requests sent: ${raceRequests}`);
    console.log(`- Success Rate: ${((successes.length / raceRequests) * 100).toFixed(2)}%`);
    console.log(`- 201 Created (Initial): ${status201.length}`);
    console.log(`- 200 OK (Deduplicated): ${status200.length}`);
    console.log(`- Elapsed time: ${(raceLatency / 1000).toFixed(2)}s (${(raceRequests / (raceLatency / 1000)).toFixed(2)} req/sec)`);

    assert.strictEqual(successes.length, raceRequests, 'All requests in deduplication race should succeed with either 200 or 201');
    assert.strictEqual(status201.length, 1, 'Only exactly one request should result in a 201 (Created) state');
    assert.strictEqual(status200.length, raceRequests - 1, 'All subsequent concurrent uploads must hit the 200 OK deduplication pathway');

    // Confirm that only one physical asset is saved
    const newAsset = status201[0].data;
    const racePhysicalFile = storageService.getFilePath(newAsset.fileKey);
    console.log(`- Target Deduplicated Physical File: ${newAsset.fileKey}`);
    assert.ok(fs.existsSync(racePhysicalFile), 'Deduplicated permanent file should exist on disk');

    // Check DB rows for this checksum
    const dbAssetsForChecksum = await prisma.asset.findMany({
      where: { checksum: newAsset.checksum }
    });
    console.log(`- Database records for deduplicated checksum: ${dbAssetsForChecksum.length}`);
    assert.strictEqual(dbAssetsForChecksum.length, 1, 'Only one row should exist in the database for the deduplicated checksum');

    console.log('\n✅ PASS: Part 2 Ingestion & Deduplication Stress tests completed successfully.');
  } finally {
    // Teardown
    const lagStats = monitor.stopLagMonitor();
    console.log(`\nEvent Loop Monitoring:`);
    console.log(`- Max Event Loop Lag: ${lagStats.maxLagMs.toFixed(2)} ms`);
    console.log(`- Avg Event Loop Lag: ${lagStats.avgLagMs.toFixed(2)} ms`);

    await app.close();
    await prisma.$disconnect();
    console.log('\n👋 Ingestion Stress server shut down cleanly.');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Part 2 Stress Test crashed:', err);
    process.exit(1);
  });
}
