const express = require('express');
  const cors = require('cors')
  const prisma = require('./lib/prisma');
  const crypto = require('crypto')
  const overviewRoutes = require('./routes/overview.route')
  const deploymentRoutes = require('./routes/deployments.route')
  const {
      getGitHubInstallation,
      getInstallationRepositories,
      getInstallationBranches,
      getInstallationDockerfile,
      getInstallationCommit,
      getInstallationPackageJson,
  } = require('./utils/githubApp')
  const { detectBuildStrategy } = require('./utils/detectBuildStrategy')
  const redis = require('./lib/redis')
  const deploymentQueue = require('./queues/deploymentQueue')
  const { wakeWorker } = require('./utils/wakeWorker')
  const {
      SESSION_DURATION_MS,
      getSessionExpiresAt,
      hashSessionToken,
      createSessionToken
  } = require('./utils/session');
  const requireAuth = require('./middlewares/requireAuth');
  const cookieParser = require('cookie-parser');
  const projectRoutes=require("./routes/projects.route")
  const accountRoutes = require('./routes/account.route')
  const domainRoutes = require('./routes/domains.route')
  const app = express();

  const isProduction = process.env.NODE_ENV === 'production'

  const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean)

  const primaryFrontendUrl = allowedOrigins[0]

  const sessionCookieOptions = {
      httpOnly: true,
      sameSite: isProduction ? 'none' : 'lax',
      secure: isProduction,
  }

  app.set('trust proxy', 1)
  app.use(
      cors({
          origin: (origin, callback) => {
              if (!origin || allowedOrigins.includes(origin)) {
                  return callback(null, true)
              }

              return callback(new Error('Origin is not allowed by CORS.'))
          },
          credentials:true,
      })
  )
  app.use(express.json({
      verify: (req, res, buf) => {
          req.rawBody = buf
      },
  }))
  app.use(cookieParser());
  app.use('/api/overview', overviewRoutes)
  app.use('/api/projects',projectRoutes)
  app.use('/api/deployments', deploymentRoutes)
  app.use('/api/account', accountRoutes)
  app.use('/api/domains', domainRoutes)
  app.get('/api/health', async (req, res) => {
      try {
          await prisma.$queryRaw`SELECT 1`

          res.status(200).json({
              status: "ok",
              message: 'API and database are running.',
          })
      } catch (error) {
          console.error("Database Health check failed", error);
          res.status(503).json({
              status: "error",
              message: "Database is Unavailable"
          })
      }
  })


  app.get('/api/redis-health', async (req, res) => {
    try {
      const reply = await redis.ping()

      return res.status(200).json({
        status: reply === 'PONG' ? 'ok' : 'error',
        message: 'Redis is running.',
      })
    } catch (error) {
      console.error('Redis health check failed:', error)

      return res.status(503).json({
        status: 'error',
        message: 'Redis is unavailable.',
      })
    }
  })
  app.post('/api/queue-test', requireAuth, async (req, res) => {
    try {
      const job = await deploymentQueue.add(
        'deployment-test',
        {
          deploymentId: 'test-deployment-id',
        },
        {
          removeOnComplete: true,
          removeOnFail: 100,
        },
      )

      return res.status(201).json({
        message: 'Test job added to the deployment queue.',
        jobId: job.id,
      })
    } catch (error) {
      console.error('Queue test failed:', error)

      return res.status(500).json({
        message: 'Could not add test job.',
      })
    }
  })
  app.post('/api/auth/dev-login', async (req, res) => {
      if (process.env.NODE_ENV == "production") {
          return res.sendStatus(404);
      }


      const { email, name } = req.body;
      const normalizedEmail = typeof email == 'string' ? email.trim().toLowerCase() : ""
      const normalizedName = typeof name == 'string' ? name.trim() : null

      if (!normalizedEmail) {
          return res.status(400).json({
              message: "Email is required."
          })
      }
      try {
          const user = await prisma.user.upsert({
              where: { email: normalizedEmail },
              update: normalizedName ? { name: normalizedName } : {},
              create: {
                  email: normalizedEmail,
                  name: normalizedName,
              },
          })
          const sessionToken = createSessionToken()
          await prisma.session.create({
              data: {
                  tokenHash: hashSessionToken(sessionToken),
                  userId: user.id,
                  expiresAt: getSessionExpiresAt(),
              }
          })
          res.cookie('kindlydeploy_session', sessionToken, {
              ...sessionCookieOptions,
              maxAge: SESSION_DURATION_MS,
          })
          return res.status(201).json({
              user:{
                  id:user.id,
                  email:user.email,
                  name:user.name,
              },
          })
      } catch (error) {
          console.error("Development Sign in failed",error);
          return res.status(500).json({
              message:"Couldn't create the development Session !!"
          })

      }
  })

  app.get('/api/auth/me',requireAuth,async(req,res)=>{
     return res.status(200).json({
      user:{
          id:req.user.id,
          email:req.user.email,
          name:req.user.name,
          avatarUrl:req.user.avatarUrl
      }
     })
  })

  app.post('/api/auth/logout',async(req,res)=>{
      const sessionToken = req.cookies.kindlydeploy_session
      try {
          if(sessionToken){
              await prisma.session.deleteMany({
                  where:{
                      tokenHash: hashSessionToken(sessionToken)
          }})
          }
          res.clearCookie("kindlydeploy_session",sessionCookieOptions)
          return res.sendStatus(204)
      } catch (error) {
          console.log('Logout Failed',error);
          return res.status(500).json({
              message:'Could Not log Out.'
          })

      }
  })
  function isValidOAuthState(expectedState,receivedState){
      if(!expectedState|| !receivedState){
          return false;
      }
      const expected = Buffer.from(expectedState)
      const received = Buffer.from(receivedState)

      return(
          expected.length===received.length &&
          crypto.timingSafeEqual(expected,received)
      )
  }
  app.get('/api/auth/github',(req,res)=>{
      const {GITHUB_CLIENT_ID,GITHUB_CALLBACK_URL}=process.env
      if(!GITHUB_CLIENT_ID || !GITHUB_CALLBACK_URL){
          return res.status(500).json({
              message:"Github Authentication is not Configured."
          })
      }
      const state = crypto.randomBytes(32).toString('hex');
      res.cookie('github_oauth_state',state,{
          ...sessionCookieOptions,
          maxAge:10*60*1000,
      })
      const authorizationUrl = new URL('https://github.com/login/oauth/authorize')
      authorizationUrl.searchParams.set('client_id',GITHUB_CLIENT_ID)
      authorizationUrl.searchParams.set('redirect_uri',GITHUB_CALLBACK_URL)
      authorizationUrl.searchParams.set('state',state)
      return res.redirect(authorizationUrl.toString())
  })

  app.get('/api/auth/github/callback',async(req,res)=>{
      const {code,state,error} = req.query;
      const savedState = req.cookies.github_oauth_state

      res.clearCookie('github_oauth_state',sessionCookieOptions)
      if(error||!code||!isValidOAuthState(savedState,state)){
          return res.status(400).json({
              message:"Github verfication could not be verified."
          })
      }
      const {GITHUB_CLIENT_ID,GITHUB_CLIENT_SECRET,GITHUB_CALLBACK_URL} = process.env
      const FRONTEND_URL = primaryFrontendUrl
      if(!GITHUB_CALLBACK_URL||!GITHUB_CLIENT_ID||!GITHUB_CLIENT_SECRET||!FRONTEND_URL){
          return res.status(500).json({
              message:"Github authentication isn't configured."
          })
      }
      try {
          const tokenResponse = await fetch('https://github.com/login/oauth/access_token',{
              method:'POST',
              headers:{
                  Accept:'application/json',
                  'Content-Type':'application/json',
              },
              body:JSON.stringify({
                  client_id:GITHUB_CLIENT_ID,
                  client_secret:GITHUB_CLIENT_SECRET,
                  code,
                  redirect_uri:GITHUB_CALLBACK_URL
              })
          })
          const tokenData = await tokenResponse.json();
          if(!tokenResponse.ok || !tokenData.access_token){
              throw new Error('Github Token Exchange Failed.')
          }
          const userResponse=await fetch('https://api.github.com/user',{
              headers:{
                  Accept:'application/vnd.github+json',
                  Authorization:`Bearer ${tokenData.access_token}`,
                  'User-Agent':'KindlyDeploy',
                  'X-Github-Api-Version':'2022-11-28'
              },
          })
          const githubUser=await userResponse.json()
          if(!userResponse.ok || !githubUser.id){
              throw new Error('Could not load the Github user')
          }
          const user = await prisma.user.upsert({
              where:{
                  githubId:String(githubUser.id)
              },
              update:{
                  name:githubUser.name || githubUser.login,
                  avatarUrl:githubUser.avatar_url,
              },
              create:{
                  githubId:String(githubUser.id),
                  name:githubUser.name || githubUser.login,
                  avatarUrl:githubUser.avatar_url,
              }

          })
          const sessionToken = createSessionToken()
          await prisma.session.create({
              data:{
                  tokenHash:hashSessionToken(sessionToken),
                  userId:user.id,
                  expiresAt:getSessionExpiresAt()
              }
          })
          res.cookie('kindlydeploy_session',sessionToken,{
              ...sessionCookieOptions,
              maxAge:SESSION_DURATION_MS
          })
          return res.redirect(`${FRONTEND_URL}/dashboard/projects`)
      } catch (error) {
          console.error("Github callback Failed",error);
          return res.status(500).json({
              message:"Could not complete Github Sign In"
          })
      }
  })

  app.get('/api/github/install',requireAuth,(req,res)=>{
      const {GITHUB_APP_SLUG} = process.env
      if(!GITHUB_APP_SLUG){
          return res.status(500).json({
              message:"Github App installation is not configured."
          })
      }
      return res.redirect(`https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`)
  })

  app.get('/api/github/install/callback', requireAuth, async (req, res) => {
    const installationId = req.query.installation_id

    if (!installationId) {
      return res.status(400).json({
        message: 'GitHub did not provide an installation ID.',
      })
    }

    try {
      const installation = await getGitHubInstallation(installationId)

      await prisma.githubInstallation.upsert({
        where: {
          installationId: String(installation.id),
        },
        update: {
          accountId: String(installation.account.id),
          accountLogin: installation.account.login,
          accountType: installation.account.type,
          userId: req.user.id,
        },
        create: {
          installationId: String(installation.id),
          accountId: String(installation.account.id),
          accountLogin: installation.account.login,
          accountType: installation.account.type,
          userId: req.user.id,
        },
      })

      return res.redirect(`${primaryFrontendUrl}/dashboard/projects/new`)
    } catch (error) {
      console.error('GitHub installation callback failed:', error)

      return res.status(500).json({
        message: 'Could not save the GitHub installation.',
      })
    }
  })

  app.get('/api/github/repositories', requireAuth, async (req, res) => {
    try {
      const installations = await prisma.githubInstallation.findMany({
        where: {
          userId: req.user.id,
        },
      })

      const repositoryGroups = await Promise.all(
        installations.map(async (installation) => {
          try {
            return {
              installationId: installation.id,
              repositories: await getInstallationRepositories(
                installation.installationId,
              ),
            }
          } catch (error) {
            if (error.status === 404) {
              await prisma.githubInstallation.delete({
                where: { id: installation.id },
              })
            } else {
              console.error(
                `Skipping GitHub installation ${installation.installationId}:`,
                error,
              )
            }

            return { installationId: installation.id, repositories: [] }
          }
        }),
      )

      const repositories = repositoryGroups.flatMap((group) =>
        group.repositories.map((repository) => ({
          ...repository,
          installationId: group.installationId,
        })),
      )

      return res.status(200).json({ repositories })
    } catch (error) {
      console.error('GitHub repository lookup failed:', error)

      return res.status(500).json({
        message: 'Could not load GitHub repositories.',
      })
    }
  })
  app.get('/api/github/branches', requireAuth, async (req, res) => {
    const { installationId, repositoryFullName } = req.query

    if (
      typeof installationId !== 'string' ||
      typeof repositoryFullName !== 'string'
    ) {
      return res.status(400).json({
        message: 'Installation ID and repository name are required.',
      })
    }

    try {
      const installation = await prisma.githubInstallation.findFirst({
        where: {
          id: installationId,
          userId: req.user.id,
        },
      })

      if (!installation) {
        return res.status(404).json({
          message: 'GitHub installation was not found.',
        })
      }

      const branches = await getInstallationBranches(
        installation.installationId,
        repositoryFullName,
      )

      return res.status(200).json({ branches })
    } catch (error) {
      console.error('GitHub branch lookup failed:', error)

      return res.status(500).json({
        message: 'Could not load GitHub branches.',
      })
    }
  })

  app.get('/api/github/detect', requireAuth, async (req, res) => {
    const { installationId, repositoryFullName, branch } = req.query

    if (
      typeof installationId !== 'string' ||
      typeof repositoryFullName !== 'string' ||
      typeof branch !== 'string'
    ) {
      return res.status(400).json({
        message: 'Installation ID, repository, and branch are required.',
      })
    }

    try {
      const installation = await prisma.githubInstallation.findFirst({
        where: {
          id: installationId,
          userId: req.user.id,
        },
      })

      if (!installation) {
        return res.status(404).json({
          message: 'GitHub installation was not found.',
        })
      }

      const commit = await getInstallationCommit(
        installation.installationId,
        repositoryFullName,
        branch,
      )

      const dockerfile = await getInstallationDockerfile(
        installation.installationId,
        repositoryFullName,
        commit.sha,
      )

      if (dockerfile.exists) {
        return res.status(200).json({ kind: 'DOCKERFILE' })
      }

      const packageJsonResult = await getInstallationPackageJson(
        installation.installationId,
        repositoryFullName,
        commit.sha,
      )

      if (!packageJsonResult.exists) {
        return res.status(200).json({ kind: 'UNSUPPORTED' })
      }

      const strategy = detectBuildStrategy(packageJsonResult.packageJson)

      return res.status(200).json({ kind: strategy.kind })
    } catch (error) {
      console.error('Build detection failed:', error)

      return res.status(500).json({
        message: 'Could not detect a build strategy for this repository.',
      })
    }
  })

  function isValidWebhookSignature(secret, rawBody, signatureHeader) {
      if (!secret || !rawBody || !signatureHeader) {
          return false
      }

      const expectedSignature = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
      const expected = Buffer.from(expectedSignature)
      const received = Buffer.from(signatureHeader)

      return (
          expected.length === received.length &&
          crypto.timingSafeEqual(expected, received)
      )
  }

  app.post('/api/github/webhook', async (req, res) => {
      const signature = req.get('x-hub-signature-256')
      const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET

      if (!webhookSecret || !isValidWebhookSignature(webhookSecret, req.rawBody, signature)) {
          return res.status(401).json({
              message: 'Webhook signature could not be verified.',
          })
      }

      const event = req.get('x-github-event')

      if (event !== 'push') {
          return res.status(200).json({ message: 'Event ignored.' })
      }

      const payload = req.body
      const commitSha = payload.after
      const ref = payload.ref
      const repositoryFullName = payload.repository?.full_name

      if (
          !commitSha ||
          commitSha === '0000000000000000000000000000000000000000' ||
          !ref ||
          !repositoryFullName
      ) {
          return res.status(200).json({ message: 'Nothing to deploy for this push.' })
      }

      const branch = ref.replace('refs/heads/', '')

      try {
          const projects = await prisma.project.findMany({
              where: {
                  githubRepositoryFullName: repositoryFullName,
                  branch,
              },
              include: {
                  githubInstallation: true,
              },
          })

          for (const project of projects) {
              if (!project.githubInstallation) {
                  continue
              }

              const dockerfile = await getInstallationDockerfile(
                  project.githubInstallation.installationId,
                  repositoryFullName,
                  commitSha,
              )

              let dockerfilePath = null
              let resolvedBuildStrategy = project.buildStrategy

              if (dockerfile.exists) {
                  dockerfilePath = dockerfile.path || 'Dockerfile'
                  resolvedBuildStrategy = 'DOCKERFILE'
              } else if (project.buildStrategy === 'DOCKERFILE') {
                  continue
              }

              const deployment = await prisma.$transaction(async (tx) => {
                  const createdDeployment = await tx.deployment.create({
                      data: {
                          projectId: project.id,
                          branch,
                          commitSha,
                          dockerfilePath,
                          buildStrategy: resolvedBuildStrategy,
                          status: 'PENDING',
                      },
                  })

                  await tx.deploymentActivity.create({
                      data: {
                          deploymentId: createdDeployment.id,
                          type: 'DEPLOYMENT_CREATED',
                          toStatus: 'PENDING',
                          message: 'Deployment created from a GitHub push and waiting for a worker.',
                          metadata: {
                              triggeredBy: 'github_webhook',
                              repositoryFullName,
                              branch,
                              commitSha,
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

              await wakeWorker(`github-push:${deployment.id}`)

              await prisma.$transaction(async (tx) => {
                  await tx.deployment.update({
                      where: { id: deployment.id },
                      data: { status: 'QUEUED' },
                  })

                  await tx.deploymentActivity.create({
                      data: {
                          deploymentId: deployment.id,
                          type: 'STATUS_CHANGED',
                          fromStatus: 'PENDING',
                          toStatus: 'QUEUED',
                          message: 'Added to the deployment queue from a GitHub push.',
                      },
                  })
              })
          }

          return res.status(200).json({ message: 'Webhook processed.' })
      } catch (error) {
          console.error('GitHub webhook processing failed:', error)

          return res.status(500).json({
              message: 'Could not process the GitHub webhook.',
          })
      }
  })

  module.exports = app;