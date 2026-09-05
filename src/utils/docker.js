const { spawn } = require('child_process')

function runDockerContainer({
      imageTag,
      containerName,
      containerPort,
      subdomain,
      envVars,
      onLog,
  }) {
      const envArgs = (envVars || []).flatMap((envVar) => [
          '--env',
          `${envVar.key}=${envVar.value}`,
      ])

      return runDockerCommand({
          args: [
              'run',
              '--detach',
              '--name',
              containerName,
              '--network',
              'kindlydeploy-network',
              ...envArgs,
              '--label',
              'traefik.enable=true',
              '--label',
              `traefik.http.routers.${containerName}.rule=Host(\`${subdomain}\`)`,
              '--label',
              `traefik.http.routers.${containerName}.entrypoints=web`,
              '--label',
              `traefik.http.services.${containerName}.loadbalancer.server.port=${containerPort}`,
              imageTag,
          ],
          onLog,
      })
  }

function runDockerBuild({ repositoryPath, imageTag, onLog }) {
    return runDockerCommand({
        args: ['build', '--tag', imageTag, '.'],
        cwd: repositoryPath,
        onLog,
    })
}

function inspectDockerContainer(containerName) {
    return runDockerCommand({
        args: [
            'inspect',
            '--format',
            '{{.State.Status}}',
            containerName,
        ],
    })
}
function getDockerHostPort(containerName, containerPort) {
  return runDockerCommand({
    args: [
      'port',
      containerName,
      `${containerPort}/tcp`,
    ],
  }).then((output) => {
    const match = output.match(/:(\d+)\s*$/)

    if (!match) {
      throw new Error('Docker did not provide a mapped host port.')
    }

    return Number(match[1])
  })
}

function removeDockerContainer(containerName) {
    return runDockerCommand({
        args: ['rm', '--force', containerName],
    })
}
function getDockerContainerLogs(containerName, tail = 500) {
  return runDockerCommand({
    args: [
      'logs',
      '--timestamps',
      '--tail',
      String(tail),
      containerName,
    ],
  })
}
function followDockerContainerLogs({ containerName, onLog }) {
  const dockerProcess = spawn(
    'docker',
    ['logs', '--follow', '--timestamps', containerName],
    {
      shell: process.platform === 'win32',
    },
  )

  dockerProcess.stdout.on('data', (chunk) => {
    onLog(chunk.toString())
  })

  dockerProcess.stderr.on('data', (chunk) => {
    onLog(chunk.toString())
  })

  dockerProcess.on('error', (error) => {
    console.error(
      `Could not follow Docker logs for ${containerName}:`,
      error.message,
    )
  })

  return dockerProcess
}
function stopDockerContainer(containerName) {
  return runDockerCommand({
    args: ['stop', containerName],
  })
}
module.exports = {
  stopDockerContainer,
  runDockerBuild,
  runDockerContainer,
  inspectDockerContainer,
  getDockerHostPort,
  removeDockerContainer,
  getDockerContainerLogs,
  followDockerContainerLogs,
}