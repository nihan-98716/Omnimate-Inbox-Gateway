import fs from 'fs';
import crypto from 'crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../services/db';
import { AssetState, AssetType } from '@prisma/client';
import { storageService } from '../services/storage.service';
import { calculateStreamHash } from '../utils/hash';
import { isValidTransition, getStateHookUpdate } from '../utils/state-machine';
import { presetService } from '../services/preset.service';

/**
 * Ingest an incoming file upload from Scanbox or Shots
 */
export async function ingestAsset(req: FastifyRequest, reply: FastifyReply) {
  const fileData = await req.file();
  if (!fileData) {
    return reply.status(400).send({ error: 'Missing uploaded file' });
  }

  const fields = fileData.fields as any;
  const source = fields.source?.value || 'unknown';
  const title = fields.title?.value || fileData.filename;

  const tempKey = `tmp-${crypto.randomUUID()}`;
  let calculatedHash = '';
  let permanentKey = '';

  try {
    // 1. Stage the file in the temporary folder
    await storageService.saveToTemp(tempKey, fileData.file);

    // 2. Read staged file to calculate SHA-256 and byte size
    const tempPath = storageService.getFilePath(`tmp/${tempKey}`);
    const fileStream = fs.createReadStream(tempPath);
    const { hash, size } = await calculateStreamHash(fileStream);
    calculatedHash = hash;

    // 3. Checksum Deduplication Lookup
    const existingAsset = await prisma.asset.findUnique({
      where: { checksum: hash }
    });

    if (existingAsset) {
      // Clean up the temporary staged file (duplicate upload)
      await storageService.deleteTemp(tempKey);

      // If matched asset was soft-deleted, restore it to PROCESS_NOW
      if (existingAsset.state === AssetState.DELETED) {
        const restored = await prisma.asset.update({
          where: { id: existingAsset.id },
          data: {
            state: AssetState.PROCESS_NOW,
            deletedAt: null
          }
        });
        return reply.status(200).send(restored);
      }

      // Return existing baseline asset record
      return reply.status(200).send(existingAsset);
    }

    // 4. Map MIME types to AssetTypes
    let type: AssetType = AssetType.OTHER;
    const mime = fileData.mimetype.toLowerCase();
    if (mime.startsWith('image/')) {
      type = source.toLowerCase() === 'shots' ? AssetType.SCREENSHOT : AssetType.IMAGE;
    } else if (mime === 'application/pdf') {
      type = AssetType.PDF;
    } else if (mime.startsWith('text/')) {
      type = AssetType.TEXT;
    }

    // 5. Generate permanent storage path and keys
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const cleanFilename = fileData.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    permanentKey = `assets/${year}/${month}/${day}/${hash}-${cleanFilename}`;

    // 6. Promote staged file to its permanent location
    await storageService.moveToPermanent(tempKey, permanentKey);

    // 7. Write to PostgreSQL
    const asset = await prisma.asset.create({
      data: {
        title,
        type,
        source,
        state: AssetState.PROCESS_NOW,
        fileKey: permanentKey,
        fileSize: size,
        mimeType: fileData.mimetype,
        checksum: hash
      }
    });

    return reply.status(201).send(asset);
  } catch (err: any) {
    // Fail-safe cleanup: prevent staged file orphans
    await storageService.deleteTemp(tempKey);

    // Clean up permanent file orphan if it was already moved
    if (err.code !== 'P2002' && permanentKey) {
      try {
        await storageService.deleteFile(permanentKey);
      } catch (cleanupErr) {
        req.log.error(cleanupErr, `⚠️ Failed to clean up permanent file orphan: ${permanentKey}`);
      }
    }

    // Handle race conditions where another thread inserted the same file at the same millisecond
    if (err.code === 'P2002' && calculatedHash) {
      req.log.warn(`⚠️ Ingestion DB conflict: unique constraint collision. Retrieving duplicate record for hash ${calculatedHash}`);
      try {
        const existing = await prisma.asset.findUnique({
          where: { checksum: calculatedHash }
        });
        if (existing) {
          return reply.status(200).send(existing);
        }
      } catch (innerErr) {
        req.log.error(innerErr, '❌ Error loading duplicate asset after constraint collision');
      }
    }

    console.error('❌ Ingestion Error:', err);
    return reply.status(500).send({ error: 'Internal server error during ingestion' });
  }
}

/**
 * Fetch inbox assets with cursor-based pagination
 */
