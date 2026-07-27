const express = require('express');
const cors = require('cors')
const prisma = require('./lib/prisma');
const crypto = require('crypto')
const {
    SESSION_DURATION_MS,
    getSessionExpiresAt,
    hashSessionToken,
    createSessionToken
} = require('./utils/session');
const requireAuth = require('./middlewares/requireAuth');
const cookieParser = require('cookie-parser');
const projectRoutes=require("./routes/projects.route")
const app = express();
app.use(
    cors({
        origin:process.env.FRONTEND_URL || "http://localhost:5173",
        credentials:true,
    })
)
app.use(express.json());
app.use(cookieParser());

app.use('/api/projects',projectRoutes)
app.get('/api/health', async (req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`

        res.status(200).json({
            status: "ok",
            message: 'API and database are running.',
        })
    } catch (error) {
        console.error("Database Health check failed", error);
        res.status(503).json({
            status: "error",
            message: "Database is Unavailable"
        })
    }
})

app.post('/api/auth/dev-login', async (req, res) => {
    if (process.env.NODE_ENV == "production") {
        return res.sendStatus(404);
    }


    const { email, name } = req.body;
    const normalizedEmail = typeof email == 'string' ? email.trim().toLowerCase() : ""
    const normalizedName = typeof name == 'string' ? name.trim() : null

    if (!normalizedEmail) {
        return res.status(400).json({
            message: "Email is required."
        })
    }
    try {
        const user = await prisma.user.upsert({
            where: { email: normalizedEmail },
            update: normalizedName ? { name: normalizedName } : {},
            create: {
                email: normalizedEmail,
                name: normalizedName,
            },
        })
        const sessionToken = createSessionToken()
        await prisma.session.create({
            data: {
                tokenHash: hashSessionToken(sessionToken),
                userId: user.id,
                expiresAt: getSessionExpiresAt(),
            }
        })
        res.cookie('kindlydeploy_session', sessionToken, {
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV == "production",
            maxAge: SESSION_DURATION_MS,
        })
        return res.status(201).json({
            user:{
                id:user.id,
                email:user.email,
                name:user.name,
            },
        })
    } catch (error) {
        console.error("Development Sign in failed",error);
        return res.status(500).json({
            message:"Couldn't create the development Session !!"
        })
        
    }
})

app.get('/api/auth/me',requireAuth,async(req,res)=>{
   return res.status(200).json({
    user:{
        id:req.user.id,
        email:req.user.email,
        name:req.user.name,
        avatarUrl:req.user.avatarUrl
    }
   })
})

app.post('/api/auth/logout',async(req,res)=>{
    const sessionToken = req.cookies.kindlydeploy_session
    try {
        if(sessionToken){
            await prisma.session.deleteMany({
                where:{
                    tokenHash: hashSessionToken(sessionToken)
        }})
        }
        res.clearCookie("kindlydeploy_session",{
            httpOnly:true,
            sameSite:'lax',
            secure:process.env.NODE_ENV==="production",
        })
        return res.sendStatus(204)
    } catch (error) {
        console.log('Logout Failed',error);
        return res.status(500).json({
            message:'Could Not log Out.'
        })
        
    }
})
function isValidOAuthState(expectedState,receivedState){
    if(!expectedState|| !receivedState){
        return false;
    }
    const expected = Buffer.from(expectedState)
    const received = Buffer.from(receivedState)

    return(
        expected.length===received.length &&
        crypto.timingSafeEqual(expected,received)
    )
}
app.get('/api/auth/github',(req,res)=>{
    const {GITHUB_CLIENT_ID,GITHUB_CALLBACK_URL}=process.env
    if(!GITHUB_CLIENT_ID || !GITHUB_CALLBACK_URL){
        return res.status(500).json({
            message:"Github Authentication is not Configured."
        })
    }
    const state = crypto.randomBytes(32).toString('hex');
    res.cookie('github_oauth_state',state,{
        httpOnly:true,
        sameSite:'lax',
        secure:process.env.NODE_ENV==='production',
        maxAge:10*60*1000,
    })
    const authorizationUrl = new URL('https://github.com/login/oauth/authorize')
    authorizationUrl.searchParams.set('client_id',GITHUB_CLIENT_ID)
    authorizationUrl.searchParams.set('redirect_uri',GITHUB_CALLBACK_URL)
    authorizationUrl.searchParams.set('state',state)
    return res.redirect(authorizationUrl.toString())
})

app.get('/api/auth/github/callback',async(req,res)=>{
    const {code,state,error} = req.query;
    const savedState = req.cookies.github_oauth_state

    res.clearCookie('github_oauth_state',{
        httpOnly:true,
        sameSite:'lax',
        secure:process.env.NODE_ENV==="production",
    })
    if(error||!code||!isValidOAuthState(savedState,state)){
        return res.status(400).json({
            message:"Github verfication could not be verified."
        })
    }
    const {GITHUB_CLIENT_ID,GITHUB_CLIENT_SECRET,GITHUB_CALLBACK_URL,FRONTEND_URL} = process.env
    if(!GITHUB_CALLBACK_URL||!GITHUB_CLIENT_ID||!GITHUB_CLIENT_SECRET||!FRONTEND_URL){
        return res.status(500).json({
            message:"Github authentication isn't configured."
        })
    }
    try {
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token',{
            method:'POST',
            headers:{
                Accept:'application/json',
                'Content-Type':'application/json',
            },
            body:JSON.stringify({
                client_id:GITHUB_CLIENT_ID,
                client_secret:GITHUB_CLIENT_SECRET,
                code,
                redirect_uri:GITHUB_CALLBACK_URL
            })
        })
        const tokenData = await tokenResponse.json();
        if(!tokenResponse.ok || !tokenData.access_token){
            throw new Error('Github Token Exchange Failed.')
        }
        const userResponse=await fetch('https://api.github.com/user',{
            headers:{
                Accept:'application/vnd.github+json',
                Authorization:`Bearer ${tokenData.access_token}`,
                'User-Agent':'KindlyDeploy',
                'X-Github-Api-Version':'2022-11-28'
            },
        })
        const githubUser=await userResponse.json()
        if(!userResponse.ok || !githubUser.id){
            throw new Error('Could not load the Github user')
        }
        const user = await prisma.user.upsert({
            where:{
                githubId:String(githubUser.id)
            },
            update:{
                name:githubUser.name || githubUser.login,
                avatarUrl:githubUser.avatar_url,
            },
            create:{
                githubId:String(githubUser.id),
                name:githubUser.name || githubUser.login,
                avatarUrl:githubUser.avatar_url,
            }

        })
        const sessionToken = createSessionToken()
        await prisma.session.create({
            data:{
                tokenHash:hashSessionToken(sessionToken),
                userId:user.id,
                expiresAt:getSessionExpiresAt()
            }
        })
        res.cookie('kindlydeploy_session',sessionToken,{
            httpOnly:true,
            sameSite:'lax',
            secure:process.env.NODE_ENV==="production",
            maxAge:SESSION_DURATION_MS
        })
        return res.redirect(`${FRONTEND_URL}/dashboard/projects`)
    } catch (error) {
        console.error("Github callback Failed",error);
        return res.status(500).json({
            message:"Could not complete Github Sign In"
        })
    }
})

app.get('/api/github/install',requireAuth,(req,res)=>{
    const {GITHUB_APP_SLUG} = process.env
    if(!GITHUB_APP_SLUG){
        return res.status(500).json({
            message:"Github App installation is not configured."
        })
    }
    return res.redirect(`https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`)
})

module.exports = app;