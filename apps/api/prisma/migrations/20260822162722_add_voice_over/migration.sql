-- CreateEnum
CREATE TYPE "VoiceOverStatus" AS ENUM ('QUEUED', 'SYNTHESIZING', 'MIXING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "voice_over_scripts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "providerId" TEXT,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_over_scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_over_jobs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "VoiceOverStatus" NOT NULL DEFAULT 'QUEUED',
    "stageLabel" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "providerId" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "lineTimings" JSONB,
    "resultMediaAssetId" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "voice_over_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_over_scripts_projectId_key" ON "voice_over_scripts"("projectId");

-- CreateIndex
CREATE INDEX "voice_over_jobs_projectId_createdAt_idx" ON "voice_over_jobs"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "voice_over_scripts" ADD CONSTRAINT "voice_over_scripts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_over_jobs" ADD CONSTRAINT "voice_over_jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
