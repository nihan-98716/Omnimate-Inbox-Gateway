import { FastifyInstance } from 'fastify';
import { ingestAsset, listInbox, updateAssetState } from '../controllers/inbox.controller';

/**
 * Registry of Inbox REST routes
 */
export async function inboxRoutes(fastify: FastifyInstance) {
  fastify.post('/inbox', ingestAsset);
  fastify.get('/inbox', listInbox);
  fastify.patch('/inbox/:id/state', updateAssetState);
}
