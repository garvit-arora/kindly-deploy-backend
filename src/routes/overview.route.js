const express = require('express')
  const prisma = require('../lib/prisma')
  const requireAuth = require('../middlewares/requireAuth')

  const router = express.Router()

  router.use(requireAuth)

  router.get('/', async (req, res) => {
    try {
      const [totalProjects, totalDeployments, statusGroups, recentDeployments] =
        await Promise.all([
          prisma.project.count({
            where: { userId: req.user.id },
          }),
          prisma.deployment.count({
            where: { project: { userId: req.user.id } },
          }),
          prisma.deployment.groupBy({
            by: ['status'],
            where: { project: { userId: req.user.id } },
            _count: true,
          }),
          prisma.deployment.findMany({
            where: { project: { userId: req.user.id } },
            orderBy: { createdAt: 'desc' },
            take: 5,
            include: {
              project: {
                select: {
                  name: true,
                  githubRepositoryFullName: true,
                },
              },
            },
          }),
        ])

      const statusBreakdown = statusGroups.reduce((accumulator, group) => {
        accumulator[group.status] = group._count
        return accumulator
      }, {})

      return res.status(200).json({
        totalProjects,
        totalDeployments,
        statusBreakdown,
        recentDeployments,
      })
    } catch (error) {
      console.error('Overview lookup failed:', error)

      return res.status(500).json({
        message: 'Could not load overview data.',
      })
    }
  })

  module.exports = router