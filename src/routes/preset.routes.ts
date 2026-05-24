import { FastifyInstance } from 'fastify';
import { createPreset, listPresets, deletePreset } from '../controllers/preset.controller';

/**
 * Registry of Destination Preset REST routes
 */
export async function presetRoutes(fastify: FastifyInstance) {
  fastify.post('/presets', createPreset);
  fastify.get('/presets', listPresets);
  fastify.delete('/presets/:id', deletePreset);
}
