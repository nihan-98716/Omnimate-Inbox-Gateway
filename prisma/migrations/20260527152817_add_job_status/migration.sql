-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROCESSING', 'FAILED', 'COMPLETED');

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "presetError" TEXT,
ADD COLUMN     "presetStatus" "JobStatus";
