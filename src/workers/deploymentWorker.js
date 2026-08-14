require('dotenv').config()

const { Worker } = require('bullmq')
const fs = require('fs/promises')
const path = require('path')
const prisma = require('../lib/prisma')
const deploymentCleanupQueue = require('../queues/deploymentCleanupQueue')
const {
  stopSupersededDeploymentContainer,
} = require('../services/deploymentCleanup.service')
const { downloadRepository } = require('../utils/downloadRepository')
const { waitForHttpHealth } = require('../utils/healthCheck')
const takeScreenshot = require('../utils/takeScreenshot')
const { uploadDeploymentScreenshot } = require('../utils/imagekit')
const {
  runDockerBuild,
  runDockerContainer,
  inspectDockerContainer,
  getDockerHostPort,
  followDockerContainerLogs,
} = require('../utils/docker')
const {
  createDeploymentLogWriter,
} = require('../utils/deploymentLogWriter')

const connection = {
  host: '127.0.0.1',
  port: 6379,
}

const SUPERSEDED_CONTAINER_STOP_DELAY_MS = 60 * 60 * 1000

const runtimeLogFollowers = new Map()

async function scheduleSupersededContainerCleanup(deployments) {
  await Promise.all(
    deployments.map((deployment) =>
      deploymentCleanupQueue.add(
        'stop-superseded-container',
        {
          deploymentId: deployment.id,
        },
        {
          jobId: `stop-superseded-container-${deployment.id}`,
          delay: SUPERSEDED_CONTAINER_STOP_DELAY_MS,
          removeOnComplete: true,
          removeOnFail: 100,
        },
      ),
    ),
  )
}

async function closeRuntimeLogFollower(deploymentId) {
  const follower = runtimeLogFollowers.get(deploymentId)

  if (!follower) {
    return
  }

  follower.process.kill()
  await follower.writer.close()
  runtimeLogFollowers.delete(deploymentId)
}

