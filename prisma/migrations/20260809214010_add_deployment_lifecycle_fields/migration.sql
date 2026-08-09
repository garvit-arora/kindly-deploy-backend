-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "stoppedAt" TIMESTAMP(3),
ADD COLUMN     "supersededAt" TIMESTAMP(3);
