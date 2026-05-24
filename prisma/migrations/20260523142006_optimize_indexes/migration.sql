-- DropIndex
DROP INDEX "Asset_createdAt_idx";

-- DropIndex
DROP INDEX "Asset_state_idx";

-- CreateIndex
CREATE INDEX "Asset_state_createdAt_idx" ON "Asset"("state", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Asset_state_updatedAt_idx" ON "Asset"("state", "updatedAt" DESC);
