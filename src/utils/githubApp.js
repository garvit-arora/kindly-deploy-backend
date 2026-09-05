const crypto = require('crypto');
const fs = require('fs');
const path=require('path');

function getPrivateKey(){
    const encodedPrivateKey = process.env.GITHUB_PRIVATE_KEY_BASE64;
    if(encodedPrivateKey){
        return Buffer.from(encodedPrivateKey,'base64').toString('utf8')
    }
    const privateKeyPath= process.env.GITHUB_PRIVATE_KEY_PATH;
    if(privateKeyPath){
        return fs.readFileSync(path.resolve(process.cwd(),privateKeyPath),'utf8')
    }
    throw new Error(
        "GITHUB_PRIVATE_KEY_BASE64 or GITHUB_PRIVATE_KEY_PATH is missing.",
    )
}
function createAppJwt(){
    if(!process.env.GITHUB_APP_ID){
        throw new Error('GITHUB_APP_ID is missing.')
    }
    const now = Math.floor(Date.now()/1000)
    const header = Buffer.from(
        JSON.stringify({
            alg:'RS256',typ:'JWT'
        }),).toString('base64url')
    const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: process.env.GITHUB_APP_ID,
    }),
  ).toString('base64url')
  const unsignedToken = `${header}.${payload}`
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(unsignedToken), getPrivateKey())
    .toString('base64url')

  return `${unsignedToken}.${signature}`
}

async function createInstallationAccessToken(installationId) {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${createAppJwt()}`,
        'User-Agent': 'KindlyDeploy',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )

  if (!response.ok) {
    throw new Error('Could not create GitHub installation access token.')
  }

  const data = await response.json()

  return data.token
}

async function getInstallationRepositories(installationId) {
  const token = await createInstallationAccessToken(installationId)

  const response = await fetch(
    'https://api.github.com/installation/repositories?per_page=100',
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'KindlyDeploy',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )

  if (!response.ok) {
    throw new Error('Could not load GitHub repositories.')
  }

  const data = await response.json()

  return data.repositories.map((repository) => ({
    id: String(repository.id),
    name: repository.name,
    fullName: repository.full_name,
    url: repository.html_url,
    isPrivate: repository.private,
    defaultBranch: repository.default_branch,
  }))
}

async function getGitHubInstallation(installationId) {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${createAppJwt()}`,
        'User-Agent': 'KindlyDeploy',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )
  if (!response.ok) {
    throw new Error('Could not load GitHub installation details.')
  }
    return response.json()

}
async function getInstallationBranches(
  installationId,
  repositoryFullName,
) {
  const [owner, repository] = repositoryFullName.split('/')

  if (!owner || !repository) {
    throw new Error('GitHub repository name is invalid.')
  }

  const token = await createInstallationAccessToken(installationId)

  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches?per_page=100`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'KindlyDeploy',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )

  if (!response.ok) {
    throw new Error('Could not load GitHub branches.')
  }

  const branches = await response.json()

  return branches.map((branch) => ({
    name: branch.name,
    sha: branch.commit.sha,
  }))
}
async function getInstallationCommit(
  installationId,
  repositoryFullName,
  branch,
) {
  const [owner, repository] = repositoryFullName.split('/')

  if (!owner || !repository || !branch) {
    throw new Error('GitHub repository name or branch is invalid.')
  }

  const token = await createInstallationAccessToken(installationId)

  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(branch)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'KindlyDeploy',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )

  if (!response.ok) {
    throw new Error('Could not resolve the selected branch to a commit.')
  }

  const commit = await response.json()

  return {
    sha: commit.sha,
  }
}

async function getInstallationDockerfile(
  installationId,
  repositoryFullName,
  commitSha,
) {
  const [owner, repository] = repositoryFullName.split('/')

  if (!owner || !repository || !commitSha) {
    throw new Error('GitHub repository name or commit SHA is invalid.')
  }

  const token = await createInstallationAccessToken(installationId)

  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/Dockerfile?ref=${encodeURIComponent(commitSha)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'KindlyDeploy',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )

  if (response.status === 404) {
    return {
      exists: false,
    }
  }

  if (!response.ok) {
    throw new Error('Could not check the repository Dockerfile.')
  }

  const file = await response.json()

  return {
    exists: file.type === 'file',
    path: file.path,
    sha: file.sha,
  }
}
async function getInstallationPackageJson(
    installationId,
    repositoryFullName,
    commitSha,
  ) {
    const [owner, repository] = repositoryFullName.split('/')

    if (!owner || !repository || !commitSha) {
      throw new Error('GitHub repository name or commit SHA is invalid.')
    }

    const token = await createInstallationAccessToken(installationId)

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/package.json?ref=${encodeURIComponent(commitSha)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'KindlyDeploy',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )

    if (response.status === 404) {
      return {
        exists: false,
      }
    }

    if (!response.ok) {
      throw new Error('Could not check the repository package.json.')
    }

    const file = await response.json()
    const packageJson = JSON.parse(
      Buffer.from(file.content, 'base64').toString('utf8'),
    )

    return {
      exists: true,
      packageJson,
    }
  }
module.exports = {
  getGitHubInstallation,
  getInstallationPackageJson,
  getInstallationRepositories,
  getInstallationBranches,
  getInstallationCommit,
  getInstallationDockerfile,
  createInstallationAccessToken
}