const { Queue } = require('bullmq')
  const { getRedisConnectionOptions } = require('../lib/redisConnection')

  const connection = getRedisConnectionOptions()

  const deploymentCleanupQueue = new Queue('deployment-cleanups', {
    connection,
  })

  module.exports = deploymentCleanupQueue