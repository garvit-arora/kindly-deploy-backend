const express = require('express');
const prisma = require('../lib/prisma');
const requireAuth = require('../middlewares/requireAuth');
const { getInstallationRepositories, getInstallationCommit, getInstallationDockerfile } = require('../utils/githubApp')
const router = express.Router()
const deploymentQueue = require('../queues/deploymentQueue')

router.use(requireAuth)

router.post('/', async (req, res) => {
    const {
        name,
        githubInstallationId,
        githubRepositoryId,
        githubRepositoryFullName,
        branch,
    } = req.body

    const normalizedName = typeof name === 'string' ? name.trim() : ''
    const normalizedBranch = typeof branch === 'string' ? branch.trim() : ''

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

        const dockerfile = await getInstallationDockerfile(
            installation.installationId,
            repository.fullName,
            commit.sha,
        )

        if (!dockerfile.exists) {
            return res.status(400).json({
                message:
                    'This branch does not contain a root-level Dockerfile. KindlyDeploy currently supports Dockerfile repositories only.',
            })
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
                },
            })

            const deployment = await tx.deployment.create({
                data: {
                    projectId: project.id,
                    branch: selectedBranch,
                    commitSha: commit.sha,
                    dockerfilePath: dockerfile.path || 'Dockerfile',
                    status: 'PENDING',
                },
            })

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
                        dockerfilePath: dockerfile.path || 'Dockerfile',
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
            projects
        })
    } catch (error) {
        console.error("Project Listing Failed", error);
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

    if (
      !project.githubInstallation ||
      !project.githubRepositoryFullName
    ) {
      return res.status(400).json({
        message: 'This project is not connected to a GitHub repository.',
      })
    }

    const commit = await getInstallationCommit(
      project.githubInstallation.installationId,
      project.githubRepositoryFullName,
      project.branch,
    )

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

    const deployment = await prisma.$transaction(async (tx) => {
      const createdDeployment = await tx.deployment.create({
        data: {
          projectId: project.id,
          branch: project.branch,
          commitSha: commit.sha,
          dockerfilePath: dockerfile.path || 'Dockerfile',
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
            dockerfilePath: dockerfile.path || 'Dockerfile',
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
module.exports = router