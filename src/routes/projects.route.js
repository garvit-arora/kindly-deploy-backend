const express = require('express')
const prisma = require('../lib/prisma')
const { encrypt } = require('../utils/encryption')
const requireAuth = require('../middlewares/requireAuth')
const {
  getInstallationRepositories,
  getInstallationCommit,
  getInstallationDockerfile,
  getInstallationPackageJson,
} = require('../utils/githubApp')
const deploymentQueue = require('../queues/deploymentQueue')
const {
  stopSupersededDeploymentContainer,
} = require('../services/deploymentCleanup.service')

const router = express.Router()

router.use(requireAuth)

router.post('/', async (req, res) => {
    const {
      name,
      githubInstallationId,
      githubRepositoryId,
      githubRepositoryFullName,
      branch,
      buildStrategy,
      environmentVariables,
    } = req.body

  const normalizedName = typeof name === 'string' ? name.trim() : ''
  const normalizedBranch = typeof branch === 'string' ? branch.trim() : ''
  const requestedBuildStrategy =
    typeof buildStrategy === 'string' ? buildStrategy : 'DOCKERFILE'

  if (!normalizedName) {
    return res.status(400).json({
      message: 'Project name is required.',
    })
  }

  if (
    !githubInstallationId ||
    !githubRepositoryId ||
    !githubRepositoryFullName
  ) {
    return res.status(400).json({
      message: 'Choose a GitHub repository.',
    })
  }

  if (
    !['DOCKERFILE', 'NODE_FRONTEND', 'NODE_BACKEND'].includes(
      requestedBuildStrategy,
    )
  ) {
    return res.status(400).json({
      message: 'Unsupported build strategy.',
    })
  }

  const normalizedEnvironmentVariables = Array.isArray(environmentVariables)
    ? environmentVariables
    : []

  for (const variable of normalizedEnvironmentVariables) {
    const variableKey =
      typeof variable?.key === 'string' ? variable.key.trim() : ''
    const variableValue =
      typeof variable?.value === 'string' ? variable.value : ''

    if (!variableKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableKey)) {
      return res.status(400).json({
        message: `Invalid environment variable key: "${variableKey || variable?.key}".`,
      })
    }

    if (!variableValue) {
      return res.status(400).json({
        message: `Environment variable "${variableKey}" needs a value.`,
      })
    }
  }

  try {
    const installation = await prisma.githubInstallation.findFirst({
      where: {
        id: githubInstallationId,
        userId: req.user.id,
      },
    })

    if (!installation) {
      return res.status(404).json({
        message: 'GitHub installation was not found.',
      })
    }

    const repositories = await getInstallationRepositories(
      installation.installationId,
    )

    const repository = repositories.find(
      (item) =>
        item.id === githubRepositoryId &&
        item.fullName === githubRepositoryFullName,
    )

    if (!repository) {
      return res.status(400).json({
        message: 'Selected repository is not available to this installation.',
      })
    }

    const selectedBranch = normalizedBranch || repository.defaultBranch

    const commit = await getInstallationCommit(
      installation.installationId,
      repository.fullName,
      selectedBranch,
    )

    let dockerfilePath = null

    if (requestedBuildStrategy === 'DOCKERFILE') {
      const dockerfile = await getInstallationDockerfile(
        installation.installationId,
        repository.fullName,
        commit.sha,
      )

      if (!dockerfile.exists) {
        return res.status(400).json({
          message:
            'This branch does not contain a root-level Dockerfile. Choose a different build strategy or add a Dockerfile.',
        })
      }

      dockerfilePath = dockerfile.path || 'Dockerfile'
    } else {
      const packageJsonResult = await getInstallationPackageJson(
        installation.installationId,
        repository.fullName,
        commit.sha,
      )

      if (!packageJsonResult.exists) {
        return res.status(400).json({
          message:
            'This branch does not contain a package.json KindlyDeploy can build.',
        })
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          name: normalizedName,
          userId: req.user.id,
          branch: selectedBranch,
          repositoryUrl: repository.url,
          githubInstallationId: installation.id,
          githubRepositoryId: repository.id,
          githubRepositoryFullName: repository.fullName,
          buildStrategy: requestedBuildStrategy,
        },
      })

      const deployment = await tx.deployment.create({
        data: {
          projectId: project.id,
          branch: selectedBranch,
          commitSha: commit.sha,
          dockerfilePath,
          buildStrategy: requestedBuildStrategy,
          status: 'PENDING',
        },
      })

      for (const variable of normalizedEnvironmentVariables) {
        await tx.environmentVariable.upsert({
          where: {
            projectId_key: {
              projectId: project.id,
              key: variable.key.trim(),
            },
          },
          update: {
            encryptedValue: encrypt(variable.value),
          },
          create: {
            projectId: project.id,
            key: variable.key.trim(),
            encryptedValue: encrypt(variable.value),
          },
        })
      }

      await tx.deploymentActivity.create({
        data: {
          deploymentId: deployment.id,
          actorUserId: req.user.id,
          type: 'DEPLOYMENT_CREATED',
          toStatus: 'PENDING',
          message: 'Deployment created and waiting for a worker.',
          metadata: {
            repositoryFullName: repository.fullName,
            repositoryUrl: repository.url,
            branch: selectedBranch,
            commitSha: commit.sha,
            dockerfilePath,
            buildStrategy: requestedBuildStrategy,
          },
        },
      })

      return { project, deployment }
    })

    try {
      await deploymentQueue.add(
        'deploy',
        {
          deploymentId: result.deployment.id,
        },
        {
          jobId: result.deployment.id,
          removeOnComplete: true,
          removeOnFail: 100,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
        },
      )

      const queuedDeployment = await prisma.$transaction(async (tx) => {
        const deployment = await tx.deployment.update({
          where: {
            id: result.deployment.id,
          },
          data: {
            status: 'QUEUED',
          },
        })

        await tx.deploymentActivity.create({
          data: {
            deploymentId: deployment.id,
            actorUserId: req.user.id,
            type: 'STATUS_CHANGED',
            fromStatus: 'PENDING',
            toStatus: 'QUEUED',
            message: 'Added to the deployment queue.',
          },
        })

        return deployment
      })

      return res.status(201).json({
        project: result.project,
        deployment: queuedDeployment,
      })
    } catch (error) {
      console.error('Deployment queueing failed:', error)

      return res.status(500).json({
        message:
          'Project was created, but its deployment could not be added to the queue.',
      })
    }
  } catch (error) {
    console.error('Project and deployment creation failed:', error)

    return res.status(500).json({
      message: 'Could not create the project and deployment.',
    })
  }
})

