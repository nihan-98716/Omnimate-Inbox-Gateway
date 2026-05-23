import app from './app';
import { prisma } from './services/db';
import assert from 'assert';

async function testApi() {
  console.log('📡 Starting Phase 4 API Verification...\n');

  try {
    // 1. Setup DB connection and empty the Asset table
    await prisma.$connect();
    await prisma.asset.deleteMany({});

    // 2. Start the Fastify listener on a test port
    const address = await app.listen({ port: 3001, host: '127.0.0.1' });
    console.log(`✅ Test server listening at ${address}`);

    // 3. Query the GET /api/v1/inbox listing endpoint
    const response = await fetch('http://127.0.0.1:3001/api/v1/inbox');
    assert.strictEqual(response.status, 200, 'GET /inbox returns status code 200');

    // 4. Verify properties and structure
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
    // 5. Gracefully tear down
    await app.close();
    await prisma.$disconnect();
    console.log('👋 Test server closed cleanly.\n');
  }
}

testApi();
