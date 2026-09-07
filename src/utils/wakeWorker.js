// The deployment worker does not stay running. Leaving it up costs one Redis
// command every few seconds forever, because BullMQ has to *ask* Redis whether
// a job has arrived — Redis cannot call the worker itself. On a per-command
// plan that idle question is the entire bill.
//
// So the API wakes the worker instead: enqueue the job, then tell the machine
// that owns Docker to start processing. Between deployments nothing is
// connected to Redis at all.
//
// This must never break a deployment. If the wake call fails, the job is still
// safely in the queue and the supervisor's periodic sweep will pick it up.

const WORKER_WAKE_TIMEOUT_MS = Number(process.env.WORKER_WAKE_TIMEOUT_MS) || 5000

async function wakeWorker(reason) {
  const wakeUrl = process.env.WORKER_WAKE_URL

  // No URL configured means the worker is expected to be running already —
  // which is how local development works. Not an error.
  if (!wakeUrl) {
    return { woken: false, skipped: true }
  }

  try {
    const response = await fetch(wakeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-wake-secret': process.env.WORKER_WAKE_SECRET || '',
      },
      body: JSON.stringify({ reason: reason || 'unspecified' }),
      signal: AbortSignal.timeout(WORKER_WAKE_TIMEOUT_MS),
    })

    if (!response.ok) {
      console.error(
        `Worker wake call returned ${response.status} for ${reason}.`,
      )
      return { woken: false, skipped: false }
    }

    console.log(`Worker wake requested for ${reason}.`)
    return { woken: true, skipped: false }
  } catch (wakeError) {
    // Swallowed on purpose. The sweep is the safety net.
    console.error(`Worker wake call failed for ${reason}:`, wakeError.message)
    return { woken: false, skipped: false }
  }
}

module.exports = { wakeWorker }
