import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../services/db';
import { PresetType } from '@prisma/client';
import { z } from 'zod';

// Zod validation schema for creating presets
const createPresetSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.nativeEnum(PresetType),
  config: z.record(z.string(), z.any())
});

/**
 * Create a new Destination Preset config
 */
export async function createPreset(req: FastifyRequest, reply: FastifyReply) {
  try {
    const body = createPresetSchema.parse(req.body);

    // Contextual config validation
    if (body.type === PresetType.LOCAL_FOLDER) {
      if (!body.config.destination_path || typeof body.config.destination_path !== 'string') {
        return reply.status(400).send({
          error: "LOCAL_FOLDER presets require a 'destination_path' string inside the config object"
        });
      }
    } else if (body.type === PresetType.WEBHOOK) {
      if (!body.config.url || typeof body.config.url !== 'string') {
        return reply.status(400).send({
          error: "WEBHOOK presets require a valid HTTP 'url' string inside the config object"
        });
      }
    }

    const preset = await prisma.destinationPreset.create({
      data: {
        name: body.name,
        type: body.type,
        config: body.config as any,
        schemaVersion: 1
      }
    });

    return reply.status(201).send(preset);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: err.issues });
    }
    console.error('❌ Preset Creation Error:', err);
    return reply.status(500).send({ error: 'Internal server error while creating preset' });
  }
}

/**
 * List all active destination presets
 */
export async function listPresets(req: FastifyRequest, reply: FastifyReply) {
  try {
    const presets = await prisma.destinationPreset.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' }
    });
    return reply.send(presets);
  } catch (err: any) {
    console.error('❌ List Presets Error:', err);
    return reply.status(500).send({ error: 'Internal server error while listing presets' });
  }
}

/**
 * Deactivates (soft-deletes) a preset
 */
export async function deletePreset(req: FastifyRequest, reply: FastifyReply) {
  const params = req.params as any;
  const id = params.id;

  try {
    const preset = await prisma.destinationPreset.findUnique({
      where: { id }
    });

    if (!preset) {
      return reply.status(404).send({ error: 'Preset not found' });
    }

    // Deactivate instead of physical delete to preserve historical database links on archived assets
    const updated = await prisma.destinationPreset.update({
      where: { id },
      data: { isActive: false }
    });

    return reply.send({
      message: 'Preset successfully deactivated',
      preset: updated
    });
  } catch (err: any) {
    console.error('❌ Deactivate Preset Error:', err);
    return reply.status(500).send({ error: 'Internal server error while deactivating preset' });
  }
}
