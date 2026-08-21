-- CreateEnum
CREATE TYPE "ExportQuality" AS ENUM ('STANDARD', 'HIGH', 'MAXIMUM');

-- AlterEnum
ALTER TYPE "ExportResolution" ADD VALUE 'ORIGINAL';

-- AlterEnum
ALTER TYPE "ExportStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "export_jobs" DROP COLUMN "sceneId",
ADD COLUMN     "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "outputFileName" TEXT,
ADD COLUMN     "quality" "ExportQuality" NOT NULL DEFAULT 'STANDARD';

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN     "hasAudio" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "projects" DROP COLUMN "aspectRatio",
DROP COLUMN "customHeight",
DROP COLUMN "customWidth";

-- DropEnum
DROP TYPE "ProjectAspectRatio";

