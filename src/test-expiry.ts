import fs from 'fs';
import { prisma } from './services/db';
import { storageService } from './services/storage.service';
import { ExpiryService } from './services/expiry.service';
import { AssetState, AssetType } from '@prisma/client';
import assert from 'assert';

async function testExpiryCleanup() {
  console.log('🧹 Starting Background Expiry Purge Daemon Verification...\n');

  try {
    await prisma.$connect();
    await prisma.asset.deleteMany({});

    // 1. Prepare a mock file on disk
    const fileKey = 'assets/expired-to-purge.txt';
    const filePath = storageService.getFilePath(fileKey);
    
    // Ensure final folder path exists
    const fileDir = fs.readFileSync ? filePath.substring(0, filePath.lastIndexOf(pathSeparator())) : '';
    if (fileDir && !fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true });
    }
    fs.writeFileSync(filePath, 'stale content representing an expired file');
    assert(fs.existsSync(filePath), 'Stale mock file created on disk.');

    // 2. Create an expired deleted asset record (deleted 31 days ago)
    const thirtyOneDaysAgo = new Date();
    thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31);

    const asset = await prisma.asset.create({
      data: {
        title: 'Old Expired Document',
        type: AssetType.TEXT,
        source: 'scanbox',
        state: AssetState.DELETED,
        fileKey,
        fileSize: fs.statSync(filePath).size,
        mimeType: 'text/plain',
        checksum: 'stale-hash-checksum-999',
        deletedAt: thirtyOneDaysAgo
      }
    });

    console.log(`✅ Expired asset created: ID ${asset.id}, deletedAt: ${asset.deletedAt?.toISOString()}`);

    // 3. Run the Expiry Cleanup service routine
    const expiryService = new ExpiryService(prisma);
    await expiryService.runCleanup();

    // 4. Verify hard-purge results
    const fileStillExists = fs.existsSync(filePath);
    const dbAsset = await prisma.asset.findUnique({
      where: { id: asset.id }
    });

    assert(!fileStillExists, 'Stale physical file successfully deleted from storage disk.');
    assert(dbAsset === null, 'Asset record successfully hard-deleted from database tables.');

    console.log('\n✅ PASS: Soft-delete expiry cleaner functions exactly as specified (Safe-Purges File + Database).');
  } catch (err) {
    console.error('❌ Expiry Cleaner Verification Failed:', err);
    process.exit(1);
  } finally {
    await prisma.asset.deleteMany({});
    await prisma.$disconnect();
    console.log('👋 Verification teardown complete.\n');
  }
}

function pathSeparator() {
  return process.platform === 'win32' ? '\\' : '/';
}

testExpiryCleanup();
