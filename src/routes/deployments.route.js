const express = require('express')
const prisma = require('../lib/prisma')
const requireAuth = require('../middlewares/requireAuth')
const router = express.Router()

router.use(requireAuth)
router.get('/', async (req, res) => {
  try {
    const deployments = await prisma.deployment.findMany({
      where: {
        project: {
          userId: req.user.id,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            githubRepositoryFullName: true,
          },
        },
      },
    })
    
    return res.status(200).json({ deployments })
  } catch (error) {
    console.error('Deployment listing failed:', error)
    
    return res.status(500).json({
      message: 'Could not load deployments.',
    })
  }
})
const { getDockerContainerLogs } = require('../utils/docker')
router.get('/:deploymentId/logs', async (req, res) => {
  const tail = Number.parseInt(req.query.tail, 10)
  const safeTail =
    Number.isInteger(tail) && tail > 0 ? Math.min(tail, 1000) : 500

  try {
    const deployment = await prisma.deployment.findFirst({
      where: {
        id: req.params.deploymentId,
        project: {
          userId: req.user.id,
        },
      },
      select: {
        id: true,
        status: true,
        containerName: true,
      },
    })

    if (!deployment) {
      return res.status(404).json({
        message: 'Deployment was not found.',
      })
    }

    if (!deployment.containerName) {
      return res.status(409).json({
        message: 'This deployment does not have a running container yet.',
      })
    }

    const logs = await getDockerContainerLogs(
      deployment.containerName,
      safeTail,
    )

    return res.status(200).json({
      deploymentId: deployment.id,
      logs,
    })
  } catch (error) {
    console.error('Docker log lookup failed:', error)

    return res.status(500).json({
      message: 'Could not load Docker container logs.',
    })
  }
})
router.get('/:deploymentId', async (req, res) => {
  try {
    const deployment = await prisma.deployment.findFirst({
      where: {
        id: req.params.deploymentId,
        project: {
          userId: req.user.id,
        },
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            repositoryUrl: true,
            branch: true,
            githubRepositoryFullName: true,
          },
        },
        activities: {
          orderBy: {
            createdAt: 'desc',
          },
          include: {
            actorUser: {
              select: {
                id: true,
                name: true,
                avatarUrl: true,
              },
            },
          },
        },
      },
    })

    if (!deployment) {
      return res.status(404).json({
        message: 'Deployment was not found.',
      })
    }

    return res.status(200).json({ deployment })
  } catch (error) {
    console.error('Deployment lookup failed:', error)

    return res.status(500).json({
      message: 'Could not load the deployment.',
    })
  }
})

module.exports = router