import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { config } from './config';
import { inboxRoutes } from './routes/inbox.routes';
import { recentRoutes } from './routes/recent.routes';
import { presetRoutes } from './routes/preset.routes';
import { getPrometheusMetrics, recordMetricRequest } from './controllers/metrics.controller';
import { getOverallHealth, getDbHealth, getStorageHealth, getQueueHealth } from './controllers/health.controller';
import { webhookWorker, webhookQueue, connection } from './services/queue.service';

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug'
  }
});

app.register(cors, {
  origin: '*'
});

if (config.NODE_ENV !== 'test') {
  app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    skipOnError: true
  });
}

app.register(multipart, {
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

app.addHook('onResponse', async (request, reply) => {
  recordMetricRequest(reply.elapsedTime);
});

app.addHook('preHandler', async (request, reply) => {
  const url = request.raw.url || '';
  
  const requiresAuth = url.startsWith('/api/v1/') || url.startsWith('/metrics') || url.startsWith('/health');
  if (!requiresAuth || url.includes('/test-webhook')) {
    return;
  }
  
  const authHeader = request.headers['authorization'];
  const apiKeyHeader = request.headers['x-api-key'];
  const expectedKey = config.API_KEY;
  
  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (apiKeyHeader) {
    token = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  }
  
  if (token !== expectedKey) {
    return reply.status(401).send({ error: 'Unauthorized: Invalid API key' });
  }
});

app.register(
  async (api) => {
    await api.register(inboxRoutes);
    await api.register(recentRoutes);
    await api.register(presetRoutes);
  },
  { prefix: '/api/v1' }
);

app.get('/health', getOverallHealth);
app.get('/health/db', getDbHealth);
app.get('/health/storage', getStorageHealth);
app.get('/health/queue', getQueueHealth);

app.get('/metrics', getPrometheusMetrics);

// Graceful hook to shut down BullMQ / Redis connections when Fastify closes (e.g. in test suites)
app.addHook('onClose', async (instance) => {
  try {
    await webhookWorker.close();
    await webhookQueue.close();
    await connection.quit();
    instance.log.info('🔌 Closed BullMQ worker, queue, and Redis client connections.');
  } catch (err) {
    instance.log.error(err, '❌ Error closing BullMQ/Redis connections on Fastify onClose:');
  }
});

app.setErrorHandler((error: any, request, reply) => {
  request.log.error(error);

  if (error.statusCode) {
    return reply.status(error.statusCode).send({ error: error.message });
  }

  return reply.status(500).send({ error: 'Internal server error occurred' });
});

export default app;
