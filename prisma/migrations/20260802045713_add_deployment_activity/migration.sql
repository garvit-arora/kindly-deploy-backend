-- CreateEnum
CREATE TYPE "DeploymentActivityType" AS ENUM ('DEPLOYMENT_CREATED', 'STATUS_CHANGED', 'BUILD_STARTED', 'BUILD_COMPLETED', 'BUILD_FAILED');

-- CreateTable
CREATE TABLE "DeploymentActivity" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "type" "DeploymentActivityType" NOT NULL,
    "fromStatus" "DeploymentStatus",
    "toStatus" "DeploymentStatus",
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeploymentActivity_deploymentId_createdAt_idx" ON "DeploymentActivity"("deploymentId", "createdAt");

-- CreateIndex
CREATE INDEX "DeploymentActivity_actorUserId_idx" ON "DeploymentActivity"("actorUserId");

-- AddForeignKey
ALTER TABLE "DeploymentActivity" ADD CONSTRAINT "DeploymentActivity_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentActivity" ADD CONSTRAINT "DeploymentActivity_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
