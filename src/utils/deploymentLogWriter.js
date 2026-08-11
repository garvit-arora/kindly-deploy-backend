const prisma = require('../lib/prisma')

function createDeploymentLogWriter({
  deploymentId,
  source = 'BUILD',
  flushIntervalMs = 500,
  maxBufferedMessages = 25,
}) {
  let buffer = []
  let isFlushing = false
  let isClosed = false

  async function flush() {
    if (isFlushing || buffer.length === 0) {
      return
    }

    isFlushing = true

    const messagesToWrite = buffer
    buffer = []

    try {
      await prisma.deploymentLog.createMany({
        data: messagesToWrite.map((message) => ({
          deploymentId,
          source,
          message,
        })),
      })
    } catch (error) {
      console.error(
        `Could not persist ${source.toLowerCase()} logs for ${deploymentId}:`,
        error,
      )
    } finally {
      isFlushing = false

      if (buffer.length > 0) {
        await flush()
      }
    }
  }

  const intervalId = setInterval(() => {
    flush()
  }, flushIntervalMs)

  function write(text) {
    if (isClosed || !text) {
      return
    }

    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)

    buffer.push(...lines)

    if (buffer.length >= maxBufferedMessages) {
      flush()
    }
  }

  async function close() {
    isClosed = true
    clearInterval(intervalId)
    await flush()
  }

  return {
    write,
    close,
  }
}

module.exports = {
  createDeploymentLogWriter,
}