router.get('/', async (req, res) => {
  try {
    const projects = await prisma.project.findMany({
      where: {
        userId: req.user.id,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        deployments: {
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,
          select: {
            id: true,
            status: true,
            createdAt: true,
          },
        },
      },
    })

    return res.status(200).json({
      projects,
    })
  } catch (error) {
    console.error('Project Listing Failed', error)

    return res.status(500).json({
      message: "Couldn't Load Projects",
    })
  }
})

router.post('/:projectId/deployments', async (req, res) => {
  try {
    const project = await prisma.project.findFirst({
      where: {
        id: req.params.projectId,
        userId: req.user.id,
      },
      include: {
        githubInstallation: true,
      },
    })

    if (!project) {
      return res.status(404).json({
        message: 'Project was not found.',
      })
    }

    if (!project.githubInstallation || !project.githubRepositoryFullName) {
      return res.status(400).json({
        message: 'This project is not connected to a GitHub repository.',
      })
    }

    const commit = await getInstallationCommit(
      project.githubInstallation.installationId,
      project.githubRepositoryFullName,
      project.branch,
    )

    let dockerfilePath = null

    if (project.buildStrategy === 'DOCKERFILE') {
      const dockerfile = await getInstallationDockerfile(
        project.githubInstallation.installationId,
        project.githubRepositoryFullName,
        commit.sha,
      )

      if (!dockerfile.exists) {
        return res.status(400).json({
          message:
            'The selected branch no longer contains a root-level Dockerfile.',
        })
      }

      dockerfilePath = dockerfile.path || 'Dockerfile'
    } else {
      const packageJsonResult = await getInstallationPackageJson(
        project.githubInstallation.installationId,
        project.githubRepositoryFullName,
        commit.sha,
      )

      if (!packageJsonResult.exists) {
        return res.status(400).json({
          message:
            'The selected branch no longer contains a package.json KindlyDeploy can build.',
        })
      }
    }

    const deployment = await prisma.$transaction(async (tx) => {
      const createdDeployment = await tx.deployment.create({
        data: {
          projectId: project.id,
          branch: project.branch,
          commitSha: commit.sha,
          dockerfilePath,
          buildStrategy: project.buildStrategy,
          status: 'PENDING',
        },
      })

      await tx.deploymentActivity.create({
        data: {
          deploymentId: createdDeployment.id,
          actorUserId: req.user.id,
          type: 'DEPLOYMENT_CREATED',
          toStatus: 'PENDING',
          message: 'Manual redeployment created and waiting for a worker.',
          metadata: {
            repositoryFullName: project.githubRepositoryFullName,
            branch: project.branch,
            commitSha: commit.sha,
            dockerfilePath,
            buildStrategy: project.buildStrategy,
          },
        },
      })

      return createdDeployment
    })

    await deploymentQueue.add(
      'deploy',
      {
        deploymentId: deployment.id,
      },
      {
        jobId: deployment.id,
        removeOnComplete: true,
        removeOnFail: 100,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      },
    )

    const queuedDeployment = await prisma.$transaction(async (tx) => {
      const updatedDeployment = await tx.deployment.update({
        where: {
          id: deployment.id,
        },
        data: {
          status: 'QUEUED',
        },
      })

      await tx.deploymentActivity.create({
        data: {
          deploymentId: deployment.id,
          actorUserId: req.user.id,
          type: 'STATUS_CHANGED',
          fromStatus: 'PENDING',
          toStatus: 'QUEUED',
          message: 'Manual redeployment added to the deployment queue.',
        },
      })

      return updatedDeployment
    })

    return res.status(201).json({
      deployment: queuedDeployment,
    })
  } catch (error) {
    console.error('Manual redeployment failed:', error)

    return res.status(500).json({
      message: 'Could not create the redeployment.',
    })
  }
})

