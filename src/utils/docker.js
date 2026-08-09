const { spawn } = require('child_process')

function runDockerCommand({ args, cwd, onLog }) {
    return new Promise((resolve, reject) => {
        const dockerProcess = spawn('docker', args, {
            cwd,
            shell: process.platform === 'win32',
        })

        let output = ''

        dockerProcess.stdout.on('data', (chunk) => {
            const text = chunk.toString()
            output += text
            onLog?.(text)
        })

        dockerProcess.stderr.on('data', (chunk) => {
            const text = chunk.toString()
            output += text
            onLog?.(text)
        })

        dockerProcess.on('error', reject)

        dockerProcess.on('close', (code) => {
            if (code === 0) {
                resolve(output.trim())
                return
            }

            reject(new Error(`Docker command failed with exit code ${code}.`))
        })
    })
}

function runDockerBuild({ repositoryPath, imageTag, onLog }) {
    return runDockerCommand({
        args: ['build', '--tag', imageTag, '.'],
        cwd: repositoryPath,
        onLog,
    })
}

function runDockerContainer({
    imageTag,
    containerName,
    containerPort,
    onLog,
}) {
    return runDockerCommand({
        args: [
            'run',
            '--detach',
            '--name',
            containerName,
            '--network',
            'kindlydeploy-network',
            '--publish',
            `0:${containerPort}`,
            imageTag,
        ],
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
module.exports = {
    getDockerContainerLogs,
    runDockerBuild,
    runDockerContainer,
    inspectDockerContainer,
    removeDockerContainer,
    getDockerHostPort
}