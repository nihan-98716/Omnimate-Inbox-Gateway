import app from './app';
import { prisma } from './services/db';
import { AssetState, AssetType } from '@prisma/client';
import assert from 'assert';

async function runTransitionsTests() {
  console.log('📡 Starting State Transitions and API pagination verification...\n');

  try {
    // 1. Setup DB connection and empty the Asset table
    await prisma.$connect();
    await prisma.asset.deleteMany({});

    // 2. Start the Fastify listener on a test port
    const address = await app.listen({ port: 3002, host: '127.0.0.1' });
    console.log(`✅ Test server running at ${address}`);

    // -------------------------------------------------------------
    // Test Case 1: Cursor Pagination Verification
    // -------------------------------------------------------------
    console.log('\n--- Test Case 1: Cursor Pagination Verification ---');
    
    // Create 5 assets with incremental timestamps (to test DESC sorting)
    const baseTime = Date.now();
    const assets = [];
    for (let i = 1; i <= 5; i++) {
      const asset = await prisma.asset.create({
        data: {
          title: `Asset ${i}`,
          type: AssetType.TEXT,
          source: 'test',
          state: AssetState.PROCESS_NOW,
          fileKey: `assets/test-${i}.txt`,
          fileSize: 100,
          mimeType: 'text/plain',
          checksum: `checksum-hash-${i}-${baseTime}`,
          createdAt: new Date(baseTime + i * 1000) // Spaced by 1 second
        }
      });
      assets.push(asset);
    }
    console.log('✅ Created 5 mock assets spaced 1 second apart.');

    // Fetch Page 1 (Limit = 2) - should return Asset 5 and Asset 4
    let res = await fetch('http://127.0.0.1:3002/api/v1/inbox?limit=2');
    let body = await res.json() as any;
    assert.strictEqual(body.data.length, 2, 'Page 1 size is 2');
    assert.strictEqual(body.data[0].title, 'Asset 5', 'Page 1 first item is Asset 5');
    assert.strictEqual(body.data[1].title, 'Asset 4', 'Page 1 second item is Asset 4');
    assert.ok(body.pagination.nextCursor, 'Page 1 returns nextCursor');
    assert.strictEqual(body.pagination.hasNextPage, true, 'Page 1 hasNextPage is true');

    const cursor1 = body.pagination.nextCursor;

    // Fetch Page 2 (Limit = 2) - should return Asset 3 and Asset 2
    res = await fetch(`http://127.0.0.1:3002/api/v1/inbox?limit=2&cursor=${cursor1}`);
    body = await res.json() as any;
    assert.strictEqual(body.data.length, 2, 'Page 2 size is 2');
    assert.strictEqual(body.data[0].title, 'Asset 3', 'Page 2 first item is Asset 3');
    assert.strictEqual(body.data[1].title, 'Asset 2', 'Page 2 second item is Asset 2');
    assert.ok(body.pagination.nextCursor, 'Page 2 returns nextCursor');
    assert.strictEqual(body.pagination.hasNextPage, true, 'Page 2 hasNextPage is true');

    const cursor2 = body.pagination.nextCursor;

    // Fetch Page 3 (Limit = 2) - should return Asset 1
    res = await fetch(`http://127.0.0.1:3002/api/v1/inbox?limit=2&cursor=${cursor2}`);
    body = await res.json() as any;
    assert.strictEqual(body.data.length, 1, 'Page 3 size is 1');
    assert.strictEqual(body.data[0].title, 'Asset 1', 'Page 3 item is Asset 1');
    assert.strictEqual(body.pagination.nextCursor, null, 'Page 3 nextCursor is null');
    assert.strictEqual(body.pagination.hasNextPage, false, 'Page 3 hasNextPage is false');

    console.log('✅ PASS: Cursor pagination matches descending date sorting and tie-breakers.');

    // -------------------------------------------------------------
    // Test Case 2: Allowed Transitions
    // -------------------------------------------------------------
    console.log('\n--- Test Case 2: Allowed Transitions ---');
    const assetId = assets[0].id; // Asset 1

    // PROCESS_NOW -> SAVE_FOR_LATER
    res = await fetch(`http://127.0.0.1:3002/api/v1/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.SAVE_FOR_LATER })
    });
    body = await res.json() as any;
    assert.strictEqual(res.status, 200, 'PATCH state returns 200 OK');
    assert.strictEqual(body.state, AssetState.SAVE_FOR_LATER, 'State updated to SAVE_FOR_LATER');

    // SAVE_FOR_LATER -> ARCHIVE
    res = await fetch(`http://127.0.0.1:3002/api/v1/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.ARCHIVE })
    });
    body = await res.json() as any;
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.state, AssetState.ARCHIVE, 'State updated to ARCHIVE');

    // ARCHIVE -> DELETED
    res = await fetch(`http://127.0.0.1:3002/api/v1/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.DELETED })
    });
    body = await res.json() as any;
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.state, AssetState.DELETED, 'State updated to DELETED');
    assert.ok(body.deletedAt, 'deletedAt property populated');

    // DELETED -> PROCESS_NOW (Restore)
    res = await fetch(`http://127.0.0.1:3002/api/v1/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.PROCESS_NOW })
    });
    body = await res.json() as any;
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.state, AssetState.PROCESS_NOW, 'State successfully restored to PROCESS_NOW');
    assert.strictEqual(body.deletedAt, null, 'deletedAt property correctly reset to null');

    console.log('✅ PASS: Allowed transitions validation engine.');

    // -------------------------------------------------------------
    // Test Case 3: Invalid Transitions Rejected
    // -------------------------------------------------------------
    console.log('\n--- Test Case 3: Invalid Transitions Rejections ---');
    
    // First soft-delete the asset
    await fetch(`http://127.0.0.1:3002/api/v1/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.DELETED })
    });

    // Try invalid transition: DELETED -> ARCHIVE (should be rejected)
    res = await fetch(`http://127.0.0.1:3002/api/v1/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.ARCHIVE })
    });
    assert.strictEqual(res.status, 400, 'DELETED -> ARCHIVE is blocked (400)');

    // Restore to PROCESS_NOW, then archive
    await fetch(`http://127.0.0.1:3002/api/v1/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.PROCESS_NOW })
    });
    await fetch(`http://127.0.0.1:3002/api/v1/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.ARCHIVE })
    });

    // Try invalid transition: ARCHIVE -> SAVE_FOR_LATER (should be rejected)
    res = await fetch(`http://127.0.0.1:3002/api/v1/inbox/${assetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.SAVE_FOR_LATER })
    });
    assert.strictEqual(res.status, 400, 'ARCHIVE -> SAVE_FOR_LATER is blocked (400)');

    console.log('✅ PASS: Triage state machine successfully blocks illegal jumps.');

    // -------------------------------------------------------------
    // Test Case 4: Recents API & Expiry countdown
    // -------------------------------------------------------------
    console.log('\n--- Test Case 4: Recents API & Expiry countdown ---');
    
    // We already moved Asset 1 to ARCHIVE. Let's move Asset 2 to DELETED.
    const deletedAssetId = assets[1].id; // Asset 2
    await fetch(`http://127.0.0.1:3002/api/v1/inbox/${deletedAssetId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: AssetState.DELETED })
    });

    // Retrieve recents list
    res = await fetch('http://127.0.0.1:3002/api/v1/recents');
    body = await res.json() as any;
    
    assert.strictEqual(res.status, 200, 'GET /recents returns 200 OK');
    
    // Should contain Asset 2 (DELETED) and Asset 1 (ARCHIVE)
    const recentDeleted = body.data.find((item: any) => item.id === deletedAssetId);
    const recentArchived = body.data.find((item: any) => item.id === assetId);

    assert.ok(recentDeleted, 'Recents includes soft-deleted asset.');
    assert.ok(recentArchived, 'Recents includes archived asset.');
    
    // Verify countdown integer is 30 (since it was deleted just now)
    assert.strictEqual(recentDeleted.daysUntilPurge, 30, 'daysUntilPurge displays 30 days remaining.');
    assert.strictEqual(recentArchived.daysUntilPurge, null, 'archived assets show null countdown.');

    console.log('✅ PASS: Recents page output formats and soft-delete expiration values.');

  } catch (err) {
    console.error('❌ Transitions Verification Failed:', err);
    process.exit(1);
  } finally {
    // 5. Tear down
    await prisma.asset.deleteMany({});
    await app.close();
    await prisma.$disconnect();
    console.log('\n👋 Verification server closed cleanly.\n');
  }
}

runTransitionsTests();
