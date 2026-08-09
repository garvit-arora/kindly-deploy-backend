-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "containerPort" INTEGER,
ADD COLUMN     "hostPort" INTEGER,
ADD COLUMN     "localUrl" TEXT;
