import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../services/db';
import { AssetState } from '@prisma/client';
import { config } from '../config';

/**
 * Lists recently processed (ARCHIVE) and soft-deleted (DELETED) assets
 */
export async function listRecents(req: FastifyRequest, reply: FastifyReply) {
  const query = req.query as any;
  const limit = Math.min(parseInt(query.limit) || 20, 100);
  const cursor = query.cursor;

  try {
    let whereCondition: any = {
      state: { in: [AssetState.ARCHIVE, AssetState.DELETED] }
    };

    // Build cursor navigation matching our tie-breaker sort
    if (cursor) {
      const cursorAsset = await prisma.asset.findUnique({
        where: { id: cursor },
        select: { updatedAt: true }
      });

      if (cursorAsset) {
        whereCondition.OR = [
          {
            updatedAt: { lt: cursorAsset.updatedAt }
          },
          {
            updatedAt: cursorAsset.updatedAt,
            id: { lt: cursor }
          }
        ];
      }
    }

    const assets = await prisma.asset.findMany({
      where: whereCondition,
      orderBy: [
        { updatedAt: 'desc' },
        { id: 'desc' }
      ],
      take: limit + 1
    });

    const hasNextPage = assets.length > limit;
    const paginatedAssets = hasNextPage ? assets.slice(0, limit) : assets;
    const nextCursor = paginatedAssets.length > 0 ? paginatedAssets[paginatedAssets.length - 1].id : null;

    const expireDays = config.EXPIRE_AFTER_DAYS;

    // Attach countdown calculations to deleted assets
    const data = paginatedAssets.map(asset => {
      let daysUntilPurge: number | null = null;

      if (asset.state === AssetState.DELETED && asset.deletedAt) {
        const msElapsed = Date.now() - asset.deletedAt.getTime();
        const daysElapsed = Math.floor(msElapsed / (1000 * 60 * 60 * 24));
        daysUntilPurge = Math.max(0, expireDays - daysElapsed);
      }

      return {
        ...asset,
        daysUntilPurge
      };
    });

    return reply.send({
      data,
      pagination: {
        limit,
        nextCursor: hasNextPage ? nextCursor : null,
        hasNextPage
      }
    });
  } catch (err: any) {
    console.error('❌ Recents Controller Error:', err);
    return reply.status(500).send({ error: 'Internal server error while fetching recent assets' });
  }
}
