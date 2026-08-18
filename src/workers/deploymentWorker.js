require('dotenv').config()

  const { Worker } = require('bullmq')
  const fs = require('fs/promises')
  const path = require('path')
  const prisma = require('../lib/prisma')
  const deploymentCleanupQueue = require('../queues/deploymentCleanupQueue')
  const { decrypt } = require('../utils/encryption')
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
    followDockerContainerLogs,
    removeDockerContainer,
  } = require('../utils/docker')
  const {
    createDeploymentLogWriter,
  } = require('../utils/deploymentLogWriter')
  const {
    getFrontendOutputDir,
    generateDockerfile,
  } = require('../utils/detectBuildStrategy')

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
  async function cleanupRepositoryPath(repositoryPath, deploymentId) {
    if (!repositoryPath) {
      return
    }

    const buildRoot = path.dirname(repositoryPath)
    const deploymentsRoot = path.resolve(process.cwd(), 'tmp', 'deployments')
    const resolvedBuildRoot = path.resolve(buildRoot)

    if (!resolvedBuildRoot.startsWith(`${deploymentsRoot}${path.sep}`)) {
      console.error(
        `Skipped temporary source cleanup for deployment ${deploymentId}. Invalid path: ${resolvedBuildRoot}`,
      )
      return
    }

    try {
      await fs.rm(resolvedBuildRoot, {
        recursive: true,
        force: true,
      })

      console.log(`Removed temporary source folder for deployment ${deploymentId}`)
    } catch (cleanupError) {
      console.error(
        `Could not remove temporary source folder for deployment ${deploymentId}:`,
        cleanupError.message,
      )
    }
  }
  async function removeFailedDeploymentContainer({ deploymentId, containerName }) {
    if (!containerName) {
      return
    }

    try {
      await removeDockerContainer(containerName)

      await prisma.deploymentActivity.create({
        data: {
          deploymentId,
          type: 'STATUS_CHANGED',
          fromStatus: 'FAILED',
          toStatus: 'FAILED',
          message: 'Failed deployment container was removed.',
          metadata: {
            containerName,
          },
        },
      })

      console.log(`Removed failed deployment container ${containerName}`)
    } catch (cleanupError) {
      console.error(
        `Could not remove failed deployment container ${containerName}:`,
        cleanupError.message,
      )

      await prisma.deploymentActivity.create({
        data: {
          deploymentId,
          type: 'STATUS_CHANGED',
          fromStatus: 'FAILED',
          toStatus: 'FAILED',
          message: 'Deployment failed, but container cleanup failed.',
          metadata: {
            containerName,
            error: cleanupError.message,
          },
        },
      })
    }
  }

  const deploymentWorker = new Worker(
    'deployments',
    async (job) => {
      const { deploymentId } = job.data
      let repositoryPath = ''
      let createdContainerName = ''
      let deploymentMarkedReady = false

      console.log(`Starting deployment ${deploymentId}`)

      const deployment = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        include: {
          project: {
            include: {
              githubInstallation: true,
              environmentVariables: true,
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
          repositoryPath = await downloadRepository({
          installationId: installation.installationId,
          repositoryFullName: deployment.project.githubRepositoryFullName,
          commitSha: deployment.commitSha,
          deploymentId,
        })

        const dockerfilePath = path.join(repositoryPath, 'Dockerfile')

        if (deployment.buildStrategy === 'DOCKERFILE') {
          await fs.access(dockerfilePath)
        } else {
          const packageJsonRaw = await fs.readFile(
            path.join(repositoryPath, 'package.json'),
            'utf8',
          )
          const packageJson = JSON.parse(packageJsonRaw)
          const outputDir = getFrontendOutputDir(packageJson)

          const generatedDockerfile = generateDockerfile({
            kind: deployment.buildStrategy,
            outputDir,
          })

          await fs.writeFile(dockerfilePath, generatedDockerfile)
        }

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
        const subdomain = `${deployment.id}.127.0.0.1.nip.io`
        const localUrl = `http://${subdomain}`

        createdContainerName = containerName

        await prisma.deploymentActivity.create({
          data: {
            deploymentId,
            type: 'STATUS_CHANGED',
            fromStatus: 'BUILDING',
            toStatus: 'BUILDING',
            message: 'Starting Docker container.',
            metadata: { containerName, containerPort, localUrl },
          },
        })

        const envVars = deployment.project.environmentVariables.map((variable) => ({
          key: variable.key,
          value: decrypt(variable.encryptedValue),
        }))

        await runDockerContainer({
          imageTag,
          containerName,
          containerPort,
          subdomain,
          envVars,
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
                localUrl,
              },
            },
          })

          return deploymentsToSupersede
        })

        deploymentMarkedReady = true

        try {
          await scheduleSupersededContainerCleanup(supersededDeployments)
        } catch (cleanupScheduleError) {
          console.error(
            `Could not schedule superseded container cleanup for deployment ${deploymentId}:`,
            cleanupScheduleError.message,
          )

          await prisma.deploymentActivity.create({
            data: {
              deploymentId,
              type: 'STATUS_CHANGED',
              fromStatus: 'READY',
              toStatus: 'READY',
              message:
                'Deployment is ready, but superseded container cleanup scheduling failed.',
            },
          })
        }

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
        if (deploymentMarkedReady) {
          console.error(
            `Post-ready task failed for deployment ${deploymentId}:`,
            error.message,
          )

          await prisma.deploymentActivity.create({
            data: {
              deploymentId,
              type: 'STATUS_CHANGED',
              fromStatus: 'READY',
              toStatus: 'READY',
              message: `Deployment is ready, but a post-ready task failed: ${error.message}`,
            },
          })

          return
        }

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

        await removeFailedDeploymentContainer({
          deploymentId,
          containerName: createdContainerName,
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