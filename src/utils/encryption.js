const crypto = require('crypto')

  function getEncryptionKey() {
    const key = process.env.ENCRYPTION_KEY

    if (!key) {
      throw new Error('ENCRYPTION_KEY is missing.')
    }

    return Buffer.from(key, 'base64')
  }

  function encrypt(plainText) {
    const key = getEncryptionKey()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)

    const encrypted = Buffer.concat([
      cipher.update(plainText, 'utf8'),
      cipher.final(),
    ])
    const authTag = cipher.getAuthTag()

    return [iv, authTag, encrypted]
      .map((buffer) => buffer.toString('base64'))
      .join('.')
  }

  function decrypt(encryptedValue) {
    const key = getEncryptionKey()
    const [ivPart, authTagPart, encryptedPart] = encryptedValue.split('.')

    const iv = Buffer.from(ivPart, 'base64')
    const authTag = Buffer.from(authTagPart, 'base64')
    const encrypted = Buffer.from(encryptedPart, 'base64')

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8')
  }

module.exports = {
    encrypt,
    decrypt,
}