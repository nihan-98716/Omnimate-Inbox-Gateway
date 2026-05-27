import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { prisma } from './db';
import { presetService } from './preset.service';
import { AssetState, JobStatus } from '@prisma/client';

export const connection = new IORedis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  maxRetriesPerRequest: null,
});

export const webhookQueue = new Queue('webhook-queue', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

export const webhookWorker = new Worker(
  'webhook-queue',
  async (job: Job) => {
    const { assetId, presetId } = job.data;
    
    // Update presetStatus to PROCESSING
    await prisma.asset.update({
      where: { id: assetId },
      data: { presetStatus: JobStatus.PROCESSING }
    });

    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    const preset = await prisma.destinationPreset.findUnique({ where: { id: presetId } });

    if (!asset) {
      throw new Error(`Asset not found: ${assetId}`);
    }
    if (!preset) {
      throw new Error(`Preset not found: ${presetId}`);
    }

    const result = await presetService.execute(asset, preset);

    if (!result.success) {
      throw new Error(result.error || 'Preset execution failed');
    }

    // Success: State changes to ARCHIVE, presetStatus to COMPLETED
    await prisma.asset.update({
      where: { id: assetId },
      data: {
        state: AssetState.ARCHIVE,
        presetStatus: JobStatus.COMPLETED,
        presetError: null,
        metadata: {
          ...(asset.metadata as any || {}),
          presetExecution: result
        }
      }
    });

    return result;
  },
  {
    connection,
    concurrency: config.WEBHOOK_CONCURRENCY,
  }
);

webhookWorker.on('failed', async (job, err) => {
  if (job) {
    const attempts = job.opts.attempts || 5;
    if (job.attemptsMade >= attempts) {
      const { assetId } = job.data;
      try {
        const asset = await prisma.asset.findUnique({ where: { id: assetId } });
        const metadataUpdate = {
          ...(asset?.metadata as any || {}),
          presetExecution: {
            success: false,
            executedAt: new Date().toISOString(),
            error: err.message || String(err)
          }
        };

        await prisma.asset.update({
          where: { id: assetId },
          data: {
            presetStatus: JobStatus.FAILED,
            presetError: err.message || String(err),
            metadata: metadataUpdate
          }
        });
        console.error(`❌ BullMQ job ${job.id} for asset ${assetId} failed definitively:`, err);
      } catch (innerErr) {
        console.error(`❌ Failed to update asset ${assetId} after final job failure:`, innerErr);
      }
    } else {
      console.warn(`⚠️ BullMQ job ${job.id} failed attempt ${job.attemptsMade}/${attempts}, retrying...`);
    }
  }
});

webhookWorker.on('error', (err) => {
  console.error('❌ BullMQ worker encountered an error:', err);
});
