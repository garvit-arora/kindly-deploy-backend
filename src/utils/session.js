const crypto = require('crypto')
const SESSION_DURATION_MS=7*24*60*60*1000

function createSessionToken(){
    return crypto.randomBytes(32).toString('hex')
}

function hashSessionToken(token){
    return crypto.createHash('sha256').update(token).digest('hex')
}
function getSessionExpiresAt(){
    return new Date(Date.now()+SESSION_DURATION_MS)
}

module.exports={
    SESSION_DURATION_MS,
    createSessionToken,
    hashSessionToken,
    getSessionExpiresAt
}