-- CreateEnum
CREATE TYPE "AssetState" AS ENUM ('PROCESS_NOW', 'SAVE_FOR_LATER', 'ARCHIVE', 'DELETED');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('PDF', 'IMAGE', 'SCREENSHOT', 'TEXT', 'OTHER');

-- CreateEnum
CREATE TYPE "PresetType" AS ENUM ('LOCAL_FOLDER', 'WEBHOOK', 'S3');

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "AssetType" NOT NULL,
    "source" TEXT NOT NULL,
    "state" "AssetState" NOT NULL DEFAULT 'PROCESS_NOW',
    "fileKey" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DestinationPreset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PresetType" NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "config" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DestinationPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Asset_checksum_key" ON "Asset"("checksum");

-- CreateIndex
CREATE INDEX "Asset_state_idx" ON "Asset"("state");

-- CreateIndex
CREATE INDEX "Asset_createdAt_idx" ON "Asset"("createdAt");
