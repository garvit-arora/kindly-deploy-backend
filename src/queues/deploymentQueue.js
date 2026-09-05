const { Queue } = require('bullmq')
  const { getRedisConnectionOptions } = require('../lib/redisConnection')

  const connection = getRedisConnectionOptions()

  const deploymentQueue = new Queue('deployments', {
    connection,
  })

  module.exports = deploymentQueue
