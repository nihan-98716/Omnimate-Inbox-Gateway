import app from '../src/app';
import { prisma } from '../src/services/db';
import { storageService } from '../src/services/storage.service';
import { ExpiryService } from '../src/services/expiry.service';
import { AssetState, AssetType, PresetType } from '@prisma/client';
import { config } from '../src/config';
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import crypto from 'crypto';

// Helper to manually build a multipart body for Fastify uploads
function buildMultipartBody(
  filename: string,
  mimetype: string,
  fileContent: Buffer | string,
  fields: Record<string, string>,
  boundary: string
): Buffer {
  const parts: Buffer[] = [];
  
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${key}"\r\n\r\n`));
    parts.push(Buffer.from(`${value}\r\n`));
  }

  parts.push(Buffer.from(`--${boundary}\r\n`));
  parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`));
  parts.push(Buffer.from(`Content-Type: ${mimetype}\r\n\r\n`));
  parts.push(Buffer.from(fileContent));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return Buffer.concat(parts);
}

async function runEndToEndTests() {
  console.log('🧪 Starting Definitive Phase 6 E2E Integration Suite...\n');
  let passCount = 0;
  let failCount = 0;

  const testAssert = (name: string, condition: boolean, message: string) => {
    if (condition) {
      console.log(` ✅ PASS: [${name}] ${message}`);
      passCount++;
    } else {
      console.error(` ❌ FAIL: [${name}] Assertion failed!`);
      failCount++;
    }
  };

  const port = 3006;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  try {
    // 0. Setup: Clean DB and register mock endpoints
    await prisma.$connect();
    await prisma.asset.deleteMany({});
    await prisma.destinationPreset.deleteMany({});

    // Register webhook receiver for testing concurrent patches
    let webhookCallCount = 0;
    app.post('/test-webhook', async (req, reply) => {
      webhookCallCount++;
      await new Promise(resolve => setTimeout(resolve, 200)); // Latency overlap
      return reply.send({ success: true });
    });

    const address = await app.listen({ port, host: '127.0.0.1' });
    console.log(`📡 E2E Live Server listening at ${address}\n`);

    // -------------------------------------------------------------
    // Test Case 1: Ingestion API (Upload + Deduplication)
    // -------------------------------------------------------------
    console.log('--- Test Case 1: Ingestion & Checksum Deduplication ---');
    const uploadContent = 'omnimate-e2e-payload-data-999';
    const boundaryA = `----BoundaryE2EA${crypto.randomUUID()}`;
    const boundaryB = `----BoundaryE2EB${crypto.randomUUID()}`;

    const bodyA = buildMultipartBody('file.txt', 'text/plain', uploadContent, { source: 'scanbox', title: 'File A' }, boundaryA);
    const bodyB = buildMultipartBody('file.txt', 'text/plain', uploadContent, { source: 'shots', title: 'File B' }, boundaryB);

    // Concurrent upload
    const [res1, res2] = await Promise.all([
      fetch(`${baseUrl}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundaryA}` },
        body: bodyA
      }),
      fetch(`${baseUrl}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundaryB}` },
        body: bodyB
      })
    ]);

    const asset1 = await res1.json() as any;
    const asset2 = await res2.json() as any;

    testAssert(
      'Ingestion Concurrency Codes',
      (res1.status === 201 && res2.status === 200) || (res1.status === 200 && res2.status === 201),
      'One request returns 201 (Created) and the other returns 200 (Deduplicated OK).'
    );

    testAssert(
      'Checksum Deduplication ID Merge',
      asset1.id === asset2.id,
      'Both requests resolve to the exact same Asset ID.'
    );

    const physicalPath = storageService.getFilePath(asset1.fileKey);
    testAssert(
      'Checksum Deduplication File Promotion',
      fs.existsSync(physicalPath),
      'Only one promoted physical file is saved on disk.'
    );

    // -------------------------------------------------------------
    // Test Case 2: Transaction Failures & File Rollback
    // -------------------------------------------------------------
    console.log('\n--- Test Case 2: Ingestion DB Fail-Safe Cleanup ---');
    const crashContent = 'crash-payload-e2e';
    const boundaryCrash = `----BoundaryCrash${crypto.randomUUID()}`;
    const bodyCrash = buildMultipartBody('crash.txt', 'text/plain', crashContent, { source: 'scanbox', title: 'Crash File' }, boundaryCrash);

    const originalCreate = prisma.asset.create;
    prisma.asset.create = async () => {
      throw new Error('Simulated database failure during insert');
    };

    const crashRes = await fetch(`${baseUrl}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundaryCrash}` },
      body: bodyCrash
    });

    prisma.asset.create = originalCreate; // Restore

    testAssert('Crash Status 500', crashRes.status === 500, 'Gateway returns 500 when database insert crashes.');

    const tempDir = path.join(config.UPLOAD_DIR, 'tmp');
    const tempFiles = fs.readdirSync(tempDir);
    testAssert(
      'Temp Staging Cleanup',
      tempFiles.filter(f => f.startsWith('tmp-')).length === 0,
      'No staged files are leaked in the temp folder on failure.'
    );

    const crashHash = crypto.createHash('sha256').update(crashContent).digest('hex');
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const crashPermanentKey = `assets/${year}/${month}/${day}/${crashHash}-crash.txt`;
    const crashPermanentPath = storageService.getFilePath(crashPermanentKey);

    testAssert(
      'Permanent Storage Cleanup',
      !fs.existsSync(crashPermanentPath),
      'No orphaned files are left in permanent storage if DB insert fails.'
    );

    // -------------------------------------------------------------
    // Test Case 3: State Transitions validation
    // -------------------------------------------------------------
    console.log('\n--- Test Case 3: State Transition Validations ---');
    const testAssetId = asset1.id;

    // PROCESS_NOW -> SAVE_FOR_LATER
    let stateRes = await fetch(`${baseUrl}/inbox/${testAssetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.SAVE_FOR_LATER })
    });
    let stateBody = await stateRes.json() as any;
    testAssert('Transition P_NOW -> SAVE_LATER', stateRes.status === 200 && stateBody.state === AssetState.SAVE_FOR_LATER, 'Allowed transition succeeded.');

    // Invalid: SAVE_FOR_LATER -> DELETED -> SAVE_FOR_LATER (Blocked)
    await fetch(`${baseUrl}/inbox/${testAssetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.DELETED })
    });

    stateRes = await fetch(`${baseUrl}/inbox/${testAssetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.SAVE_FOR_LATER })
    });
    testAssert('Transition DELETED -> SAVE_LATER Rejected', stateRes.status === 400, 'Invalid transition correctly blocked with 400.');

    // Restore to PROCESS_NOW
    await fetch(`${baseUrl}/inbox/${testAssetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.PROCESS_NOW })
    });

    // -------------------------------------------------------------
    // Test Case 4: Row Locking Concurrency Protection
    // -------------------------------------------------------------
    console.log('\n--- Test Case 4: Transition Concurrency Locks ---');
    const lockPreset = await prisma.destinationPreset.create({
      data: {
        name: 'Lock Webhook Target',
        type: PresetType.WEBHOOK,
        config: { url: `http://127.0.0.1:${port}/test-webhook` }
      }
    });

    webhookCallCount = 0;

    const patchRequests = Array.from({ length: 3 }).map(() =>
      fetch(`${baseUrl}/inbox/${testAssetId}/state`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: AssetState.ARCHIVE,
          presetId: lockPreset.id,
          executePreset: true
        })
      })
    );

    const responses = await Promise.all(patchRequests);
    const statuses = responses.map(r => r.status);

    const successCount = statuses.filter(s => s === 200).length;
    const errorCount = statuses.filter(s => s === 400).length;

    testAssert(
      'Transition Concurrency Statuses',
      successCount === 1 && errorCount === 2,
      'Exactly one concurrent patch request succeeded (200), others rejected (400).'
    );

    testAssert(
      'Duplicate Webhook Dispatch Check',
      webhookCallCount === 1,
      'Preset Webhook is executed exactly once.'
    );

    // -------------------------------------------------------------
    // Test Case 5: Destination Preset Compatibility & Execution
    // -------------------------------------------------------------
    console.log('\n--- Test Case 5: Preset Compatibility & Execution ---');
    const legacyFolder = path.join(config.UPLOAD_DIR, 'dest-legacy-e2e');
    if (fs.existsSync(legacyFolder)) {
      fs.rmSync(legacyFolder, { recursive: true, force: true });
    }

    const legacyPreset = await prisma.destinationPreset.create({
      data: {
        name: 'Legacy Preset Config',
        type: PresetType.LOCAL_FOLDER,
        schemaVersion: 1,
        config: { legacy_folder_path: legacyFolder } // schema v1 parameter
      }
    });

    // Restore testAsset to PROCESS_NOW
    await fetch(`${baseUrl}/inbox/${testAssetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.PROCESS_NOW })
    });

    const compatRes = await fetch(`${baseUrl}/inbox/${testAssetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: AssetState.ARCHIVE,
        presetId: legacyPreset.id,
        executePreset: true
      })
    });

    const compatBody = await compatRes.json() as any;
    testAssert('Compat Execution Status', compatRes.status === 200 && compatBody.state === AssetState.ARCHIVE, 'Legacy config normalized and file copy executed.');

    const expectedCopiedFile = path.join(legacyFolder, path.basename(asset1.fileKey));
    testAssert('Legacy File Copy Verified', fs.existsSync(expectedCopiedFile), 'Physical file successfully copied to destination.');

    // Cleanup
    if (fs.existsSync(legacyFolder)) {
      fs.rmSync(legacyFolder, { recursive: true, force: true });
    }

    // -------------------------------------------------------------
    // Test Case 6: Soft-Delete Expiry Purge
    // -------------------------------------------------------------
    console.log('\n--- Test Case 6: Soft-Delete Purging Sync ---');
    // Clear Asset table for controlled verification
    await prisma.asset.deleteMany({});

    const expiredKey = 'assets/expired-e2e.txt';
    const expiredPath = storageService.getFilePath(expiredKey);
    fs.mkdirSync(path.dirname(expiredPath), { recursive: true });
    fs.writeFileSync(expiredPath, 'expired e2e data');

    const thirtyOneDaysAgo = new Date();
    thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31);

    const expiredAsset = await prisma.asset.create({
      data: {
        title: 'Expired E2E File',
        type: AssetType.TEXT,
        source: 'e2e',
        state: AssetState.DELETED,
        fileKey: expiredKey,
        fileSize: 16,
        mimeType: 'text/plain',
        checksum: 'checksum-expired-e2e',
        deletedAt: thirtyOneDaysAgo
      }
    });

    // Purging
    const expiryService = new ExpiryService(prisma);
    await expiryService.runCleanup();

    const dbCheck = await prisma.asset.findUnique({ where: { id: expiredAsset.id } });
    const fileCheck = fs.existsSync(expiredPath);
    testAssert(
      'Purged Expired Lifecycle',
      dbCheck === null && fileCheck === false,
      'Expired soft-deleted records and physical disk files are purged in synchronization.'
    );

    // -------------------------------------------------------------
    // Test Case 7: Cursor Pagination
    // -------------------------------------------------------------
    console.log('\n--- Test Case 7: Cursor Pagination walking ---');
    const baseTime = Date.now();
    for (let i = 1; i <= 5; i++) {
      await prisma.asset.create({
        data: {
          title: `Asset ${i}`,
          type: AssetType.TEXT,
          source: 'pagination-e2e',
          state: AssetState.PROCESS_NOW,
          fileKey: `assets/pagination-${i}.txt`,
          fileSize: 10,
          mimeType: 'text/plain',
          checksum: `checksum-pag-${i}`,
          createdAt: new Date(baseTime + i * 1000)
        }
      });
    }

    // Page 1 (limit 2)
    let pagRes = await fetch(`${baseUrl}/inbox?limit=2`);
    let pagBody = await pagRes.json() as any;
    testAssert('Page 1 Size', pagBody.data.length === 2 && pagBody.pagination.hasNextPage === true, 'Page 1 has 2 items.');
    testAssert('Page 1 Order', pagBody.data[0].title === 'Asset 5' && pagBody.data[1].title === 'Asset 4', 'Order matches descending createdAt.');

    // Page 2
    const cursor = pagBody.pagination.nextCursor;
    pagRes = await fetch(`${baseUrl}/inbox?limit=2&cursor=${cursor}`);
    pagBody = await pagRes.json() as any;
    testAssert('Page 2 Size', pagBody.data.length === 2 && pagBody.pagination.hasNextPage === true, 'Page 2 has 2 items.');
    testAssert('Page 2 Order', pagBody.data[0].title === 'Asset 3' && pagBody.data[1].title === 'Asset 2', 'Order matches descending createdAt.');

    // Page 3
    const cursor2 = pagBody.pagination.nextCursor;
    pagRes = await fetch(`${baseUrl}/inbox?limit=2&cursor=${cursor2}`);
    pagBody = await pagRes.json() as any;
    testAssert('Page 3 Size', pagBody.data.length === 1 && pagBody.pagination.hasNextPage === false, 'Page 3 has 1 item.');
    testAssert('Page 3 Order', pagBody.data[0].title === 'Asset 1', 'Order matches descending createdAt.');

  } catch (err) {
    console.error('❌ E2E Integration Suite crashed:', err);
    failCount++;
  } finally {
    // Teardown
    await prisma.asset.deleteMany({});
    await prisma.destinationPreset.deleteMany({});
    await app.close();
    await prisma.$disconnect();
    console.log('\n👋 Server closed cleanly.');

    console.log(`\n==============================================`);
    console.log(`📊 E2E INTEGRATION SUITE SUMMARY`);
    console.log(`==============================================`);
    console.log(`Passed Checks: ${passCount}`);
    console.log(`Failed Checks: ${failCount}`);
    console.log(`==============================================\n`);

    if (failCount > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
}

runEndToEndTests();
