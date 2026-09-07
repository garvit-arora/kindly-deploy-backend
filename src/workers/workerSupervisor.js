require('dotenv').config()

// The supervisor is the only always-on process on the deployment machine.
// It exists so the deployment worker does not have to be.
//
// It deliberately never imports the BullMQ queues or a Redis client: this
// process runs 24/7, and anything it connected to Redis would reintroduce the
// idle cost the whole design is meant to remove. It talks to Postgres only.
//
// Two ways the worker gets started:
//   1. /wake  — the API calls this immediately after enqueueing a job.
//   2. sweep  — a timer that asks Postgres "is any work outstanding?" and
//               starts the worker if so. This is what saves us when a wake
//               call is lost, and what fires the delayed cleanup jobs whose
//               one-hour timer elapsed while no worker was running.

const express = require('express')
const crypto = require('crypto')
const { exec } = require('child_process')
const prisma = require('../lib/prisma')

const app = express()
app.use(express.json())

const PORT = Number(process.env.WORKER_SUPERVISOR_PORT) || 4000

// How the worker is started. pm2 is used on the VM; anything that launches
// `npm run worker` and returns works here.
const WORKER_START_COMMAND =
  process.env.WORKER_START_COMMAND || 'pm2 start kindlydeploy-worker'

const SWEEP_INTERVAL_MS =
  Number(process.env.WORKER_SWEEP_INTERVAL_MS) || 10 * 60 * 1000

// Must match SUPERSEDED_CONTAINER_STOP_DELAY_MS in the worker: the grace
// window before a superseded container is stopped.
const SUPERSEDED_CONTAINER_STOP_DELAY_MS = 60 * 60 * 1000

// Starting an already-running worker is harmless but noisy, and a burst of
// pushes would otherwise fire a burst of pm2 calls. One start at a time, and
// never more than one every few seconds.
const MIN_START_INTERVAL_MS = 5000

let startInFlight = false
let lastStartAt = 0

function isAuthorised(req) {
  const expected = process.env.WORKER_WAKE_SECRET
  const provided = req.get('x-wake-secret') || ''

  // A missing secret means anyone who finds this endpoint can spawn processes
  // on the deployment machine. Refuse to run without one.
  if (!expected) {
    return false
  }

  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(provided)

  if (expectedBuffer.length !== providedBuffer.length) {
    return false
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer)
}

function runStartCommand() {
  return new Promise((resolve, reject) => {
    exec(WORKER_START_COMMAND, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message))
        return
      }

      resolve(stdout?.trim() || '')
    })
  })
}

async function startWorker(reason) {
  const now = Date.now()

  if (startInFlight) {
    return { started: false, message: 'A worker start is already in progress.' }
  }

  if (now - lastStartAt < MIN_START_INTERVAL_MS) {
    return { started: false, message: 'Worker was started moments ago.' }
  }

  startInFlight = true

  try {
    await runStartCommand()
    lastStartAt = Date.now()

    console.log(`Worker started (${reason}).`)
    return { started: true, message: 'Worker started.' }
  } catch (startError) {
    console.error(`Could not start worker (${reason}):`, startError.message)
    return { started: false, message: startError.message }
  } finally {
    startInFlight = false
  }
}

// Postgres is the source of truth for outstanding work, so the sweep can
// answer "is there anything to do?" without touching Redis.
async function findOutstandingWork() {
  const cleanupCutoff = new Date(Date.now() - SUPERSEDED_CONTAINER_STOP_DELAY_MS)

  const [queuedDeployments, dueCleanups] = await Promise.all([
    prisma.deployment.count({
      where: {
        status: {
          in: ['PENDING', 'QUEUED'],
        },
      },
    }),
    prisma.deployment.count({
      where: {
        status: 'READY',
        stoppedAt: null,
        supersededAt: {
          not: null,
          lte: cleanupCutoff,
        },
      },
    }),
  ])

  return { queuedDeployments, dueCleanups }
}

async function sweep() {
  try {
    const work = await findOutstandingWork()
    const total = work.queuedDeployments + work.dueCleanups

    if (total === 0) {
      return
    }

    console.log(
      `Sweep found outstanding work: ${work.queuedDeployments} queued, ${work.dueCleanups} cleanups due.`,
    )

    await startWorker('sweep')
  } catch (sweepError) {
    console.error('Sweep failed:', sweepError.message)
  }
}

app.get('/health', (req, res) => {
  return res.json({ status: 'ok' })
})

app.post('/wake', async (req, res) => {
  if (!isAuthorised(req)) {
    return res.status(401).json({ message: 'Unauthorised.' })
  }

  const reason = req.body?.reason || 'wake'
  const result = await startWorker(reason)

  // A refused start is not a failure the caller should retry: either a start
  // is already happening or the worker is already up. Both mean the job will
  // be picked up.
  return res.status(202).json(result)
})

app.listen(PORT, () => {
  console.log(`Worker supervisor is listening on ${PORT}.`)
  console.log(`Sweeping for outstanding work every ${SWEEP_INTERVAL_MS} ms.`)
})

// Run one sweep at boot so a restart of this process recovers anything that
// was stranded while it was down.
sweep()
setInterval(sweep, SWEEP_INTERVAL_MS)

async function shutDown() {
  console.log('Stopping worker supervisor...')
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGINT', shutDown)
process.on('SIGTERM', shutDown)
