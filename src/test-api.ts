import app from './app';
import { prisma } from './services/db';
import assert from 'assert';

async function testApi() {
  console.log('📡 Starting Phase 4 API Verification...\n');

  try {
    await prisma.$connect();
    await prisma.asset.deleteMany({});

    const address = await app.listen({ port: 3001, host: '127.0.0.1' });
    console.log(`✅ Test server listening at ${address}`);

    // 1. Test Unauthenticated request (Should fail with 401)
    const unauthorizedRes = await fetch('http://127.0.0.1:3001/api/v1/inbox');
    assert.strictEqual(unauthorizedRes.status, 401, 'GET /inbox without auth header returns 401');

    // 2. Test Invalid Token request (Should fail with 401)
    const invalidRes = await fetch('http://127.0.0.1:3001/api/v1/inbox', {
      headers: { 'Authorization': 'Bearer invalid-token' }
    });
    assert.strictEqual(invalidRes.status, 401, 'GET /inbox with invalid token returns 401');

    // 3. Test Authenticated request (Should succeed with 200)
    const response = await fetch('http://127.0.0.1:3001/api/v1/inbox', {
      headers: { 'Authorization': 'Bearer test-api-key' }
    });
    assert.strictEqual(response.status, 200, 'GET /inbox returns status code 200 with valid key');

    const body = await response.json() as any;
    assert.ok(Array.isArray(body.data), 'Payload returns data array');
    assert.strictEqual(body.data.length, 0, 'Inbox data is initially empty');
    assert.strictEqual(body.pagination.limit, 20, 'Default page limit matches 20');
    assert.strictEqual(body.pagination.hasNextPage, false, 'hasNextPage flag returns false');

    console.log('✅ PASS: GET /api/v1/inbox works and adheres to standard API specs.');
  } catch (err) {
    console.error('❌ API Verification Failed:', err);
    process.exit(1);
  } finally {
    await app.close();
    await prisma.$disconnect();
    console.log('👋 Test server closed cleanly.\n');
  }
}

testApi();
