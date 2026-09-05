const express = require('express')
const prisma = require('../lib/prisma')
const requireAuth = require('../middlewares/requireAuth')

const router = express.Router()

const DEPLOYMENT_BASE_HOST =
  process.env.DEPLOYMENT_BASE_HOST || '127.0.0.1.nip.io'

router.use(requireAuth)

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
          where: {
            status: 'READY',
            stoppedAt: null,
          },
          orderBy: {
            createdAt: 'desc',
          },
          select: {
            id: true,
            branch: true,
            commitSha: true,
            status: true,
            createdAt: true,
            supersededAt: true,
            localUrl: true,
          },
        },
      },
    })

    const domains = projects.flatMap((project) =>
      project.deployments.map((deployment) => ({
        id: deployment.id,
        host: `${deployment.id}.${DEPLOYMENT_BASE_HOST}`,
        url: deployment.localUrl || `http://${deployment.id}.${DEPLOYMENT_BASE_HOST}`,
        projectId: project.id,
        projectName: project.name,
        repository: project.githubRepositoryFullName,
        branch: deployment.branch,
        commitSha: deployment.commitSha,
        createdAt: deployment.createdAt,
        isPrimary: deployment.supersededAt === null,
      })),
    )

    return res.status(200).json({
      baseHost: DEPLOYMENT_BASE_HOST,
      domains,
    })
  } catch (error) {
    console.error('Listing domains failed:', error)

    return res.status(500).json({
      message: 'Could not load your domains.',
    })
  }
})

module.exports = router
