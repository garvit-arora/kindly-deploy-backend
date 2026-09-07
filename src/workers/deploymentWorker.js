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

 const { getRedisConnectionOptions } = require('../lib/redisConnection')

  const connection = getRedisConnectionOptions()

  const SUPERSEDED_CONTAINER_STOP_DELAY_MS = 60 * 60 * 1000

  const DEPLOYMENT_BASE_HOST =
    process.env.DEPLOYMENT_BASE_HOST || '127.0.0.1.nip.io'

  const DEPLOYMENT_HEALTH_CHECK_HOST =
    process.env.DEPLOYMENT_HEALTH_CHECK_HOST || '127.0.0.1'

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
        const subdomain = `${deployment.id}.${DEPLOYMENT_BASE_HOST}`
        const localUrl = `http://${subdomain}`
        const healthCheckUrl = `http://${DEPLOYMENT_HEALTH_CHECK_HOST}`

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

        await waitForHttpHealth(healthCheckUrl, { hostHeader: subdomain })

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

        let screenshotPath = ''

        try {
          screenshotPath = await takeScreenshot(localUrl, deploymentId)

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
        } finally {
          // The PNG only exists to be uploaded. Once ImageKit has it, or once
          // the attempt has failed, the local copy is dead weight.
          if (screenshotPath) {
            await fs.rm(screenshotPath, { force: true }).catch(() => {})
          }
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
      } finally {
        // The extracted source is only needed until `docker build` has read it.
        // Whether the deployment succeeded or failed, keeping it serves no
        // purpose and every deployment would otherwise leave a copy behind.
        await cleanupRepositoryPath(repositoryPath, deploymentId)
      }
    },
    { connection },
  )

  const cleanupWorker = new Worker(
    'deployment-cleanups',
    async (job) => {
      const { deploymentId, actorUserId, message } = job.data

      console.log(`Starting cleanup for deployment ${deploymentId}`)

      const result = await stopSupersededDeploymentContainer({
        deploymentId,
        actorUserId,
        message:
          message ||
          'Superseded deployment container was stopped automatically.',
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

  // Idle exit.
  //
  // BullMQ has to poll: Redis cannot push a job to a consumer, so an idle
  // worker keeps asking "anything yet?" — one billed command every few
  // seconds, forever. Rather than pay for the question, the worker stops
  // asking. It exits once it has been idle long enough, and the API starts it
  // again on the next push or redeploy.
  //
  // Set WORKER_IDLE_EXIT_MS to 0 (or leave it unset) to keep the worker
  // running forever, which is what you want in local development and on a
  // self-hosted Redis where idle polling is free.
  const WORKER_IDLE_EXIT_MS = Number(process.env.WORKER_IDLE_EXIT_MS) || 0

  let activeJobCount = 0
  let idleExitTimer = null

  function cancelIdleExit() {
    if (idleExitTimer) {
      clearTimeout(idleExitTimer)
      idleExitTimer = null
    }
  }

  function scheduleIdleExit() {
    if (!WORKER_IDLE_EXIT_MS) {
      return
    }

    cancelIdleExit()

    // Never exit mid-build. A deployment can easily outlive the idle window,
    // and the job would be re-run from the start on the next wake.
    if (activeJobCount > 0) {
      return
    }

    idleExitTimer = setTimeout(() => {
      if (activeJobCount > 0) {
        return
      }

      console.log(
        `No work for ${WORKER_IDLE_EXIT_MS} ms. Exiting to stop polling Redis.`,
      )

      shutDown()
    }, WORKER_IDLE_EXIT_MS)

    // Do not hold the event loop open just for this timer.
    idleExitTimer.unref?.()
  }

  function trackWorkerActivity(worker) {
    worker.on('active', () => {
      activeJobCount += 1
      cancelIdleExit()
    })

    const onSettled = () => {
      activeJobCount = Math.max(0, activeJobCount - 1)
      scheduleIdleExit()
    }

    worker.on('completed', onSettled)
    worker.on('failed', onSettled)

    // `drained` fires when the queue has no waiting jobs left. Delayed jobs
    // are not "waiting", so this still fires while a cleanup job is pending
    // its one-hour timer — the supervisor's sweep is what brings the worker
    // back when that timer is due.
    worker.on('drained', scheduleIdleExit)
  }

  trackWorkerActivity(deploymentWorker)
  trackWorkerActivity(cleanupWorker)

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

  if (WORKER_IDLE_EXIT_MS) {
    console.log(`Worker will exit after ${WORKER_IDLE_EXIT_MS} ms of no work.`)

    // Cover the case where the worker was woken but the job is already gone
    // (a duplicate wake, or another worker got there first). Without this the
    // worker would sit polling forever having never received a `drained`.
    scheduleIdleExit()
  }

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