import app from '../../src/app';
import { prisma } from '../../src/services/db';
import { webhookQueue } from '../../src/services/queue.service';
import { AssetState, PresetType, JobStatus } from '@prisma/client';
import { ResourceMonitor } from './test-utils';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import assert from 'assert';

const PORT = 3012;
const MOCK_WEBHOOK_PORT = 3013;

async function main() {
  console.log('🏁 Starting BullMQ Queue Concurrency and Persistence Stress Test...\n');

  await prisma.$connect();
  await prisma.asset.deleteMany({});
  await prisma.destinationPreset.deleteMany({});

  // 1. Setup shared file in permanent storage to satisfy presetService checks
  const sharedKey = 'assets/shared-stress-file.txt';
  const sharedPath = path.resolve('./uploads', sharedKey);
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  fs.writeFileSync(sharedPath, 'shared stress file content');

  // 2. Start mock webhook receiver that monitors concurrency
  let webhooksReceived = 0;
  let activeConcurrency = 0;
  let maxObservedConcurrency = 0;

  const mockApp = require('fastify')();
  mockApp.post('/receiver', async (req: any, reply: any) => {
    activeConcurrency++;
    webhooksReceived++;
    if (activeConcurrency > maxObservedConcurrency) {
      maxObservedConcurrency = activeConcurrency;
    }
    
    // Simulate slow network processing to allow concurrency check
    await new Promise(resolve => setTimeout(resolve, 50));
    activeConcurrency--;
    return reply.send({ success: true });
  });

  await mockApp.listen({ port: MOCK_WEBHOOK_PORT, host: '127.0.0.1' });
  console.log(`📡 Mock Webhook Receiver listening at http://127.0.0.1:${MOCK_WEBHOOK_PORT}`);

  // Create a destination preset pointing to the mock receiver
  const preset = await prisma.destinationPreset.create({
    data: {
      name: 'Stress Queue Webhook',
      type: PresetType.WEBHOOK,
      config: { url: `http://127.0.0.1:${MOCK_WEBHOOK_PORT}/receiver` }
    }
  });

  // Start Fastify gateway server to handle index / health checks
  await app.listen({ port: PORT, host: '127.0.0.1' });

  // 3. Create 1000 assets in DB
  const numJobs = 1000;
  console.log(`Creating ${numJobs} asset records in DB...`);
  
  const assetsData = Array.from({ length: numJobs }).map((_, i) => ({
    title: `Queue Stress Asset #${i}`,
    type: 'TEXT' as const,
    source: 'queue-stress',
    state: AssetState.PROCESS_NOW,
    fileKey: sharedKey,
    fileSize: 26,
    mimeType: 'text/plain',
    checksum: `checksum-queue-stress-${i}-${crypto.randomUUID()}`
  }));

  // Batch insert
  await prisma.asset.createMany({
    data: assetsData
  });

  const createdAssets = await prisma.asset.findMany({
    where: { source: 'queue-stress' },
    select: { id: true }
  });

  console.log(`✅ Seeded ${createdAssets.length} assets in PostgreSQL.`);

  // 4. Enqueue 1000+ jobs in BullMQ
  console.log(`Enqueuing ${numJobs} jobs into BullMQ...`);
  const monitor = new ResourceMonitor();
  const startRss = monitor.getStats().rss;

  // Let's queue them all
  const jobPromises = createdAssets.map(asset => 
    webhookQueue.add(`execute-webhook-${asset.id}`, {
      assetId: asset.id,
      presetId: preset.id
    })
  );
  await Promise.all(jobPromises);
  console.log(`✅ All ${numJobs} jobs successfully enqueued.`);

  // 5. While processing, trigger Redis restart (after 100 jobs processed)
  let restartedRedis = false;
  
  // Wait loop for processing
  const runUntil = Date.now() + 60000; // 60 seconds max timeout
  while (Date.now() < runUntil) {
    const completedCount = await prisma.asset.count({
      where: { presetStatus: JobStatus.COMPLETED }
    });
    
    const failedCount = await prisma.asset.count({
      where: { presetStatus: JobStatus.FAILED }
    });

    const totalProcessed = completedCount + failedCount;
    const currentRss = monitor.getStats().rss;

    console.log(`[Progress] Processed: ${totalProcessed}/${numJobs} (Completed: ${completedCount}, Failed: ${failedCount}) | Max Concurrency: ${maxObservedConcurrency} | Current RSS: ${currentRss.toFixed(1)} MB`);

    // Concurrency limit verification
    assert.ok(maxObservedConcurrency <= 5, `Concurrency limit violated! Max observed was ${maxObservedConcurrency}, limit is 5.`);

    if (totalProcessed >= numJobs) {
      break;
    }

    // Trigger Redis container restart mid-way (around 150 processed jobs)
    if (totalProcessed > 150 && !restartedRedis) {
      console.log('\n⚡ [PERSISTENCE TEST] Restarting Redis container mid-flight to verify job survival...');
      try {
        execSync('docker restart omnimate-redis');
        console.log('✅ Redis container restarted successfully. Queue recovery processing should resume.');
      } catch (err) {
        console.error('⚠️ Failed to restart Redis container:', err);
      }
      restartedRedis = true;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // 6. Assertions
  const finalCompleted = await prisma.asset.count({
    where: { presetStatus: JobStatus.COMPLETED }
  });
  const finalFailed = await prisma.asset.count({
    where: { presetStatus: JobStatus.FAILED }
  });
  const finalProcessed = finalCompleted + finalFailed;

  console.log('\n📊 Stress Test Verification Summary:');
  console.log(`- Total jobs enqueued: ${numJobs}`);
  console.log(`- Successfully processed (Completed): ${finalCompleted}`);
  console.log(`- Failed jobs: ${finalFailed}`);
  console.log(`- Webhooks received by mock server: ${webhooksReceived}`);
  console.log(`- Peak Concurrency: ${maxObservedConcurrency}`);
  
  const gc = (global as any).gc;
  if (gc) {
    console.log('Running garbage collector before final memory check...');
    gc();
  }
  const endRss = monitor.getStats().rss;
  const memoryGrowth = endRss - startRss;
  console.log(`- Memory RSS: Start: ${startRss.toFixed(1)} MB, End: ${endRss.toFixed(1)} MB, Growth: ${memoryGrowth.toFixed(1)} MB`);

  assert.strictEqual(finalProcessed, numJobs, `Not all jobs completed! Processed: ${finalProcessed}/${numJobs}`);
  assert.ok(maxObservedConcurrency <= 5, 'Concurrency must never exceed 5');
  assert.ok(memoryGrowth < 120, `Unreasonable memory growth detected: ${memoryGrowth.toFixed(1)} MB`);

  console.log('✅ PASS: BullMQ concurrency protection and Redis persistence verification.');

  // Clean up
  await prisma.asset.deleteMany({});
  await prisma.destinationPreset.deleteMany({});
  if (fs.existsSync(sharedPath)) {
    fs.unlinkSync(sharedPath);
  }
  await mockApp.close();
  await app.close();
  await prisma.$disconnect();
  console.log('👋 Cleaned up all servers and closed DB connections.\n');
}

main().catch(err => {
  console.error('❌ Stress Queue Test crashed:', err);
  process.exit(1);
});
