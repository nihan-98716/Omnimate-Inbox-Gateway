import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../services/db';
import { webhookQueue } from '../services/queue.service';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

export async function getOverallHealth(req: FastifyRequest, reply: FastifyReply) {
  const dbOk = await checkDbHealth();
  const storageOk = await checkStorageHealth();
  const queueOk = await checkQueueHealth();

  const isHealthy = dbOk && storageOk && queueOk;
  return reply.status(isHealthy ? 200 : 500).send({
    status: isHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    services: {
      database: dbOk ? 'healthy' : 'unhealthy',
      storage: storageOk ? 'healthy' : 'unhealthy',
      queue: queueOk ? 'healthy' : 'unhealthy',
    }
  });
}

export async function getDbHealth(req: FastifyRequest, reply: FastifyReply) {
  const dbOk = await checkDbHealth();
  return reply.status(dbOk ? 200 : 500).send({
    service: 'database',
    status: dbOk ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString()
  });
}

export async function getStorageHealth(req: FastifyRequest, reply: FastifyReply) {
  const storageOk = await checkStorageHealth();
  return reply.status(storageOk ? 200 : 500).send({
    service: 'storage',
    status: storageOk ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString()
  });
}

export async function getQueueHealth(req: FastifyRequest, reply: FastifyReply) {
  const queueOk = await checkQueueHealth();
  return reply.status(queueOk ? 200 : 500).send({
    service: 'queue',
    status: queueOk ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString()
  });
}

async function checkDbHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    console.error('Database health check failed:', err);
    return false;
  }
}

async function checkStorageHealth(): Promise<boolean> {
  try {
    const uploadPath = path.resolve(config.UPLOAD_DIR);
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    const tempFile = path.join(uploadPath, `health-${Date.now()}.txt`);
    fs.writeFileSync(tempFile, 'health check');
    fs.unlinkSync(tempFile);
    return true;
  } catch (err) {
    console.error('Storage health check failed:', err);
    return false;
  }
}

async function checkQueueHealth(): Promise<boolean> {
  try {
    const client = await webhookQueue.client;
    await client.ping();
    return true;
  } catch (err) {
    console.error('Queue health check failed:', err);
    return false;
  }
}
