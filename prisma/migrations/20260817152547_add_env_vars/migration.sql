-- CreateEnum
CREATE TYPE "BuildStrategy" AS ENUM ('DOCKERFILE', 'NODE_FRONTEND', 'NODE_BACKEND');

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "buildStrategy" "BuildStrategy" NOT NULL DEFAULT 'DOCKERFILE',
ALTER COLUMN "dockerfilePath" DROP NOT NULL,
ALTER COLUMN "dockerfilePath" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "buildStrategy" "BuildStrategy" NOT NULL DEFAULT 'DOCKERFILE';

-- CreateTable
CREATE TABLE "EnvironmentVariable" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvironmentVariable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EnvironmentVariable_projectId_idx" ON "EnvironmentVariable"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentVariable_projectId_key_key" ON "EnvironmentVariable"("projectId", "key");

-- AddForeignKey
ALTER TABLE "EnvironmentVariable" ADD CONSTRAINT "EnvironmentVariable_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
