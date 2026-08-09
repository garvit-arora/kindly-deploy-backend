const ImageKit = require('imagekit')

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
})

function uploadDeploymentScreenshot({ filePath, deploymentId }) {
  return new Promise((resolve, reject) => {
    imagekit.upload(
      {
        file: require('fs').readFileSync(filePath),
        fileName: `${deploymentId}.png`,
        folder: '/kindlydeploy/deployments',
        useUniqueFileName: false,
      },
      (error, result) => {
        if (error) {
          reject(error)
          return
        }

        resolve(result.url)
      },
    )
  })
}

module.exports = {
  uploadDeploymentScreenshot,
}