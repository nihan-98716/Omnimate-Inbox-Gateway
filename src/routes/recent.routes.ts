import { FastifyInstance } from 'fastify';
import { listRecents } from '../controllers/recent.controller';

/**
 * Registry of Recents REST routes
 */
export async function recentRoutes(fastify: FastifyInstance) {
  fastify.get('/recents', listRecents);
}
