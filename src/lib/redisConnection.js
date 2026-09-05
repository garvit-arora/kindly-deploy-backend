function getRedisConnectionOptions() {
    const redisUrl = process.env.REDIS_URL

    if (!redisUrl) {
      throw new Error('REDIS_URL is missing.')
    }

    const parsedUrl = new URL(redisUrl)
    const isSecure = parsedUrl.protocol === 'rediss:'

    return {
      host: parsedUrl.hostname,
      port: Number(parsedUrl.port) || (isSecure ? 6380 : 6379),
      password: parsedUrl.password || undefined,
      ...(isSecure ? { tls: {} } : {}),
    }
  }

  module.exports = {
    getRedisConnectionOptions,
  }