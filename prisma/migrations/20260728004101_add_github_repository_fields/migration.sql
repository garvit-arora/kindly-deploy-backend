-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "githubInstallationId" TEXT,
ADD COLUMN     "githubRepositoryFullName" TEXT,
ADD COLUMN     "githubRepositoryId" TEXT;

-- CreateIndex
CREATE INDEX "Project_githubInstallationId_githubRepositoryId_idx" ON "Project"("githubInstallationId", "githubRepositoryId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_githubInstallationId_fkey" FOREIGN KEY ("githubInstallationId") REFERENCES "GithubInstallation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
