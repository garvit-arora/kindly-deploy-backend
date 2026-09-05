const express = require('express')
const prisma = require('../lib/prisma')
const requireAuth = require('../middlewares/requireAuth')
const { hashSessionToken } = require('../utils/session')
const { getInstallationRepositories } = require('../utils/githubApp')

const router = express.Router()

router.use(requireAuth)

router.get('/github/installations', async (req, res) => {
  try {
    const installations = await prisma.githubInstallation.findMany({
      where: {
        userId: req.user.id,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        _count: {
          select: {
            projects: true,
          },
        },
      },
    })

    const withRepositoryCounts = await Promise.all(
      installations.map(async (installation) => {
        let repositoryCount = null

        try {
          const repositories = await getInstallationRepositories(
            installation.installationId,
          )

          repositoryCount = repositories.length
        } catch (error) {
          if (error.status === 404) {
            repositoryCount = 0
          }
        }

        return {
          id: installation.id,
          installationId: installation.installationId,
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          createdAt: installation.createdAt,
          projectCount: installation._count.projects,
          repositoryCount,
          manageUrl:
            installation.accountType === 'Organization'
              ? `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.installationId}`
              : `https://github.com/settings/installations/${installation.installationId}`,
        }
      }),
    )

    return res.status(200).json({
      installations: withRepositoryCounts,
      oauthRevokeUrl: process.env.GITHUB_CLIENT_ID
        ? `https://github.com/settings/connections/applications/${process.env.GITHUB_CLIENT_ID}`
        : null,
      installUrl: process.env.GITHUB_APP_SLUG
        ? `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new`
        : null,
    })
  } catch (error) {
    console.error('Listing GitHub installations failed:', error)

    return res.status(500).json({
      message: 'Could not load your GitHub installations.',
    })
  }
})

router.delete('/github/installations/:installationRowId', async (req, res) => {
  try {
    const installation = await prisma.githubInstallation.findFirst({
      where: {
        id: req.params.installationRowId,
        userId: req.user.id,
      },
    })

    if (!installation) {
      return res.status(404).json({
        message: 'GitHub installation was not found.',
      })
    }

    await prisma.githubInstallation.delete({
      where: {
        id: installation.id,
      },
    })

    return res.sendStatus(204)
  } catch (error) {
    console.error('Disconnecting GitHub installation failed:', error)

    return res.status(500).json({
      message: 'Could not disconnect this GitHub installation.',
    })
  }
})

router.get('/sessions', async (req, res) => {
  try {
    const sessions = await prisma.session.findMany({
      where: {
        userId: req.user.id,
        expiresAt: {
          gt: new Date(),
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        tokenHash: true,
      },
    })

    const currentTokenHash = req.cookies.kindlydeploy_session
      ? hashSessionToken(req.cookies.kindlydeploy_session)
      : null

    return res.status(200).json({
      sessions: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        isCurrent: session.tokenHash === currentTokenHash,
      })),
    })
  } catch (error) {
    console.error('Listing sessions failed:', error)

    return res.status(500).json({
      message: 'Could not load your active sessions.',
    })
  }
})

router.post('/sessions/revoke-others', async (req, res) => {
  try {
    const currentTokenHash = req.cookies.kindlydeploy_session
      ? hashSessionToken(req.cookies.kindlydeploy_session)
      : null

    const result = await prisma.session.deleteMany({
      where: {
        userId: req.user.id,
        tokenHash: currentTokenHash
          ? {
              not: currentTokenHash,
            }
          : undefined,
      },
    })

    return res.status(200).json({
      revokedCount: result.count,
    })
  } catch (error) {
    console.error('Revoking sessions failed:', error)

    return res.status(500).json({
      message: 'Could not revoke your other sessions.',
    })
  }
})

module.exports = router