export async function listInbox(req: FastifyRequest, reply: FastifyReply) {
  const query = req.query as any;
  const limit = Math.min(parseInt(query.limit) || 20, 100);
  const cursor = query.cursor; // Last seen asset ID for page navigation
  const typeFilter = query.type as AssetType | undefined;

  // Default listing filters for active inbox elements
  let statesList: AssetState[] = [AssetState.PROCESS_NOW, AssetState.SAVE_FOR_LATER];
  if (query.state) {
    statesList = String(query.state)
      .split(',')
      .map(s => s.trim().toUpperCase() as AssetState)
      .filter(s => Object.values(AssetState).includes(s));
  }

  try {
    let whereCondition: any = {
      state: { in: statesList }
    };

    if (typeFilter && Object.values(AssetType).includes(typeFilter)) {
      whereCondition.type = typeFilter;
    }

    // Compound tie-breaker cursor pagination
    if (cursor) {
      const cursorAsset = await prisma.asset.findUnique({
        where: { id: cursor },
        select: { createdAt: true }
      });

      if (cursorAsset) {
        whereCondition.OR = [
          {
            createdAt: { lt: cursorAsset.createdAt }
          },
          {
            createdAt: cursorAsset.createdAt,
            id: { lt: cursor }
          }
        ];
      }
    }

    // Fetch limit + 1 items to determine hasNextPage
    const assets = await prisma.asset.findMany({
      where: whereCondition,
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' }
      ],
      take: limit + 1
    });

    const hasNextPage = assets.length > limit;
    const paginatedAssets = hasNextPage ? assets.slice(0, limit) : assets;
    const nextCursor = paginatedAssets.length > 0 ? paginatedAssets[paginatedAssets.length - 1].id : null;

    return reply.send({
      data: paginatedAssets,
      pagination: {
        limit,
        nextCursor: hasNextPage ? nextCursor : null,
        hasNextPage
      }
    });
  } catch (err: any) {
    console.error('❌ Listing Error:', err);
    return reply.status(500).send({ error: 'Internal server error while fetching inbox assets' });
  }
}

/**
 * Handle triage state transitions and preset execution
 */
export async function updateAssetState(req: FastifyRequest, reply: FastifyReply) {
  const params = req.params as any;
  const body = req.body as any;

  const id = params.id;
  const newState = body.state as AssetState;
  const presetId = body.presetId;
  const executePreset = body.executePreset === true;

  if (!newState || !Object.values(AssetState).includes(newState)) {
    return reply.status(400).send({ error: 'Missing or invalid state parameter' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Acquire row lock to prevent race conditions during preset execution and state transition
      const assets = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM "Asset" WHERE id = $1 FOR UPDATE`,
        id
      );

      if (assets.length === 0) {
        return { status: 404, error: 'Asset not found' };
      }
      const dbAsset = assets[0];

      // 2. Validate state machine rules
      if (!isValidTransition(dbAsset.state as any, newState as any)) {
        return {
          status: 400,
          error: `Illegal state transition from ${dbAsset.state} to ${newState}`
        };
      }

      const hookUpdate = getStateHookUpdate(newState as any);
      let metadataUpdate = (dbAsset.metadata as Record<string, any>) || {};

      // 3. Handle destination presets when archiving
      if (newState === AssetState.ARCHIVE && presetId) {
        const preset = await tx.destinationPreset.findUnique({
          where: { id: presetId, isActive: true }
        });

        if (!preset) {
          return { status: 400, error: 'Selected destination preset is inactive or missing' };
        }

        if (executePreset) {
          // Run preset action
          const execResult = await presetService.execute(dbAsset, preset);
          
          metadataUpdate = {
            ...metadataUpdate,
            presetExecution: execResult
          };

          // If execution fails, log it but block state transition to ARCHIVE
          if (!execResult.success) {
            const updated = await tx.asset.update({
              where: { id },
              data: { metadata: metadataUpdate }
            });
            return {
              status: 502,
              error: `Destination preset dispatch failed: ${execResult.error}`,
              asset: updated
            };
          }
        } else {
          // User links metadata without executing file copy
          metadataUpdate = {
            ...metadataUpdate,
            linkedPreset: {
              id: preset.id,
              name: preset.name,
              type: preset.type
            }
          };
        }
      }

      // 4. Execute database update
      const updatedAsset = await tx.asset.update({
        where: { id },
        data: {
          state: newState,
          metadata: metadataUpdate,
          ...hookUpdate
        }
      });

      return { status: 200, asset: updatedAsset };
    });

    if (result.status === 200) {
      return reply.send(result.asset);
    } else if (result.status === 502) {
      return reply.status(502).send({ error: result.error, asset: result.asset });
    } else {
      return reply.status(result.status).send({ error: result.error });
    }
  } catch (err: any) {
    console.error('❌ State Update Error:', err);
    return reply.status(500).send({ error: 'Internal server error while updating asset state' });
  }
}

