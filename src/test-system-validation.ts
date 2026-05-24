import app from './app';
import { prisma } from './services/db';
import { storageService } from './services/storage.service';
import { ExpiryService } from './services/expiry.service';
import { AssetState, AssetType, PresetType } from '@prisma/client';
import { config } from './config';
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import crypto from 'crypto';

// Helper to manually build a multipart body
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

async function runSystemValidation() {
  console.log('🏁 Starting Complete Phase 5 System Validation & Regression Test...\n');
  const results = {
    passed: [] as string[],
    failed: [] as string[],
    edgeCases: [] as string[]
  };

  const testAssert = (name: string, condition: boolean, successMsg: string, failMsg: string) => {
    if (condition) {
      console.log(` ✅ PASS: [${name}] ${successMsg}`);
      results.passed.push(name);
    } else {
      console.error(` ❌ FAIL: [${name}] ${failMsg}`);
      results.failed.push(name);
    }
  };

  const port = 3005;
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  try {
    // 0. Reset Database State
    await prisma.$connect();
    await prisma.asset.deleteMany({});
    await prisma.destinationPreset.deleteMany({});

    // Register test webhook handler for concurrency check
    let webhookCallCount = 0;
    app.post('/test-webhook', async (req, reply) => {
      webhookCallCount++;
      // artificial delay to ensure concurrency overlap if locking wasn't working
      await new Promise(resolve => setTimeout(resolve, 200));
      return reply.send({ success: true });
    });

    // Start server
    const address = await app.listen({ port, host: '127.0.0.1' });
    console.log(`📡 Validation server listening at ${address}\n`);

    // -------------------------------------------------------------
    // Test Case 1: Simultaneous Ingestion & Checksum Deduplication
    // -------------------------------------------------------------
    console.log('--- Test 1: Concurrent Uploads & Checksum Deduplication ---');
    const fileContent = `unique-concurrent-payload-${crypto.randomUUID()}`;
    const boundary1 = `----Boundary1${crypto.randomUUID()}`;
    const boundary2 = `----Boundary2${crypto.randomUUID()}`;

    const body1 = buildMultipartBody(
      'concurrent-upload.txt',
      'text/plain',
      fileContent,
      { source: 'scanbox', title: 'Upload from Scanbox' },
      boundary1
    );

    const body2 = buildMultipartBody(
      'concurrent-upload.txt',
      'text/plain',
      fileContent,
      { source: 'shots', title: 'Upload from Shots' },
      boundary2
    );

    // Fire concurrently
    const [res1, res2] = await Promise.all([
      fetch(`${baseUrl}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary1}` },
        body: body1
      }),
      fetch(`${baseUrl}/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary2}` },
        body: body2
      })
    ]);

    const asset1 = await res1.json() as any;
    const asset2 = await res2.json() as any;

    testAssert(
      'Upload Deduplication Status Codes',
      (res1.status === 201 && res2.status === 200) || (res1.status === 200 && res2.status === 201),
      'One request returned 201 (created) and the other returned 200 (duplicate loaded).',
      `Unexpected statuses: ${res1.status} and ${res2.status}`
    );

    testAssert(
      'Upload Deduplication Same ID',
      asset1.id === asset2.id,
      'Both concurrent uploads returned the same database Asset ID.',
      `Asset IDs differed: ${asset1.id} vs ${asset2.id}`
    );

    // Verify physical file counts on disk
    const permanentPath = storageService.getFilePath(asset1.fileKey);
    testAssert(
      'Upload Deduplication Disk Key',
      fs.existsSync(permanentPath),
      'Single physical file saved in permanent storage directory.',
      `File not found at path: ${permanentPath}`
    );

    // -------------------------------------------------------------
    // Test Case 2: Valid and Invalid State Transitions
    // -------------------------------------------------------------
    console.log('\n--- Test 2: Valid and Invalid State Transitions ---');
    const assetId = asset1.id;

    // PROCESS_NOW -> SAVE_FOR_LATER (Valid)
    let patchRes = await fetch(`${baseUrl}/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.SAVE_FOR_LATER })
    });
    let patchBody = await patchRes.json() as any;
    testAssert('Transition: PROCESS_NOW -> SAVE_FOR_LATER', patchRes.status === 200 && patchBody.state === AssetState.SAVE_FOR_LATER, 'Transition allowed.', 'Transition rejected.');

    // SAVE_FOR_LATER -> PROCESS_NOW (Valid)
    patchRes = await fetch(`${baseUrl}/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.PROCESS_NOW })
    });
    patchBody = await patchRes.json() as any;
    testAssert('Transition: SAVE_FOR_LATER -> PROCESS_NOW', patchRes.status === 200 && patchBody.state === AssetState.PROCESS_NOW, 'Transition allowed.', 'Transition rejected.');

    // PROCESS_NOW -> ARCHIVE (Valid)
    patchRes = await fetch(`${baseUrl}/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.ARCHIVE })
    });
    patchBody = await patchRes.json() as any;
    testAssert('Transition: PROCESS_NOW -> ARCHIVE', patchRes.status === 200 && patchBody.state === AssetState.ARCHIVE, 'Transition allowed.', 'Transition rejected.');

    // ARCHIVE -> DELETED (Valid)
    patchRes = await fetch(`${baseUrl}/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.DELETED })
    });
    patchBody = await patchRes.json() as any;
    testAssert(
      'Transition: ARCHIVE -> DELETED',
      patchRes.status === 200 && patchBody.state === AssetState.DELETED && patchBody.deletedAt !== null,
      'Transition allowed and deletedAt timestamp populated.',
      'Transition failed or deletedAt was null.'
    );

    // DELETED -> PROCESS_NOW (Valid Restore)
    patchRes = await fetch(`${baseUrl}/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.PROCESS_NOW })
    });
    patchBody = await patchRes.json() as any;
    testAssert(
      'Transition: DELETED -> PROCESS_NOW',
      patchRes.status === 200 && patchBody.state === AssetState.PROCESS_NOW && patchBody.deletedAt === null,
      'Transition allowed and deletedAt reset to null.',
      'Transition failed or deletedAt was not reset.'
    );

    // Invalid Transition: DELETED (soft delete again) -> ARCHIVE (Blocked)
    await fetch(`${baseUrl}/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.DELETED })
    });

    patchRes = await fetch(`${baseUrl}/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.ARCHIVE })
    });
    testAssert('Invalid Transition: DELETED -> ARCHIVE', patchRes.status === 400, 'Correctly blocked (400 Bad Request).', `Unexpected status: ${patchRes.status}`);

    // Restore to PROCESS_NOW, then archive
    await fetch(`${baseUrl}/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.PROCESS_NOW })
    });
    await fetch(`${baseUrl}/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.ARCHIVE })
    });

    // Invalid Transition: ARCHIVE -> SAVE_FOR_LATER (Blocked)
    patchRes = await fetch(`${baseUrl}/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.SAVE_FOR_LATER })
    });
    testAssert('Invalid Transition: ARCHIVE -> SAVE_FOR_LATER', patchRes.status === 400, 'Correctly blocked (400 Bad Request).', `Unexpected status: ${patchRes.status}`);

    // Invalid Transition: DELETED -> SAVE_FOR_LATER (Blocked)
    await fetch(`${baseUrl}/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.DELETED })
    });
    patchRes = await fetch(`${baseUrl}/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.SAVE_FOR_LATER })
    });
    testAssert('Invalid Transition: DELETED -> SAVE_FOR_LATER', patchRes.status === 400, 'Correctly blocked (400 Bad Request).', `Unexpected status: ${patchRes.status}`);

    // Restore to PROCESS_NOW for subsequent tests
    await fetch(`${baseUrl}/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.PROCESS_NOW })
    });

    // -------------------------------------------------------------
    // Test Case 3: DB Failures & Orphan Files Verification
    // -------------------------------------------------------------
    console.log('\n--- Test 3: DB Failures & Orphan Files Verification ---');
    const crashContent = 'crash-failure-simulation-content';
    const boundaryCrash = `----BoundaryCrash${crypto.randomUUID()}`;
    const bodyCrash = buildMultipartBody(
      'crash.txt',
      'text/plain',
      crashContent,
      { source: 'scanbox', title: 'Crashed Upload' },
      boundaryCrash
    );

    // Mock prisma.asset.create to simulate database write failure
    const originalCreate = prisma.asset.create;
    prisma.asset.create = async () => {
      throw new Error('Simulated database write failure');
    };

    console.log('🔧 Stubbed prisma.asset.create to simulate database insert crash.');

    const uploadRes = await fetch(`${baseUrl}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundaryCrash}` },
      body: bodyCrash
    });

    // Restore original create method immediately
    prisma.asset.create = originalCreate;

    testAssert('Ingestion DB failure status', uploadRes.status === 500, 'API returns 500 Internal Server Error when DB fails.', `Unexpected status: ${uploadRes.status}`);

    // Verify no orphan temp files remain in uploads/tmp
    const tmpDir = path.join(config.UPLOAD_DIR, 'tmp');
    const tmpFiles = fs.readdirSync(tmpDir);
    const crashTempFiles = tmpFiles.filter(f => f.startsWith('tmp-'));
    testAssert(
      'No Orphan Staged Temp Files',
      crashTempFiles.length === 0,
      'No staged files left in temp storage directory.',
      `Found remaining staged files: ${crashTempFiles.join(', ')}`
    );

    // Edge Case / Vulnerability check: Did a permanent file get created?
    // Since the database write failed, we don't have a record. We need to check if there is an orphan file in permanent storage.
    // The permanentKey was generated based on the checksum. Let's calculate the hash of the crashContent.
    const crashHash = crypto.createHash('sha256').update(crashContent).digest('hex');
    // The path schema: assets/YYYY/MM/DD/hash-filename
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const expectedPermanentKey = `assets/${year}/${month}/${day}/${crashHash}-crash.txt`;
    const expectedPermanentPath = storageService.getFilePath(expectedPermanentKey);

    const orphanPermanentExists = fs.existsSync(expectedPermanentPath);
    testAssert(
      'Permanent Storage Cleanup on DB Failure',
      !orphanPermanentExists,
      'Orphan permanent file was successfully cleaned up on DB failure.',
      `Orphan permanent file was leaked at ${expectedPermanentKey}`
    );

    // Clean up if it exists
    if (orphanPermanentExists) {
      fs.unlinkSync(expectedPermanentPath);
    }

    // -------------------------------------------------------------
    // Test Case 4: Webhook Preset Failure & Asset Recoverability
    // -------------------------------------------------------------
    console.log('\n--- Test 4: Webhook Failure & Asset Recoverability ---');
    const deadPreset = await prisma.destinationPreset.create({
      data: {
        name: 'Dead Webhook Link',
        type: PresetType.WEBHOOK,
        config: { url: 'http://127.0.0.1:9998/dead-inbound' }
      }
    });

    const webhookRes = await fetch(`${baseUrl}/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: AssetState.ARCHIVE,
        presetId: deadPreset.id,
        executePreset: true
      })
    });

    testAssert('Webhook Failure Status Code', webhookRes.status === 502, 'API returns 502 Bad Gateway.', `Unexpected status: ${webhookRes.status}`);

    const recoveredAsset = await prisma.asset.findUnique({
      where: { id: assetId }
    });

    testAssert(
      'Asset State Recoverability',
      recoveredAsset?.state === AssetState.PROCESS_NOW,
      'Asset state remains in PROCESS_NOW (recoverable in active inbox).',
      `Asset state moved to: ${recoveredAsset?.state}`
    );

    const execLogs = (recoveredAsset?.metadata as any)?.presetExecution;
    testAssert(
      'Failure Logs in Metadata',
      execLogs !== undefined && execLogs.success === false && execLogs.error.includes('fetch failed') || execLogs.error.includes('ECONNREFUSED'),
      'Preset failure logs populated with connection failure details.',
      `Incorrect metadata log: ${JSON.stringify(execLogs)}`
    );

    // -------------------------------------------------------------
    // Test Case 5: Expiry & Purge Sync
    // -------------------------------------------------------------
    console.log('\n--- Test 5: Soft-Delete Expiry & Purge Synchronization ---');
    // 1. Create a truly expired asset (31 days ago)
    const thirtyOneDaysAgo = new Date();
    thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31);

    const expiredKey = 'assets/expired-to-purge.txt';
    const expiredPath = storageService.getFilePath(expiredKey);
    fs.mkdirSync(path.dirname(expiredPath), { recursive: true });
    fs.writeFileSync(expiredPath, 'expired content');

    const expiredAsset = await prisma.asset.create({
      data: {
        title: 'Expired Asset',
        type: AssetType.TEXT,
        source: 'test',
        state: AssetState.DELETED,
        fileKey: expiredKey,
        fileSize: 15,
        mimeType: 'text/plain',
        checksum: 'expired-checksum-111',
        deletedAt: thirtyOneDaysAgo
      }
    });

    // 2. Create another expired asset, but point it to a directory path to cause an EISDIR unlinking error
    const dummyDirKey = 'assets/expired-dummy-dir';
    const dummyDirPath = storageService.getFilePath(dummyDirKey);
    if (!fs.existsSync(dummyDirPath)) {
      fs.mkdirSync(dummyDirPath, { recursive: true });
    }

    const lockedAsset = await prisma.asset.create({
      data: {
        title: 'Locked Directory Asset',
        type: AssetType.OTHER,
        source: 'test',
        state: AssetState.DELETED,
        fileKey: dummyDirKey,
        fileSize: 0,
        mimeType: 'application/octet-stream',
        checksum: 'locked-checksum-222',
        deletedAt: thirtyOneDaysAgo
      }
    });

    console.log('🧹 Running Expiry Service Cleanup...');
    const expiryService = new ExpiryService(prisma);
    await expiryService.runCleanup();

    // Check Expired Asset 1
    const dbCheck1 = await prisma.asset.findUnique({ where: { id: expiredAsset.id } });
    const fileCheck1 = fs.existsSync(expiredPath);
    testAssert(
      'Purged Expired Asset',
      dbCheck1 === null && !fileCheck1,
      'Expired asset row and disk file successfully purged.',
      `Asset row exists: ${dbCheck1 !== null}, Disk file exists: ${fileCheck1}`
    );

    // Check Expired Asset 2 (which had unlinking failure)
    const dbCheck2 = await prisma.asset.findUnique({ where: { id: lockedAsset.id } });
    testAssert(
      'Synchronization Safety on Disk Error',
      dbCheck2 !== null,
      'Database row is NOT deleted because file unlinking failed (sync safety preserved).',
      'Database row was deleted despite file unlinking failure!'
    );

    // Cleanup directory
    if (fs.existsSync(dummyDirPath)) {
      fs.rmdirSync(dummyDirPath);
    }

    // -------------------------------------------------------------
    // Test Case 6: Cursor Pagination Under Multiple Uploads
    // -------------------------------------------------------------
    console.log('\n--- Test 6: Cursor Pagination Walking ---');
    // Clear first to control exact records
    await prisma.asset.deleteMany({});
    
    // Create 5 mock assets with deliberate timestamps
    const now = Date.now();
    const mockIds = [] as string[];
    for (let i = 1; i <= 5; i++) {
      const a = await prisma.asset.create({
        data: {
          title: `Walk Asset ${i}`,
          type: AssetType.TEXT,
          source: 'pagination-test',
          state: AssetState.PROCESS_NOW,
          fileKey: `assets/walk-${i}.txt`,
          fileSize: 10,
          mimeType: 'text/plain',
          checksum: `checksum-walk-${i}`,
          createdAt: new Date(now + i * 1000) // Spaced 1s apart
        }
      });
      mockIds.push(a.id);
    }

    // Paginate through all 5 items using pages of size 2
    // Expected order (descending createdAt): Walk Asset 5, 4, 3, 2, 1
    
    // Page 1
    let pagRes = await fetch(`${baseUrl}/inbox?limit=2`);
    let pagBody = await pagRes.json() as any;
    testAssert('Page 1 Size', pagBody.data.length === 2, 'Page 1 size is 2.', `Page 1 size: ${pagBody.data.length}`);
    testAssert('Page 1 First Item', pagBody.data[0].title === 'Walk Asset 5', 'First is Walk Asset 5.', `Got: ${pagBody.data[0].title}`);
    testAssert('Page 1 Second Item', pagBody.data[1].title === 'Walk Asset 4', 'Second is Walk Asset 4.', `Got: ${pagBody.data[1].title}`);
    
    const cursorA = pagBody.pagination.nextCursor;
    testAssert('Page 1 Has Next Cursor', cursorA !== null && pagBody.pagination.hasNextPage === true, 'Next cursor present.', 'Next cursor missing.');

    // Page 2
    pagRes = await fetch(`${baseUrl}/inbox?limit=2&cursor=${cursorA}`);
    pagBody = await pagRes.json() as any;
    testAssert('Page 2 Size', pagBody.data.length === 2, 'Page 2 size is 2.', `Page 2 size: ${pagBody.data.length}`);
    testAssert('Page 2 First Item', pagBody.data[0].title === 'Walk Asset 3', 'First is Walk Asset 3.', `Got: ${pagBody.data[0].title}`);
    testAssert('Page 2 Second Item', pagBody.data[1].title === 'Walk Asset 2', 'Second is Walk Asset 2.', `Got: ${pagBody.data[1].title}`);

    const cursorB = pagBody.pagination.nextCursor;
    testAssert('Page 2 Has Next Cursor', cursorB !== null && pagBody.pagination.hasNextPage === true, 'Next cursor present.', 'Next cursor missing.');

    // Page 3
    pagRes = await fetch(`${baseUrl}/inbox?limit=2&cursor=${cursorB}`);
    pagBody = await pagRes.json() as any;
    testAssert('Page 3 Size', pagBody.data.length === 1, 'Page 3 size is 1.', `Page 3 size: ${pagBody.data.length}`);
    testAssert('Page 3 Item', pagBody.data[0].title === 'Walk Asset 1', 'Item is Walk Asset 1.', `Got: ${pagBody.data[0].title}`);
    testAssert('Page 3 End Pagination', pagBody.pagination.nextCursor === null && pagBody.pagination.hasNextPage === false, 'Pagination ended correctly.', 'Pagination did not end.');

    // -------------------------------------------------------------
    // Test Case 7: Preset Schema Version Compatibility
    // -------------------------------------------------------------
    console.log('\n--- Test 7: Preset Schema Version Compatibility ---');
    // Create a version 1 schema preset with legacy configurations
    const legacyFolder = path.join(config.UPLOAD_DIR, 'dest-legacy-test');
    if (fs.existsSync(legacyFolder)) {
      fs.rmSync(legacyFolder, { recursive: true, force: true });
    }

    const legacyPreset = await prisma.destinationPreset.create({
      data: {
        name: 'Legacy Local Path',
        type: PresetType.LOCAL_FOLDER,
        schemaVersion: 1,
        config: {
          legacy_folder_path: legacyFolder // Schema v1 layout
        }
      }
    });

    // Create an asset to archive using this legacy preset
    const compatAssetKey = 'assets/compat-asset.txt';
    const compatAssetPath = storageService.getFilePath(compatAssetKey);
    fs.mkdirSync(path.dirname(compatAssetPath), { recursive: true });
    fs.writeFileSync(compatAssetPath, 'compatibility payload content');

    const compatAsset = await prisma.asset.create({
      data: {
        title: 'Compatibility File',
        type: AssetType.TEXT,
        source: 'test',
        state: AssetState.PROCESS_NOW,
        fileKey: compatAssetKey,
        fileSize: 30,
        mimeType: 'text/plain',
        checksum: 'compat-checksum-555'
      }
    });

    // Transition to ARCHIVE and execute preset
    const compatRes = await fetch(`${baseUrl}/inbox/${compatAsset.id}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: AssetState.ARCHIVE,
        presetId: legacyPreset.id,
        executePreset: true
      })
    });

    const compatBody = await compatRes.json() as any;
    testAssert('Compatibility Request Code', compatRes.status === 200, 'API returns 200 OK.', `Unexpected status: ${compatRes.status}`);
    testAssert('Compatibility Asset State', compatBody.state === AssetState.ARCHIVE, 'Asset state advanced to ARCHIVE.', `Asset state: ${compatBody.state}`);

    // Verify the file was indeed copied to the legacy folder path
    const expectedCopiedFilePath = path.join(legacyFolder, path.basename(compatAssetKey));
    const isCopied = fs.existsSync(expectedCopiedFilePath);
    testAssert(
      'Compatibility Preset Execution File Copy',
      isCopied,
      'File successfully copied to normalized legacy_folder_path destination directory.',
      `Copied file not found at: ${expectedCopiedFilePath}`
    );

    // Cleanup legacy output
    if (fs.existsSync(legacyFolder)) {
      fs.rmSync(legacyFolder, { recursive: true, force: true });
    }

    // -------------------------------------------------------------
    // Test Case 8: Concurrency Protection on Webhook Dispatch (Row-Level Locking)
    // -------------------------------------------------------------
    console.log('\n--- Test 8: Concurrent State Transitions & Locking ---');
    
    // Create webhook preset pointing to our counted handler
    const concurrencyWebhookPreset = await prisma.destinationPreset.create({
      data: {
        name: 'Concurrency Webhook Preset',
        type: PresetType.WEBHOOK,
        config: { url: `http://127.0.0.1:${port}/test-webhook` }
      }
    });

    // Create a new asset to transition concurrently
    const lockAssetKey = 'assets/lock-asset.txt';
    const lockAssetPath = storageService.getFilePath(lockAssetKey);
    fs.mkdirSync(path.dirname(lockAssetPath), { recursive: true });
    fs.writeFileSync(lockAssetPath, 'concurrency row lock payload content');

    const lockAsset = await prisma.asset.create({
      data: {
        title: 'Lock Asset File',
        type: AssetType.TEXT,
        source: 'test',
        state: AssetState.PROCESS_NOW,
        fileKey: lockAssetKey,
        fileSize: 37,
        mimeType: 'text/plain',
        checksum: 'lock-checksum-777'
      }
    });

    // Trigger 3 concurrent transition requests to ARCHIVE with executePreset = true
    webhookCallCount = 0; // reset counter

    const patchRequests = Array.from({ length: 3 }).map(() =>
      fetch(`${baseUrl}/inbox/${lockAsset.id}/state`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: AssetState.ARCHIVE,
          presetId: concurrencyWebhookPreset.id,
          executePreset: true
        })
      })
    );

    const patchResponses = await Promise.all(patchRequests);
    const statuses = patchResponses.map(r => r.status);
    
    // Exactly one transition request should succeed (200), and the others should be rejected (400)
    // because they are serialised and when the 2nd and 3rd acquire the lock, state is already ARCHIVE
    const successCount = statuses.filter(s => s === 200).length;
    const blockedCount = statuses.filter(s => s === 400).length;

    testAssert(
      'Concurrency Transition Response Statuses',
      successCount === 1 && blockedCount === 2,
      'Exactly one request succeeded (200) and two were blocked (400).',
      `Unexpected statuses: ${statuses.join(', ')}`
    );

    testAssert(
      'Duplicate Webhook Prevention Count',
      webhookCallCount === 1,
      'Webhook was executed exactly once (no duplicate dispatches).',
      `Webhook call count was: ${webhookCallCount}`
    );

    // Verify DB record, state, and files are synchronized
    const finalAssetRecord = await prisma.asset.findUnique({
      where: { id: lockAsset.id }
    });
    
    const physicalFileExists = fs.existsSync(lockAssetPath);
    testAssert(
      'Database-Disk Synchronization Under Concurrency',
      finalAssetRecord?.state === AssetState.ARCHIVE && physicalFileExists === true,
      'Database state is ARCHIVE and physical file is preserved.',
      `State: ${finalAssetRecord?.state}, File Exists: ${physicalFileExists}`
    );

    // Clean up concurrency asset file
    if (fs.existsSync(lockAssetPath)) {
      fs.unlinkSync(lockAssetPath);
    }

  } catch (err) {
    console.error('❌ Validation Run crashed:', err);
    results.failed.push('GLOBAL_CRASH');
  } finally {
    // Teardown
    await prisma.asset.deleteMany({});
    await prisma.destinationPreset.deleteMany({});
    await app.close();
    await prisma.$disconnect();
    console.log('\n👋 Validation server stopped.');

    console.log(`\n==============================================`);
    console.log(`📊 SYSTEM VALIDATION SUMMARY`);
    console.log(`==============================================`);
    console.log(`Passed Tests:  ${results.passed.length}`);
    console.log(`Failed Tests:  ${results.failed.length}`);
    console.log(`Edge Cases:    ${results.edgeCases.length}`);
    console.log(`==============================================`);

    // Output clean report items for parent agent
    console.log('\n[REPORT:PASSED]');
    results.passed.forEach(name => console.log(`- ${name}`));
    console.log('[REPORT:FAILED]');
    results.failed.forEach(name => console.log(`- ${name}`));
    console.log('[REPORT:EDGECASES]');
    results.edgeCases.forEach(ec => console.log(`- ${ec}`));

    if (results.failed.length > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }
}

runSystemValidation();
