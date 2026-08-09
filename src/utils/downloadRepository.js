const AdmZip = require('adm-zip')
const fs = require('fs/promises')
const path = require('path')
const { createInstallationAccessToken } = require('./githubApp')

async function downloadRepository({
  installationId,
  repositoryFullName,
  commitSha,
  deploymentId,
}) {
  const [owner, repository] = repositoryFullName.split('/')

  if (!owner || !repository) {
    throw new Error('Invalid GitHub repository name.')
  }

  const token = await createInstallationAccessToken(installationId)

  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repository,
    )}/zipball/${encodeURIComponent(commitSha)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'KindlyDeploy',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'follow',
    },
  )

  if (!response.ok) {
    throw new Error('Could not download the selected GitHub commit.')
  }

  const buildRoot = path.join(
    process.cwd(),
    'tmp',
    'deployments',
    deploymentId,
  )

  await fs.rm(buildRoot, { recursive: true, force: true })
  await fs.mkdir(buildRoot, { recursive: true })

  const archive = new AdmZip(Buffer.from(await response.arrayBuffer()))
  archive.extractAllTo(buildRoot, true)

  const extractedFolders = await fs.readdir(buildRoot, {
    withFileTypes: true,
  })

  const repositoryFolder = extractedFolders.find((entry) => entry.isDirectory())

  if (!repositoryFolder) {
    throw new Error('Downloaded repository archive was empty.')
  }

  return path.join(buildRoot, repositoryFolder.name)
}

module.exports = {
  downloadRepository,
}