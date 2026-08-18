const FRONTEND_FRAMEWORK_OUTPUT_DIRS = {
    vite: 'dist',
    'react-scripts': 'build',
    '@vue/cli-service': 'dist',
    astro: 'dist',
  }

  function mergeDependencies(packageJson) {
    return {
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {}),
    }
  }

  function detectBuildStrategy(packageJson) {
    const dependencies = mergeDependencies(packageJson)
    const scripts = packageJson.scripts || {}

    const frontendFramework = Object.keys(FRONTEND_FRAMEWORK_OUTPUT_DIRS).find(
      (name) => dependencies[name],
    )
    const hasBuildScript = Boolean(scripts.build)
    const hasStartScript = Boolean(scripts.start)
    const looksLikeFrontend = Boolean(frontendFramework) && hasBuildScript
    const looksLikeBackend = hasStartScript

    if (looksLikeFrontend && looksLikeBackend) {
      return { kind: 'AMBIGUOUS' }
    }

    if (looksLikeFrontend) {
      return { kind: 'NODE_FRONTEND' }
    }

    if (looksLikeBackend) {
      return { kind: 'NODE_BACKEND' }
    }

    return { kind: 'UNSUPPORTED' }
  }

  function getFrontendOutputDir(packageJson) {
    const dependencies = mergeDependencies(packageJson)

    const frontendFramework = Object.keys(FRONTEND_FRAMEWORK_OUTPUT_DIRS).find(
      (name) => dependencies[name],
    )

    return FRONTEND_FRAMEWORK_OUTPUT_DIRS[frontendFramework] || 'dist'
  }

  function generateDockerfile({ kind, outputDir }) {
    if (kind === 'NODE_FRONTEND') {
      return [
        'FROM node:20-alpine AS build',
        'WORKDIR /app',
        'COPY package*.json ./',
        'RUN npm install',
        'COPY . .',
        'RUN npm run build',
        'FROM nginx:alpine',
        `COPY --from=build /app/${outputDir} /usr/share/nginx/html`,
        'EXPOSE 80',
        '',
      ].join('\n')
    }

    if (kind === 'NODE_BACKEND') {
      return [
        'FROM node:20-alpine',
        'WORKDIR /app',
        'COPY package*.json ./',
        'RUN npm install --omit=dev',
        'COPY . .',
        'ENV PORT=80',
        'EXPOSE 80',
        'CMD ["npm", "start"]',
        '',
      ].join('\n')
    }

    throw new Error(`Cannot generate a Dockerfile for strategy "${kind}".`)
  }

  module.exports = {
    detectBuildStrategy,
    getFrontendOutputDir,
    generateDockerfile,
  }