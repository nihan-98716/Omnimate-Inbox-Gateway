import app from './app';
import { prisma } from './services/db';
import { storageService } from './services/storage.service';
import { ExpiryService } from './services/expiry.service';
import { AssetState, AssetType, PresetType, JobStatus } from '@prisma/client';
import { config } from './config';
import fs from 'fs';
import path from 'path';
import assert from 'assert';

async function runFailureTests() {
  console.log('🛡️ Starting Preset Failure and Expiry Sync Verification...\n');
  let passCount = 0;
  let failCount = 0;

  const testAssert = (condition: boolean, message: string) => {
    if (condition) {
      console.log(` ✅ PASS: ${message}`);
      passCount++;
    } else {
      console.error(` ❌ FAIL: ${message}`);
      failCount++;
    }
  };

  try {
    await prisma.$connect();
    await prisma.asset.deleteMany({});
    await prisma.destinationPreset.deleteMany({});

    const address = await app.listen({ port: 3003, host: '127.0.0.1' });
    console.log(`✅ Test server running at ${address}`);

    // -------------------------------------------------------------
    // Test Case 1: Webhook Preset Failure & Asset Recoverability
    // -------------------------------------------------------------
    console.log('\n--- Test Case 1: Webhook Failure & Asset Recoverability ---');
    
    const deadPreset = await prisma.destinationPreset.create({
      data: {
        name: 'Dead Webhook Link',
        type: PresetType.WEBHOOK,
        config: { url: 'http://127.0.0.1:9999/accounting-ingest' }
      }
    });

    const fileKey = 'assets/recoverable-file.txt';
    const filePath = storageService.getFilePath(fileKey);
    const parentDir = path.dirname(filePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(filePath, 'source file content to transfer');

    const asset = await prisma.asset.create({
      data: {
        title: 'Pending Invoice',
        type: AssetType.TEXT,
        source: 'scanbox',
        state: AssetState.PROCESS_NOW,
        fileKey,
        fileSize: 100,
        mimeType: 'text/plain',
        checksum: 'unique-hash-recoverable-999'
      }
    });

    // Trigger state transition with API authentication header
    const response = await fetch(`http://127.0.0.1:3003/api/v1/inbox/${asset.id}/state`, {
      method: 'PATCH',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-api-key'
      },
      body: JSON.stringify({
        state: AssetState.ARCHIVE,
        presetId: deadPreset.id,
        executePreset: true
      })
    });

    testAssert(response.status === 200, 'API returns 200 OK indicating webhook is queued.');
    
    // Poll the DB until the webhook execution finishes failing
    let refreshedAsset: any = null;
    const pollStart = Date.now();
    const timeout = 15000; // 15 seconds max polling
    
    while (Date.now() - pollStart < timeout) {
      refreshedAsset = await prisma.asset.findUnique({
        where: { id: asset.id }
      });
      if (refreshedAsset?.presetStatus === JobStatus.FAILED) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    testAssert(refreshedAsset?.presetStatus === JobStatus.FAILED, 'Asset presetStatus transitions to FAILED.');
    testAssert(refreshedAsset?.state === AssetState.PROCESS_NOW, 'Asset state remains in PROCESS_NOW (recoverable in inbox).');
    
    const executionLogs = (refreshedAsset?.metadata as any)?.presetExecution;
    testAssert(executionLogs !== undefined, 'Preset execution failure logs populated in metadata.');
    testAssert(executionLogs?.success === false, 'Metadata execution status is false.');
    testAssert(refreshedAsset?.presetError !== null, 'Preset error is not null.');

    // -------------------------------------------------------------
    // Test Case 2: Expiry Service Synchronization Safety
    // -------------------------------------------------------------
    console.log('\n--- Test Case 2: Expiry Service DB-Disk Sync Safety ---');

    const tempDir = path.join(config.UPLOAD_DIR, 'tmp-dummy-dir');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const fileKeyDir = 'tmp-dummy-dir';
    const thirtyOneDaysAgo = new Date();
    thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31);

    const expiredAsset = await prisma.asset.create({
      data: {
        title: 'Locked Asset File',
        type: AssetType.OTHER,
        source: 'test',
        state: AssetState.DELETED,
        fileKey: fileKeyDir,
        fileSize: 0,
        mimeType: 'application/octet-stream',
        checksum: 'checksum-lock-failed-888',
        deletedAt: thirtyOneDaysAgo
      }
    });

    console.log('✅ Expired asset points to directory path to force EISDIR unlinking crash.');

    const expiryService = new ExpiryService(prisma);
    await expiryService.runCleanup();

    const dbAssetCheck = await prisma.asset.findUnique({
      where: { id: expiredAsset.id }
    });

    testAssert(dbAssetCheck !== null, 'Database record is NOT deleted because file unlinking failed (Synchronization Safety).');
    
    if (fs.existsSync(tempDir)) {
      fs.rmdirSync(tempDir);
    }
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    console.log(`\n==============================================`);
    console.log(`📊 FAILURE RUNNER SUMMARY`);
    console.log(`==============================================`);
    console.log(`Passed: ${passCount}`);
    console.log(`Failed: ${failCount}`);
    console.log(`==============================================\n`);

    if (failCount > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Failure runner crashed:', err);
    process.exit(1);
  } finally {
    await prisma.asset.deleteMany({});
    await prisma.destinationPreset.deleteMany({});
    await app.close();
    await prisma.$disconnect();
    console.log('👋 Verification teardown complete.\n');
  }
}

runFailureTests();
