-- CreateEnum
CREATE TYPE "VoiceScanScope" AS ENUM ('CLIP', 'TIMELINE');

-- CreateEnum
CREATE TYPE "VoiceScanStatus" AS ENUM ('QUEUED', 'EXTRACTING_AUDIO', 'DETECTING_SPEECH', 'TRANSCRIBING', 'DIARIZING', 'COMPARING', 'PREPARING_SUGGESTIONS', 'COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED');

-- CreateEnum
CREATE TYPE "SensitivityPreset" AS ENUM ('LOW', 'BALANCED', 'HIGH', 'CUSTOM');

-- CreateEnum
CREATE TYPE "RepetitionKind" AS ENUM ('WORD', 'PHRASE', 'SENTENCE', 'CLIP_OVERLAP', 'SCENE_JOIN', 'RENDER_DUPLICATE');

-- CreateEnum
CREATE TYPE "ConfidenceBucket" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "CorrectionMode" AS ENUM ('AUDIO_ONLY', 'AUDIO_VIDEO_TRIM');

-- CreateEnum
CREATE TYPE "RepetitionReviewStatus" AS ENUM ('PENDING', 'APPLIED', 'DISMISSED');

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN     "transcriptCache" JSONB;

-- CreateTable
CREATE TABLE "voice_scan_jobs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "scope" "VoiceScanScope" NOT NULL,
    "trackId" TEXT,
    "clipId" TEXT,
    "status" "VoiceScanStatus" NOT NULL DEFAULT 'QUEUED',
    "stageLabel" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "sensitivityPreset" "SensitivityPreset" NOT NULL DEFAULT 'BALANCED',
    "customThresholds" JSONB,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "pauseRequested" BOOLEAN NOT NULL DEFAULT false,
    "checkpoint" JSONB,
    "errorMessage" TEXT,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "voice_scan_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repetition_results" (
    "id" TEXT NOT NULL,
    "voiceScanJobId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "kind" "RepetitionKind" NOT NULL,
    "originalStartMs" INTEGER NOT NULL,
    "originalEndMs" INTEGER NOT NULL,
    "repeatedStartMs" INTEGER NOT NULL,
    "repeatedEndMs" INTEGER NOT NULL,
    "originalText" TEXT NOT NULL,
    "repeatedText" TEXT NOT NULL,
    "speakerLabel" TEXT,
    "transcriptSimilarity" DOUBLE PRECISION NOT NULL,
    "audioSimilarity" DOUBLE PRECISION NOT NULL,
    "timingGapMs" INTEGER NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "confidenceBucket" "ConfidenceBucket" NOT NULL,
    "suggestedMode" "CorrectionMode" NOT NULL,
    "status" "RepetitionReviewStatus" NOT NULL DEFAULT 'PENDING',
    "appliedMode" "CorrectionMode",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repetition_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_scan_jobs_projectId_createdAt_idx" ON "voice_scan_jobs"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "repetition_results_voiceScanJobId_idx" ON "repetition_results"("voiceScanJobId");

-- CreateIndex
CREATE INDEX "repetition_results_mediaAssetId_idx" ON "repetition_results"("mediaAssetId");

-- AddForeignKey
ALTER TABLE "voice_scan_jobs" ADD CONSTRAINT "voice_scan_jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repetition_results" ADD CONSTRAINT "repetition_results_voiceScanJobId_fkey" FOREIGN KEY ("voiceScanJobId") REFERENCES "voice_scan_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repetition_results" ADD CONSTRAINT "repetition_results_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
