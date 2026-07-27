const prisma=require('../lib/prisma');
const {hashSessionToken} = require('../utils/session')

async function requireAuth(req,res,next) {
    const sessionToken = req.cookies.kindlydeploy_session
    if(!sessionToken){
        return res.status(401).json({
            message:"You are not signed in.",
        })
    }
    try {
        const session = await prisma.session.findUnique({
            where:{
                tokenHash:hashSessionToken(sessionToken),
            },
            include:{
                user:true
            }
        })
        if(!session || session.expiresAt<=new Date()){
            if(session){
                await prisma.session.delete({
                    where:{id:session.id}
                })
            }
            return res.status(401).json({
                message:"Your session is invalid or expired."
            })
        }
        req.user = session.user
        req.session = {
            id:session.id,
            expiresAt:session.expiresAt
        }
        return next()
        
    } catch (error) {
        console.error('Authentication Middleware Failed',error);
        return res.status(500).json({
            message:"Couldn't verify your session."
        })
        
    }
}

module.exports=requireAuth;