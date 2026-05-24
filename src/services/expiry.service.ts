import cron, { ScheduledTask } from 'node-cron';
import { PrismaClient, AssetState } from '@prisma/client';
import { storageService } from './storage.service';
import { config } from '../config';

export class ExpiryService {
  private prisma: PrismaClient;
  private task: ScheduledTask | null = null;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Starts the background cron daemon. Default execution: Every hour.
   */
  start(cronExpression: string = '0 * * * *') {
    if (this.task) {
      this.task.stop();
    }

    this.task = cron.schedule(cronExpression, async () => {
      console.log('🧹 Checking for expired soft-deleted assets...');
      try {
        await this.runCleanup();
      } catch (err) {
        console.error('❌ Expiry cleanup task failed:', err);
      }
    });

    console.log(`⏰ Expiry clean-up daemon scheduled using: "${cronExpression}"`);
  }

  /**
   * Stops the background cron daemon
   */
  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
  }

  /**
   * Queries expired soft-deletes and removes them from disk and database
   */
  async runCleanup(): Promise<void> {
    const daysLimit = config.EXPIRE_AFTER_DAYS;
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - daysLimit);

    // Query deleted assets where deletedAt is older than thresholdDate
    const expiredAssets = await this.prisma.asset.findMany({
      where: {
        state: AssetState.DELETED,
        deletedAt: {
          lte: thresholdDate
        }
      },
      select: {
        id: true,
        fileKey: true
      }
    });

    if (expiredAssets.length === 0) {
      return;
    }

    console.log(`🧹 Found ${expiredAssets.length} expired assets to hard-purge.`);

    // Loop through assets, delete file first, then the database record
    for (const asset of expiredAssets) {
      try {
        // Delete the physical file from disk
        await storageService.deleteFile(asset.fileKey);

        // Delete the database row
        await this.prisma.asset.delete({
          where: { id: asset.id }
        });
        console.log(`✅ Successfully purged asset ${asset.id} and file ${asset.fileKey}`);
      } catch (err) {
        console.error(`❌ Failed to purge expired asset ID ${asset.id}:`, err);
      }
    }
  }
}
