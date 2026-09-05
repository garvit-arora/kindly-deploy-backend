const http = require('http')
const https = require('https')

function requestStatusCode(url, hostHeader, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const client = target.protocol === 'https:' ? https : http

    const request = client.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}` || '/',
        method: 'GET',
        headers: hostHeader ? { Host: hostHeader } : {},
      },
      (response) => {
        response.resume()
        resolve(response.statusCode)
      },
    )

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Health check timed out after ${timeoutMs}ms.`))
    })

    request.on('error', reject)
    request.end()
  })
}

async function waitForHttpHealth(url, options = {}) {
  const attempts = options.attempts || 10
  const delayMs = options.delayMs || 1000
  const timeoutMs = options.timeoutMs || 5000

  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const statusCode = await requestStatusCode(
        url,
        options.hostHeader,
        timeoutMs,
      )

      if (statusCode >= 200 && statusCode < 300) {
        return
      }

      lastError = new Error(`Health check returned HTTP ${statusCode}.`)
    } catch (error) {
      lastError = error
    }

    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  throw new Error(
    `Health check failed after ${attempts} attempts: ${lastError?.message}`,
  )
}

module.exports = {
  waitForHttpHealth,
}
