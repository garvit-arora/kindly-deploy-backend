async function waitForHttpHealth(url, options = {}) {
  const attempts = options.attempts || 10
  const delayMs = options.delayMs || 1000

  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url)

      if (response.ok) {
        return
      }

      lastError = new Error(
        `Health check returned HTTP ${response.status}.`,
      )
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