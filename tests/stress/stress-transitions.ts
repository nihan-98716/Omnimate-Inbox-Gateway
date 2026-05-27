import app from '../../src/app';
import { prisma } from '../../src/services/db';
import { AssetState, PresetType } from '@prisma/client';

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
import { ResourceMonitor, runConcurrentRequests } from './test-utils';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import assert from 'assert';

const PORT = 3008;
const BASE_URL = `http://127.0.0.1:${PORT}/api/v1`;

async function main() {
  console.log('🏁 Starting Part 3: State Transition Concurrency & DB Connection Stress Tests...\n');

  // Establish DB connection and clean tables
  await prisma.$connect();
  await prisma.asset.deleteMany({});
  await prisma.destinationPreset.deleteMany({});

  // Setup a mock webhook receiver on the Fastify app
  let webhookCallCount = 0;
  app.post('/test-webhook-receiver', async (req, reply) => {
    webhookCallCount++;
    // Add artificial delay to simulate real network latency and force concurrent transaction overlap
    await new Promise(resolve => setTimeout(resolve, 150));
    return reply.send({ success: true });
  });

  // Start Fastify server
  const address = await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`📡 Transition Stress server online at ${address}`);

  const monitor = new ResourceMonitor();
  monitor.startLagMonitor(10);

  try {
    // =========================================================================
    // 1. State Transition Concurrency Stress Test
    // =========================================================================
    console.log('\n--- 1. Running State Transition Concurrency Stress Test ---');
    
    // Create an asset in the database directly
    const testAsset = await prisma.asset.create({
      data: {
        title: 'Concurrency Transition Target',
        type: 'TEXT',
        source: 'stress-test',
        state: AssetState.PROCESS_NOW,
        fileKey: 'assets/temp-transition-file.txt',
        fileSize: 100,
        mimeType: 'text/plain',
        checksum: `checksum-trans-${crypto.randomUUID()}`
      }
    });

    // Create a mock webhook file on disk so the fileKey exists when preset is executed
    const filePath = path.resolve('./uploads', testAsset.fileKey);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'some dummy contents to satisfy file checks');

    // Create a destination preset
    const preset = await prisma.destinationPreset.create({
      data: {
        name: 'Stress Webhook Preset',
        type: PresetType.WEBHOOK,
        config: { url: `http://127.0.0.1:${PORT}/test-webhook-receiver` }
      }
    });

    const numPatchRequests = 200;
    console.log(`Created asset ${testAsset.id} and preset ${preset.id}. Firing ${numPatchRequests} concurrent patches...`);

    const patchResults = await runConcurrentRequests(numPatchRequests, numPatchRequests, async () => {
      const res = await fetch(`${BASE_URL}/inbox/${testAsset.id}/state`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: AssetState.ARCHIVE,
          presetId: preset.id,
          executePreset: true
        })
      });
      const data = await res.json() as any;
      return { statusCode: res.status, data };
    });

    const status200 = patchResults.filter(r => r.statusCode === 200);
    const status400 = patchResults.filter(r => r.statusCode === 400);
    const failures = patchResults.filter(r => r.statusCode !== 200 && r.statusCode !== 400);

    console.log(`Transition Results:`);
    console.log(`- Total PATCH requests: ${numPatchRequests}`);
    console.log(`- 200 OK (Transitioned): ${status200.length}`);
    console.log(`- 400 Bad Request (Blocked): ${status400.length}`);
    console.log(`- Failures / Other status codes: ${failures.length}`);
    // Wait for the background BullMQ worker to process the webhook
    const startPoll = Date.now();
    while (webhookCallCount < 1 && Date.now() - startPoll < 5000) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`- Webhook receiver dispatches triggered: ${webhookCallCount}`);

    assert.strictEqual(status200.length, 1, 'Exactly one patch request must succeed with 200 OK');
    assert.strictEqual(status400.length, numPatchRequests - 1, 'All other patch requests must fail with 400 Bad Request');
    assert.strictEqual(webhookCallCount, 1, 'Preset webhook must be invoked exactly once');
    assert.strictEqual(failures.length, 0, 'No unexpected server failures or connection resets');

    // =========================================================================
    // 2. Database Connection and Query Load Stress Test
    // =========================================================================
    const durationSec = parseInt(process.env.DB_STRESS_DURATION_SEC || '60', 10);
    console.log(`\n--- 2. Running Database Connection Stress Test (${durationSec} seconds) ---`);
    console.log('Spawning 15 concurrent load workers performing queries, listings, and updates...');

    // Seed the database with some assets first to make query results non-trivial
    console.log('Seeding baseline query load assets...');
    for (let i = 0; i < 100; i++) {
      await prisma.asset.create({
        data: {
          title: `Seed Asset ${i}`,
          type: 'IMAGE',
          source: 'seed-load',
          state: i % 2 === 0 ? AssetState.PROCESS_NOW : AssetState.SAVE_FOR_LATER,
          fileKey: `assets/seed-${i}.jpg`,
          fileSize: 500,
          mimeType: 'image/jpeg',
          checksum: `checksum-seed-${i}-${crypto.randomUUID()}`
        }
      });
    }

    const workerCount = 15;
    const workerPromises: Promise<void>[] = [];
    let queryCount = 0;
    let queryFailures = 0;
    const runUntil = Date.now() + durationSec * 1000;

    for (let w = 0; w < workerCount; w++) {
      workerPromises.push((async () => {
        while (Date.now() < runUntil) {
          try {
            const operation = Math.floor(Math.random() * 3);
            if (operation === 0) {
              // 1. List assets (GET /inbox)
              const limit = Math.floor(Math.random() * 20) + 10;
              const res = await fetch(`${BASE_URL}/inbox?limit=${limit}`);
              assert.strictEqual(res.status, 200);
            } else if (operation === 1) {
              // 2. Find an asset and toggle its state (PROCESS_NOW <-> SAVE_FOR_LATER)
              const assetList = await prisma.asset.findMany({ take: 5 });
              if (assetList.length > 0) {
                const target = assetList[Math.floor(Math.random() * assetList.length)];
                const nextState = target.state === AssetState.PROCESS_NOW ? AssetState.SAVE_FOR_LATER : AssetState.PROCESS_NOW;
                const res = await fetch(`${BASE_URL}/inbox/${target.id}/state`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ state: nextState })
                });
                assert.ok(res.status === 200 || res.status === 400, `Expected 200 or 400 but got ${res.status}`);
              }
            } else {
              // 3. Raw aggregate/aggregate stats (GET /recents)
              const res = await fetch(`${BASE_URL}/recents?limit=10`);
              assert.strictEqual(res.status, 200);
            }
            queryCount++;
          } catch (err) {
            queryFailures++;
            console.error('Worker query failure:', err);
          }
          // Sleep slightly to prevent tight loop CPU starvation
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      })());
    }

    await Promise.all(workerPromises);

    const dbStats = monitor.getStats();
    console.log(`Database Load Statistics:`);
    console.log(`- Executed queries: ${queryCount}`);
    console.log(`- Query failures: ${queryFailures}`);
    console.log(`- Peak RSS Memory: ${dbStats.rss.toFixed(2)} MB`);
    console.log(`- Peak Heap Used: ${dbStats.heapUsed.toFixed(2)} MB`);
    console.log(`- Average query rate: ${(queryCount / durationSec).toFixed(2)} req/sec`);

    assert.strictEqual(queryFailures, 0, 'Database queries under sustained connection load must have 0% failure rate');
    console.log('\n✅ PASS: Part 3 State Transition and Database Connection Stress tests completed.');
  } finally {
    // Teardown
    const lagStats = monitor.stopLagMonitor();
    console.log(`\nEvent Loop Monitoring:`);
    console.log(`- Max Event Loop Lag: ${lagStats.maxLagMs.toFixed(2)} ms`);
    console.log(`- Avg Event Loop Lag: ${lagStats.avgLagMs.toFixed(2)} ms`);

    // Clean up temporary webhook file
    const uploadsDir = path.resolve('./uploads');
    if (fs.existsSync(uploadsDir)) {
      fs.rmSync(uploadsDir, { recursive: true, force: true });
    }

    await app.close();
    await prisma.$disconnect();
    console.log('\n👋 Transition Stress server shut down cleanly.');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Part 3 Stress Test crashed:', err);
    process.exit(1);
  });
}