router.get('/:projectId/deployments', async (req, res) => {
  try {
    const project = await prisma.project.findFirst({
      where: {
        id: req.params.projectId,
        userId: req.user.id,
      },
      select: {
        id: true,
        name: true,
        repositoryUrl: true,
        branch: true,
        githubRepositoryFullName: true,
        deployments: {
          orderBy: {
            createdAt: 'desc',
          },
          select: {
            supersededAt: true,
            stoppedAt: true,
            id: true,
            branch: true,
            commitSha: true,
            status: true,
            imageTag: true,
            containerName: true,
            localUrl: true,
            createdAt: true,
            startedAt: true,
            finishedAt: true,
          },
        },
      },
    })

    if (!project) {
      return res.status(404).json({
        message: 'Project was not found.',
      })
    }

    return res.status(200).json({ project })
  } catch (error) {
    console.error('Project deployment history lookup failed:', error)

    return res.status(500).json({
      message: 'Could not load project deployment history.',
    })
  }
})

router.post(
  '/:projectId/deployments/:sourceDeploymentId/rollback',
  async (req, res) => {
    try {
      const project = await prisma.project.findFirst({
        where: {
          id: req.params.projectId,
          userId: req.user.id,
        },
      })

      if (!project) {
        return res.status(404).json({
          message: 'Project was not found.',
        })
      }

      const sourceDeployment = await prisma.deployment.findFirst({
        where: {
          id: req.params.sourceDeploymentId,
          projectId: project.id,
          status: 'READY',
        },
      })

      if (!sourceDeployment) {
        return res.status(400).json({
          message:
            'Only a successful deployment from this project can be rolled back to.',
        })
      }

      const rollbackDeployment = await prisma.$transaction(async (tx) => {
        const createdDeployment = await tx.deployment.create({
          data: {
            projectId: project.id,
            branch: sourceDeployment.branch,
            commitSha: sourceDeployment.commitSha,
            dockerfilePath: sourceDeployment.dockerfilePath,
            buildStrategy: sourceDeployment.buildStrategy,
            status: 'PENDING',
          },
        })

        await tx.deploymentActivity.create({
          data: {
            deploymentId: createdDeployment.id,
            actorUserId: req.user.id,
            type: 'DEPLOYMENT_CREATED',
            toStatus: 'PENDING',
            message: 'Rollback deployment created and waiting for a worker.',
            metadata: {
              rollbackOfDeploymentId: sourceDeployment.id,
              branch: sourceDeployment.branch,
              commitSha: sourceDeployment.commitSha,
              dockerfilePath: sourceDeployment.dockerfilePath,
            },
          },
        })

        return createdDeployment
      })

      await deploymentQueue.add(
        'deploy',
        {
          deploymentId: rollbackDeployment.id,
        },
        {
          jobId: rollbackDeployment.id,
          removeOnComplete: true,
          removeOnFail: 100,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
        },
      )

      const queuedDeployment = await prisma.$transaction(async (tx) => {
        const updatedDeployment = await tx.deployment.update({
          where: {
            id: rollbackDeployment.id,
          },
          data: {
            status: 'QUEUED',
          },
        })

        await tx.deploymentActivity.create({
          data: {
            deploymentId: rollbackDeployment.id,
            actorUserId: req.user.id,
            type: 'STATUS_CHANGED',
            fromStatus: 'PENDING',
            toStatus: 'QUEUED',
            message: 'Rollback deployment added to the deployment queue.',
            metadata: {
              rollbackOfDeploymentId: sourceDeployment.id,
            },
          },
        })

        return updatedDeployment
      })

      return res.status(201).json({
        deployment: queuedDeployment,
      })
    } catch (error) {
      console.error('Rollback deployment failed:', error)

      return res.status(500).json({
        message: 'Could not create the rollback deployment.',
      })
    }
  },
)

