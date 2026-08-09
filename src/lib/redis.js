const IORedis = require('ioredis')

const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
})

redis.on('error', (error) => {
  console.error('Redis connection error:', error.message)
})

module.exports = redis