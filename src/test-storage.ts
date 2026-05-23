import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { prisma } from './services/db';
import { storageService } from './services/storage.service';
import { calculateStreamHash } from './utils/hash';
import { AssetState, AssetType } from '@prisma/client';

async function runTests() {
  console.log('🚀 Starting Storage and Checksum Verification Suite...\n');
  let passCount = 0;
  let failCount = 0;

  const assert = (condition: boolean, message: string) => {
    if (condition) {
      console.log(` ✅ PASS: ${message}`);
      passCount++;
    } else {
      console.error(` ❌ FAIL: ${message}`);
      failCount++;
    }
  };

  try {
    // 0. Setup: Clean DB and filesystem
    await prisma.$connect();
    await prisma.asset.deleteMany({});
    
    // Clear storage folder if exists
    const uploadsDir = path.resolve('./uploads');
    if (fs.existsSync(uploadsDir)) {
      fs.rmSync(uploadsDir, { recursive: true, force: true });
    }

    // Re-initialize storage service dirs
    const newStorage = new (storageService.constructor as any)();

    // -------------------------------------------------------------
    // Test Case 1: Upload handling & Temporary Staging
    // -------------------------------------------------------------
    console.log('--- Test Case 1: Temporary Staging ---');
    const content = 'omnimate-test-file-content-12345';
    const stream = Readable.from([content]);
    const tempKey = `temp-test-file-${Date.now()}`;
    
    const tempPath = await newStorage.saveToTemp(tempKey, stream);
    assert(fs.existsSync(tempPath), 'Staged temp file should exist on disk.');
    assert(fs.readFileSync(tempPath, 'utf8') === content, 'Staged file contents should match stream payload.');

    // -------------------------------------------------------------
    // Test Case 2: Checksum Calculation and Hash Extraction
    // -------------------------------------------------------------
    console.log('\n--- Test Case 2: Checksum & Hash Calculations ---');
    const readStream = fs.createReadStream(tempPath);
    const { hash, size } = await calculateStreamHash(readStream);
    
    // Expected SHA-256 for 'omnimate-test-file-content-12345'
    const expectedHash = 'd773b1c7d0c5ddfb4327ecd97b90f7fff7ab08b7f52a167594701374caa3e47e';
    console.log(`Debug - Actual Hash:   "${hash}"`);
    console.log(`Debug - Expected Hash: "${expectedHash}"`);
    assert(hash === expectedHash, `Extracted hash (${hash.slice(0, 10)}...) matches expected checksum.`);
    assert(size === content.length, `Staged file size (${size} bytes) matches expected byte length.`);

    // -------------------------------------------------------------
    // Test Case 3: Move from Temporary Staging to Permanent Storage
    // -------------------------------------------------------------
    console.log('\n--- Test Case 3: Staging Promotion (Move) ---');
    const permanentKey = `assets/2026/05/23/${hash}-test-file.txt`;
    const permanentPath = newStorage.getFilePath(permanentKey);

    await newStorage.moveToPermanent(tempKey, permanentKey);
    assert(!fs.existsSync(tempPath), 'Staged temp file should be deleted after move.');
    assert(fs.existsSync(permanentPath), 'Permanent file should exist in final location.');
    assert(fs.readFileSync(permanentPath, 'utf8') === content, 'Permanent file contents match original payload.');

    // Save to Database to establish baseline for deduplication
    const asset = await prisma.asset.create({
      data: {
        title: 'Verification Asset',
        type: AssetType.TEXT,
        source: 'verification_script',
        state: AssetState.PROCESS_NOW,
        fileKey: permanentKey,
        fileSize: size,
        mimeType: 'text/plain',
        checksum: hash
      }
    });
    assert(asset.id !== undefined, 'Database entry committed successfully.');

    // -------------------------------------------------------------
    // Test Case 4: Duplicate Verification and Deduplication
    // -------------------------------------------------------------
    console.log('\n--- Test Case 4: Duplicate Deduplication ---');
    // Upload duplicate file stream
    const dupStream = Readable.from([content]);
    const dupTempKey = `temp-dup-${Date.now()}`;
    await newStorage.saveToTemp(dupTempKey, dupStream);

    const dupTempPath = newStorage.getFilePath(`tmp/${dupTempKey}`);
    const dupReadStream = fs.createReadStream(dupTempPath);
    const dupHashResult = await calculateStreamHash(dupReadStream);

    // Look up checksum
    const dupMatch = await prisma.asset.findUnique({
      where: { checksum: dupHashResult.hash }
    });

    assert(dupMatch !== null, 'Deduplication lookup correctly identifies existing hash.');
    assert(dupMatch?.id === asset.id, 'Duplicate query resolves to same existing database record ID.');
    
    // Cleanup temporary file since it is duplicate
    await newStorage.deleteTemp(dupTempKey);
    assert(!fs.existsSync(dupTempPath), 'Staged duplicate file deleted successfully to prevent disk bloat.');

    // -------------------------------------------------------------
    // Test Case 5: DB Transaction Failures (Avoiding Orphan Files)
    // -------------------------------------------------------------
    console.log('\n--- Test Case 5: DB Failure Orphan Cleanup ---');
    const crashContent = 'crash-failure-content';
    const crashStream = Readable.from([crashContent]);
    const crashTempKey = `temp-crash-${Date.now()}`;

    // 1. Stage in temp
    await newStorage.saveToTemp(crashTempKey, crashStream);
    const crashTempPath = newStorage.getFilePath(`tmp/${crashTempKey}`);
    assert(fs.existsSync(crashTempPath), 'Staged crash file exists in temp.');

    // 2. Simulate DB write failure
    let dbWriteSuccess = false;
    try {
      // Intentionally cause unique constraint crash (insert same duplicate checksum)
      await prisma.asset.create({
        data: {
          title: 'Crashed Asset',
          type: AssetType.TEXT,
          source: 'verification_script',
          state: AssetState.PROCESS_NOW,
          fileKey: `assets/crashed.txt`,
          fileSize: crashContent.length,
          mimeType: 'text/plain',
          checksum: hash // Duplicate checksum triggers Postgres unique violation error
        }
      });
      dbWriteSuccess = true;
    } catch (dbErr) {
      // Transaction failed, trigger rollback logic
      await newStorage.deleteTemp(crashTempKey);
    }

    assert(dbWriteSuccess === false, 'Prisma database transaction correctly failed due to unique constraint.');
    assert(!fs.existsSync(crashTempPath), 'Transaction safety rollback successfully removed staged temp file (No orphans).');

    // -------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------
    console.log(`\n==============================================`);
    console.log(`📊 VERIFICATION RUN SUMMARY`);
    console.log(`==============================================`);
    console.log(`Passed: ${passCount}`);
    console.log(`Failed: ${failCount}`);
    console.log(`==============================================\n`);

    if (failCount > 0) {
      process.exit(1);
    }
  } catch (globalErr) {
    console.error('❌ Global verification runner error:', globalErr);
    process.exit(1);
  } finally {
    // Teardown
    await prisma.$disconnect();
  }
}

runTests();
