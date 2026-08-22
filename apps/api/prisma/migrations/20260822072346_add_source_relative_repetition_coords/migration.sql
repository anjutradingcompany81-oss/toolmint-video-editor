-- AlterTable
ALTER TABLE "repetition_results" ADD COLUMN     "sourceOriginalEndMs" INTEGER,
ADD COLUMN     "sourceOriginalStartMs" INTEGER,
ADD COLUMN     "sourceRepeatedEndMs" INTEGER,
ADD COLUMN     "sourceRepeatedStartMs" INTEGER;
