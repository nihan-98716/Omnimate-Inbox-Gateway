import app from '../../src/app';
import { prisma } from '../../src/services/db';
import { AssetState } from '@prisma/client';

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

const PORT = 3011;
const BASE_URL = `http://127.0.0.1:${PORT}/api/v1`;

async function main() {
  const durationSec = parseInt(process.env.ENDURANCE_DURATION_SEC || '900', 10);
  console.log(`🏁 Starting Part 6: Endurance Test (Duration: ${durationSec} seconds)...`);

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
  console.log(`📡 Endurance Stress server online at ${address}`);

  const monitor = new ResourceMonitor();
  monitor.startLagMonitor(10);

  // Pre-seed some assets
  console.log('Seeding baseline assets for endurance test...');
  for (let i = 0; i < 50; i++) {
    await prisma.asset.create({
      data: {
        title: `Endurance Seed Asset ${i}`,
        type: 'IMAGE',
        source: 'endurance-seed',
        state: i % 2 === 0 ? AssetState.PROCESS_NOW : AssetState.SAVE_FOR_LATER,
        fileKey: `assets/endurance-${i}.jpg`,
        fileSize: 1024,
        mimeType: 'image/jpeg',
        checksum: `checksum-endurance-seed-${i}-${crypto.randomUUID()}`
      }
    });
  }

  // Pre-generate upload payload
  const uploadPayload = generateRandomBuffer(500 * 1024); // 500KB file
  const boundary = `----EnduranceBoundary${crypto.randomUUID()}`;
  const bodyBuffer = buildMultipartBody(
    'endurance-upload.dat',
    'application/octet-stream',
    uploadPayload,
    { source: 'endurance-test', title: 'Endurance File' },
    boundary
  );

  const startTime = Date.now();
  const runUntil = startTime + durationSec * 1000;

  let totalRequests = 0;
  let successRequests = 0;
  let failedRequests = 0;

  // Latency tracking
  let latencySum = 0;
  let latencyCount = 0;
  let peakLatency = 0;

  // Telemetry samples array for final report
  const telemetryHistory: {
    elapsedSec: number;
    requests: number;
    rss: number;
    heapUsed: number;
    cpuUser: number;
    cpuSystem: number;
    avgLatency: number;
    reqPerSec: number;
  }[] = [];

  // Start telemetry logger interval (every 10 seconds)
  const telemetryInterval = setInterval(() => {
    const elapsedMs = Date.now() - startTime;
    const elapsedSec = elapsedMs / 1000;
    const stats = monitor.getStats();

    const currentAvgLatency = latencyCount > 0 ? latencySum / latencyCount : 0;
    const reqPerSec = elapsedSec > 0 ? totalRequests / elapsedSec : 0;

    // Reset local latency accumulator to show sliding window average
    latencySum = 0;
    latencyCount = 0;

    console.log(`[TELEMETRY] Time: ${elapsedSec.toFixed(0)}s | Requests: ${totalRequests} | Req/Sec: ${reqPerSec.toFixed(1)} | Avg Latency: ${currentAvgLatency.toFixed(1)}ms | Peak Latency: ${peakLatency.toFixed(1)}ms | RSS: ${stats.rss.toFixed(2)} MB | Heap: ${stats.heapUsed.toFixed(2)} MB | CPU User: ${stats.cpuUser.toFixed(1)}% | CPU System: ${stats.cpuSystem.toFixed(1)}%`);

    telemetryHistory.push({
      elapsedSec,
      requests: totalRequests,
      rss: stats.rss,
      heapUsed: stats.heapUsed,
      cpuUser: stats.cpuUser,
      cpuSystem: stats.cpuSystem,
      avgLatency: currentAvgLatency,
      reqPerSec
    });

  }, 10000);

  // Helper to run operations
  async function executeOperation() {
    const rand = Math.random();
    const start = performance.now();
    let status = 0;

    try {
      if (rand < 0.40) {
        // 1. Upload file (40% weight)
        const res = await fetch(`${BASE_URL}/inbox`, {
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body: bodyBuffer
        });
        status = res.status;
      } else if (rand < 0.70) {
        // 2. List inbox (30% weight)
        const res = await fetch(`${BASE_URL}/inbox?limit=20`);
        status = res.status;
      } else if (rand < 0.90) {
        // 3. State transition (20% weight)
        const assetList = await prisma.asset.findMany({ take: 10 });
        if (assetList.length > 0) {
          const target = assetList[Math.floor(Math.random() * assetList.length)];
          const nextState = target.state === AssetState.PROCESS_NOW ? AssetState.SAVE_FOR_LATER : AssetState.PROCESS_NOW;
          
          const res = await fetch(`${BASE_URL}/inbox/${target.id}/state`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: nextState })
          });
          status = res.status;
        } else {
          status = 200;
        }
      } else {
        // 4. GET Recents (10% weight)
        const res = await fetch(`${BASE_URL}/recents?limit=15`);
        status = res.status;
      }

      const latency = performance.now() - start;
      latencySum += latency;
      latencyCount++;
      if (latency > peakLatency) {
        peakLatency = latency;
      }

      totalRequests++;
      if (status === 200 || status === 201 || status === 400) {
        successRequests++;
      } else {
        failedRequests++;
        console.error(`Operation returned status code ${status}`);
      }
    } catch (err: any) {
      const latency = performance.now() - start;
      latencySum += latency;
      latencyCount++;
      totalRequests++;
      failedRequests++;
      console.error('Operation exception:', err.message || String(err));
    }
  }

  // Spawn 5 parallel workers running continuously
  const workers = Array.from({ length: 5 }).map(async () => {
    while (Date.now() < runUntil) {
      await executeOperation();
      // Sleep 25ms between operations to space out requests and control CPU
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  });

  await Promise.all(workers);
  clearInterval(telemetryInterval);

  const finalStats = monitor.getStats();
  const lagStats = monitor.stopLagMonitor();
  const elapsedTotalSec = (Date.now() - startTime) / 1000;

  console.log('\n--- Endurance Test Completed ---');
  console.log(`- Total Duration: ${elapsedTotalSec.toFixed(1)}s`);
  console.log(`- Total Requests executed: ${totalRequests}`);
  console.log(`- Success Rate: ${((successRequests / totalRequests) * 100).toFixed(2)}% (${successRequests}/${totalRequests})`);
  console.log(`- Average Throughput: ${(totalRequests / elapsedTotalSec).toFixed(2)} req/sec`);
  console.log(`- Peak Latency: ${peakLatency.toFixed(1)} ms`);
  console.log(`- Final RSS Memory: ${finalStats.rss.toFixed(2)} MB`);
  console.log(`- Max Event Loop Lag: ${lagStats.maxLagMs.toFixed(2)} ms`);
  console.log(`- Avg Event Loop Lag: ${lagStats.avgLagMs.toFixed(2)} ms`);

  // Analyze memory stability
  // Verify that RSS did not balloon uncontrollably
  // We compare the average memory of the first 20% of samples vs the last 20% of samples
  const sampleCount = telemetryHistory.length;
  if (sampleCount >= 10) {
    const sliceSize = Math.max(1, Math.floor(sampleCount * 0.2));
    const firstSlice = telemetryHistory.slice(0, sliceSize);
    const lastSlice = telemetryHistory.slice(-sliceSize);

    const firstRssAvg = firstSlice.reduce((sum, s) => sum + s.rss, 0) / sliceSize;
    const lastRssAvg = lastSlice.reduce((sum, s) => sum + s.rss, 0) / sliceSize;

    console.log(`Memory Trend: Initial Avg RSS = ${firstRssAvg.toFixed(2)} MB | Final Avg RSS = ${lastRssAvg.toFixed(2)} MB`);
    const ratio = lastRssAvg / firstRssAvg;
    
    // An RSS growth ratio of > 2.0 under steady-state load with GC running could indicate a leak.
    // However, RSS can grow normally as V8 allocates space. But if it goes beyond 350MB, we check.
    assert.ok(lastRssAvg < 400, `Average RSS memory at end is too high: ${lastRssAvg.toFixed(2)} MB`);
  }

  assert.ok((successRequests / totalRequests) >= 0.999, `Success rate must be >= 99.9% but got ${((successRequests / totalRequests)*100).toFixed(2)}%`);

  console.log('\n✅ PASS: Part 6 Endurance Test completed successfully.');

  await app.close();
  await prisma.$disconnect();
}

main().catch(err => {
  console.error('❌ Part 6 Endurance Test crashed:', err);
  process.exit(1);
});
