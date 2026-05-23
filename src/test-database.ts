import { prisma } from './services/db';
import { AssetState, AssetType, PresetType } from '@prisma/client';

async function runDatabaseTests() {
  console.log('📊 Starting Database Layer Validation Suite...\n');
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
    // Reset database state before starting
    await prisma.$connect();
    await prisma.asset.deleteMany({});
    await prisma.destinationPreset.deleteMany({});

    // -------------------------------------------------------------
    // Test Case 1: Schema Validity, Defaults, and Nullability
    // -------------------------------------------------------------
    console.log('--- Test Case 1: Schema Defaults & Nullability ---');
    const newPreset = await prisma.destinationPreset.create({
      data: {
        name: 'S3 Backup Target',
        type: PresetType.S3,
        config: { bucket: 'omnimate-inbox-test', region: 'us-west-2' }
      }
    });

    assert(newPreset.id !== undefined, 'DestinationPreset record created successfully.');
    assert(newPreset.schemaVersion === 1, 'Default schemaVersion of 1 was correctly applied.');
    assert(newPreset.isActive === true, 'Default isActive value of true was applied.');

    const newAsset = await prisma.asset.create({
      data: {
        title: 'Document Invoice',
        type: AssetType.PDF,
        source: 'scanbox',
        fileKey: 'assets/2026/05/23/some-file-key.pdf',
        fileSize: 2048,
        mimeType: 'application/pdf',
        checksum: 'checksum-123456789'
      }
    });

    assert(newAsset.id !== undefined, 'Asset record created successfully.');
    assert(newAsset.state === AssetState.PROCESS_NOW, 'Default state PROCESS_NOW was correctly applied.');
    assert(newAsset.deletedAt === null, 'deletedAt property is correctly null by default.');

    // -------------------------------------------------------------
    // Test Case 2: Indexes and Constraints (Unique Constraint Check)
    // -------------------------------------------------------------
    console.log('\n--- Test Case 2: Checksum Database Constraint ---');
    let checksumViolationThrown = false;
    try {
      // Attempt to insert another asset with the exact same checksum
      await prisma.asset.create({
        data: {
          title: 'Duplicate Document',
          type: AssetType.PDF,
          source: 'shots',
          fileKey: 'assets/2026/05/23/different-path.pdf',
          fileSize: 4096,
          mimeType: 'application/pdf',
          checksum: 'checksum-123456789' // Same checksum
        }
      });
    } catch (err: any) {
      checksumViolationThrown = true;
      assert(err.code === 'P2002', 'Prisma correctly threw a unique constraint violation error (P2002).');
    }

    assert(checksumViolationThrown === true, 'Database unique constraint prevents duplicate checksum rows.');

    // -------------------------------------------------------------
    // Test Case 3: JSON Field Handling for Destination Presets
    // -------------------------------------------------------------
    console.log('\n--- Test Case 3: JSON Config Parsing & Mapping ---');
    const complexConfig = {
      endpoint: 'https://webhook.site/v1/inbound',
      headers: {
        Authorization: 'Bearer secretToken123',
        'X-Custom-Header': 'OmnimateTest'
      },
      retryPolicy: {
        attempts: 3,
        backoffSeconds: 5
      }
    };

    const presetWithJson = await prisma.destinationPreset.create({
      data: {
        name: 'Webhook Production Channel',
        type: PresetType.WEBHOOK,
        config: complexConfig
      }
    });

    const retrievedPreset = await prisma.destinationPreset.findUnique({
      where: { id: presetWithJson.id }
    });

    const parsedConfig = retrievedPreset?.config as any;
    assert(parsedConfig !== null, 'Preset JSON config retrieved from database.');
    assert(parsedConfig.endpoint === complexConfig.endpoint, 'Retrieved config URL matches.');
    assert(parsedConfig.headers.Authorization === complexConfig.headers.Authorization, 'Nested JSON auth token retrieved intact.');

    // -------------------------------------------------------------
    // Test Case 4: Database Transaction Rollbacks
    // -------------------------------------------------------------
    console.log('\n--- Test Case 4: Database Transaction Safety (Rollbacks) ---');
    
    let transactionRolledBack = false;
    try {
      await prisma.$transaction(async (tx) => {
        // 1. Create a temporary asset inside the transaction
        await tx.asset.create({
          data: {
            title: 'Transactional Asset',
            type: AssetType.IMAGE,
            source: 'shots',
            fileKey: 'assets/temp-transaction.png',
            fileSize: 1024,
            mimeType: 'image/png',
            checksum: 'tx-checksum-unique-123'
          }
        });

        // 2. Intentionally throw an error mid-transaction to force abort
        throw new Error('Database connection simulation timeout/failure');
      });
    } catch (err: any) {
      transactionRolledBack = true;
      assert(err.message === 'Database connection simulation timeout/failure', 'Transaction successfully intercepted manual error.');
    }

    // 3. Verify that the asset created inside the aborted transaction was NOT saved (rolled back)
    const rolledBackAsset = await prisma.asset.findFirst({
      where: { checksum: 'tx-checksum-unique-123' }
    });

    assert(rolledBackAsset === null, 'Asset created inside aborted transaction was rolled back and is absent from database.');

    // -------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------
    console.log(`\n==============================================`);
    console.log(`📊 DATABASE VERIFICATION SUMMARY`);
    console.log(`==============================================`);
    console.log(`Passed: ${passCount}`);
    console.log(`Failed: ${failCount}`);
    console.log(`==============================================\n`);

    if (failCount > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Database verification runner crashed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runDatabaseTests();
