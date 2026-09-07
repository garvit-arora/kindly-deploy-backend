const prisma = require('../lib/prisma')
const {
  stopDockerContainer,
  removeDockerContainer,
  removeDockerImage,
} = require('../utils/docker')

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
      imageTag: true,
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

  // The grace window has closed, so nothing can be rolled back to this
  // container any more. Reclaim its disk: a stopped container still holds its
  // writable layer, and its image is never reused because every deployment is
  // tagged with its own id. Both are best effort — failing to free space must
  // not turn a successful stop into a failed job.
  const reclaimed = { container: false, image: false }

  try {
    await removeDockerContainer(deployment.containerName)
    reclaimed.container = true
  } catch (removeContainerError) {
    console.error(
      `Could not remove container ${deployment.containerName}:`,
      removeContainerError.message,
    )
  }

  if (deployment.imageTag) {
    try {
      await removeDockerImage(deployment.imageTag)
      reclaimed.image = true
    } catch (removeImageError) {
      console.error(
        `Could not remove image ${deployment.imageTag}:`,
        removeImageError.message,
      )
    }
  }

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
        metadata: {
          containerName: deployment.containerName,
          imageTag: deployment.imageTag,
          containerRemoved: reclaimed.container,
          imageRemoved: reclaimed.image,
        },
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