const deploymentWorker = new Worker(
  'deployments',
  async (job) => {
    const { deploymentId } = job.data

    console.log(`Starting deployment ${deploymentId}`)

    const deployment = await prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            githubInstallation: true,
          },
        },
      },
    })

    if (!deployment) {
      throw new Error(`Deployment ${deploymentId} was not found.`)
    }

    const installation = deployment.project.githubInstallation

    if (!installation || !deployment.project.githubRepositoryFullName) {
      throw new Error(
        'This deployment has no GitHub installation or repository.',
      )
    }

    await prisma.$transaction(async (tx) => {
      await tx.deployment.update({
        where: { id: deploymentId },
        data: {
          status: 'BUILDING',
          startedAt: new Date(),
        },
      })

      await tx.deploymentActivity.create({
        data: {
          deploymentId,
          type: 'BUILD_STARTED',
          fromStatus: 'QUEUED',
          toStatus: 'BUILDING',
          message: 'Deployment worker started downloading source code.',
        },
      })
    })

    try {
      const repositoryPath = await downloadRepository({
        installationId: installation.installationId,
        repositoryFullName: deployment.project.githubRepositoryFullName,
        commitSha: deployment.commitSha,
        deploymentId,
      })

      const dockerfilePath = path.join(repositoryPath, 'Dockerfile')
      await fs.access(dockerfilePath)

      await prisma.deploymentActivity.create({
        data: {
          deploymentId,
          type: 'STATUS_CHANGED',
          fromStatus: 'BUILDING',
          toStatus: 'BUILDING',
          message: 'Source code downloaded and Dockerfile found.',
          metadata: { dockerfilePath: 'Dockerfile' },
        },
      })

      const imageTag = `kindlydeploy/${deployment.project.id}:${deployment.id}`

      await prisma.deploymentActivity.create({
        data: {
          deploymentId,
          type: 'STATUS_CHANGED',
          fromStatus: 'BUILDING',
          toStatus: 'BUILDING',
          message: 'Building Docker image.',
          metadata: { imageTag },
        },
      })

      const buildLogWriter = createDeploymentLogWriter({
        deploymentId,
        source: 'BUILD',
      })

      try {
        await runDockerBuild({
          repositoryPath,
          imageTag,
          onLog: (line) => {
            process.stdout.write(`[${deploymentId}] ${line}`)
            buildLogWriter.write(line)
          },
        })
      } finally {
        await buildLogWriter.close()
      }

      const containerName = `kindlydeploy-${deployment.id}`
      const containerPort = 80

      await prisma.deploymentActivity.create({
        data: {
          deploymentId,
          type: 'STATUS_CHANGED',
          fromStatus: 'BUILDING',
          toStatus: 'BUILDING',
          message: 'Starting Docker container.',
          metadata: { containerName, containerPort },
        },
      })

      await runDockerContainer({
        imageTag,
        containerName,
        containerPort,
        onLog: (line) => {
          process.stdout.write(`[${deploymentId}] ${line}`)
        },
      })

      const containerStatus = await inspectDockerContainer(containerName)

      if (containerStatus !== 'running') {
        throw new Error(
          `Docker container did not start correctly. Status: ${containerStatus}`,
        )
      }

      const hostPort = await getDockerHostPort(containerName, containerPort)
      const localUrl = `http://localhost:${hostPort}`

      await prisma.deploymentActivity.create({
        data: {
          deploymentId,
          type: 'STATUS_CHANGED',
          fromStatus: 'BUILDING',
          toStatus: 'BUILDING',
          message: 'Running HTTP health check.',
          metadata: { localUrl },
        },
      })

      await waitForHttpHealth(localUrl)

      await prisma.deploymentActivity.create({
        data: {
          deploymentId,
          type: 'STATUS_CHANGED',
          fromStatus: 'BUILDING',
          toStatus: 'BUILDING',
          message: 'HTTP health check passed.',
          metadata: { localUrl },
        },
      })

      const supersededDeployments = await prisma.$transaction(async (tx) => {
        const deploymentsToSupersede = await tx.deployment.findMany({
          where: {
            projectId: deployment.project.id,
            id: {
              not: deploymentId,
            },
            status: 'READY',
            supersededAt: null,
          },
          select: {
            id: true,
          },
        })

        if (deploymentsToSupersede.length > 0) {
          await tx.deployment.updateMany({
            where: {
              id: {
                in: deploymentsToSupersede.map(
                  (supersededDeployment) => supersededDeployment.id,
                ),
              },
            },
            data: {
              supersededAt: new Date(),
            },
          })
        }

        await tx.deployment.update({
          where: { id: deploymentId },
          data: {
            status: 'READY',
            imageTag,
            containerName,
            containerPort,
            hostPort,
            localUrl,
            finishedAt: new Date(),
          },
        })

        await tx.deploymentActivity.create({
          data: {
            deploymentId,
            type: 'BUILD_COMPLETED',
            fromStatus: 'BUILDING',
            toStatus: 'READY',
            message: 'Docker container started successfully.',
            metadata: {
              imageTag,
              containerName,
              containerPort,
              hostPort,
              localUrl,
            },
          },
        })

        return deploymentsToSupersede
      })

      await scheduleSupersededContainerCleanup(supersededDeployments)

      const runtimeLogWriter = createDeploymentLogWriter({
        deploymentId,
        source: 'RUNTIME',
      })

      const runtimeLogProcess = followDockerContainerLogs({
        containerName,
        onLog: (line) => {
          runtimeLogWriter.write(line)
        },
      })

      runtimeLogFollowers.set(deploymentId, {
        process: runtimeLogProcess,
        writer: runtimeLogWriter,
      })

      try {
        const screenshotPath = await takeScreenshot(localUrl, deploymentId)

        const previewScreenshotUrl = await uploadDeploymentScreenshot({
          filePath: screenshotPath,
          deploymentId,
        })

        await prisma.deployment.update({
          where: {
            id: deploymentId,
          },
          data: {
            previewScreenshotUrl,
          },
        })

        await prisma.deploymentActivity.create({
          data: {
            deploymentId,
            type: 'STATUS_CHANGED',
            fromStatus: 'READY',
            toStatus: 'READY',
            message: 'Deployment preview screenshot captured.',
            metadata: {
              previewScreenshotUrl,
            },
          },
        })

        console.log(`Screenshot uploaded for deployment ${deploymentId}`)
      } catch (screenshotError) {
        console.error(
          `Screenshot capture failed for deployment ${deploymentId}:`,
          screenshotError.message,
        )

        await prisma.deploymentActivity.create({
          data: {
            deploymentId,
            type: 'STATUS_CHANGED',
            fromStatus: 'READY',
            toStatus: 'READY',
            message: 'Deployment is ready, but preview screenshot capture failed.',
          },
        })
      }

      console.log(`Deployment ${deploymentId} is ready at ${localUrl}`)
    } catch (error) {
      await prisma.$transaction(async (tx) => {
        await tx.deployment.update({
          where: { id: deploymentId },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
          },
        })

        await tx.deploymentActivity.create({
          data: {
            deploymentId,
            type: 'BUILD_FAILED',
            fromStatus: 'BUILDING',
            toStatus: 'FAILED',
            message: `Build failed: ${error.message}`,
          },
        })
      })

      throw error
    }
  },
  { connection },
)

const cleanupWorker = new Worker(
  'deployment-cleanups',
  async (job) => {
    const { deploymentId } = job.data

    console.log(`Starting cleanup for deployment ${deploymentId}`)

    const result = await stopSupersededDeploymentContainer({
      deploymentId,
      message: 'Superseded deployment container was stopped automatically.',
    })

    if (!result.stopped) {
      console.log(`Cleanup skipped for deployment ${deploymentId}: ${result.message}`)
      return
    }

    await closeRuntimeLogFollower(result.deployment.id)

    console.log(
      `Stopped superseded deployment container ${result.deployment.containerName}`,
    )
  },
  { connection },
)

deploymentWorker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`)
})

deploymentWorker.on('failed', (job, error) => {
  console.error(`Job ${job?.id} failed:`, error)
})

cleanupWorker.on('completed', (job) => {
  console.log(`Cleanup job ${job.id} completed`)
})

cleanupWorker.on('failed', (job, error) => {
  console.error(`Cleanup job ${job?.id} failed:`, error)
})

console.log('Deployment worker is listening for jobs.')
console.log('Deployment cleanup worker is listening for jobs.')

async function shutDown() {
  console.log('Stopping deployment worker...')

  for (const [deploymentId, follower] of runtimeLogFollowers.entries()) {
    follower.process.kill()
    await follower.writer.close()
    runtimeLogFollowers.delete(deploymentId)
  }

  await deploymentWorker.close()
  await cleanupWorker.close()
  await deploymentCleanupQueue.close()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGINT', shutDown)
process.on('SIGTERM', shutDown)