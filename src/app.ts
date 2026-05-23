import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { inboxRoutes } from './routes/inbox.routes';
import { recentRoutes } from './routes/recent.routes';

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug'
  }
});

// Register CORS
app.register(cors, {
  origin: '*'
});

// Register Fastify Multipart plugin to handle streaming file uploads (100MB limit)
app.register(multipart, {
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

// Register API routing pipelines
app.register(
  async (api) => {
    await api.register(inboxRoutes);
    await api.register(recentRoutes);
  },
  { prefix: '/api/v1' }
);

// Global exception interceptor
app.setErrorHandler((error: any, request, reply) => {
  request.log.error(error);

  if (error.statusCode) {
    return reply.status(error.statusCode).send({ error: error.message });
  }

  return reply.status(500).send({ error: 'Internal server error occurred' });
});

export default app;
