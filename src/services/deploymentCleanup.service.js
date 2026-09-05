const prisma = require('../lib/prisma')
const { stopDockerContainer } = require('../utils/docker')

async function findStoppableDeployment({ deploymentId, projectId, userId }) {
  const where = {
    id: deploymentId,
  }

  if (projectId) {
    where.projectId = projectId
  }

  if (userId) {
    where.project = {
      userId,
    }
  }

  const deployment = await prisma.deployment.findFirst({
    where,
    select: {
      id: true,
      status: true,
      containerName: true,
      supersededAt: true,
      stoppedAt: true,
    },
  })

  if (!deployment) {
    return {
      stoppable: false,
      statusCode: 404,
      message: 'Deployment was not found.',
    }
  }

  if (deployment.status !== 'READY' || !deployment.supersededAt) {
    return {
      stoppable: false,
      statusCode: 400,
      message: 'Only superseded ready deployments can be stopped.',
    }
  }

  if (deployment.stoppedAt) {
    return {
      stoppable: false,
      statusCode: 400,
      message: 'This deployment container was already stopped.',
    }
  }

  if (!deployment.containerName) {
    return {
      stoppable: false,
      statusCode: 400,
      message: 'This deployment has no container to stop.',
    }
  }

  return {
    stoppable: true,
    deployment,
  }
}

async function stopSupersededDeploymentContainer({
  deploymentId,
  projectId,
  userId,
  actorUserId,
  message,
}) {
  const check = await findStoppableDeployment({
    deploymentId,
    projectId,
    userId,
  })

  if (!check.stoppable) {
    return {
      stopped: false,
      statusCode: check.statusCode,
      message: check.message,
    }
  }

  const deployment = check.deployment

  await stopDockerContainer(deployment.containerName)

  const stoppedDeployment = await prisma.$transaction(async (tx) => {
    const updatedDeployment = await tx.deployment.update({
      where: {
        id: deployment.id,
      },
      data: {
        stoppedAt: new Date(),
      },
    })

    await tx.deploymentActivity.create({
      data: {
        deploymentId: deployment.id,
        actorUserId: actorUserId || null,
        type: 'STATUS_CHANGED',
        fromStatus: 'READY',
        toStatus: 'READY',
        message,
      },
    })

    return updatedDeployment
  })

  return {
    stopped: true,
    deployment: stoppedDeployment,
  }
}

module.exports = {
  findStoppableDeployment,
  stopSupersededDeploymentContainer,
}