router.post('/:projectId/deployments/:deploymentId/stop', async (req, res) => {
  try {
    const result = await stopSupersededDeploymentContainer({
      deploymentId: req.params.deploymentId,
      projectId: req.params.projectId,
      userId: req.user.id,
      actorUserId: req.user.id,
      message: 'Superseded deployment container was stopped.',
    })

    if (!result.stopped) {
      return res.status(result.statusCode).json({
        message: result.message,
      })
    }

    return res.status(200).json({
      deployment: result.deployment,
    })
  } catch (error) {
    console.error('Stopping deployment container failed:', error)

    return res.status(500).json({
      message: 'Could not stop the deployment container.',
    })
  }
})
router.get('/:projectId/environment-variables', async (req, res) => {
  try {
    const project = await prisma.project.findFirst({
      where: { id: req.params.projectId, userId: req.user.id },
    })

    if (!project) {
      return res.status(404).json({ message: 'Project was not found.' })
    }

    const variables = await prisma.environmentVariable.findMany({
      where: { projectId: project.id },
      orderBy: { key: 'asc' },
      select: { id: true, key: true, createdAt: true, updatedAt: true },
    })

    return res.status(200).json({ variables })
  } catch (error) {
    console.error('Environment variable listing failed:', error)

    return res.status(500).json({
      message: 'Could not load environment variables.',
    })
  }
})

router.post('/:projectId/environment-variables', async (req, res) => {
  const { key, value } = req.body
  const normalizedKey = typeof key === 'string' ? key.trim() : ''

  if (!normalizedKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalizedKey)) {
    return res.status(400).json({
      message:
        'Key must start with a letter or underscore and contain only letters,numbers, and underscores.',
    })
  }

  if (typeof value !== 'string' || !value) {
    return res.status(400).json({
      message: 'Value is required.',
    })
  }

  try {
    const project = await prisma.project.findFirst({
      where: { id: req.params.projectId, userId: req.user.id },
    })

    if (!project) {
      return res.status(404).json({ message: 'Project was not found.' })
    }

    const encryptedValue = encrypt(value)

    const variable = await prisma.environmentVariable.upsert({
      where: {
        projectId_key: {
          projectId: project.id,
          key: normalizedKey,
        },
      },
      update: {
        encryptedValue,
      },
      create: {
        projectId: project.id,
        key: normalizedKey,
        encryptedValue,
      },
      select: { id: true, key: true, createdAt: true, updatedAt: true },
    })

    return res.status(201).json({ variable })
  } catch (error) {
    console.error('Environment variable save failed:', error)

    return res.status(500).json({
      message: 'Could not save the environment variable.',
    })
  }
})

router.delete(
  '/:projectId/environment-variables/:variableId',
  async (req, res) => {
    try {
      const project = await prisma.project.findFirst({
        where: { id: req.params.projectId, userId: req.user.id },
      })

      if (!project) {
        return res.status(404).json({ message: 'Project was not found.' })
      }

      const deleted = await prisma.environmentVariable.deleteMany({
        where: {
          id: req.params.variableId,
          projectId: project.id,
        },
      })

      if (deleted.count === 0) {
        return res.status(404).json({
          message: 'Environment variable was not found.',
        })
      }

      return res.status(204).send()
    } catch (error) {
      console.error('Environment variable deletion failed:', error)

      return res.status(500).json({
        message: 'Could not delete the environment variable.',
      })
    }
  },
)
module.exports = router