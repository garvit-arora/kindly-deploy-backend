const express = require('express');
const cors = require('cors')
const prisma = require('./lib/prisma');
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
        name:req.user.name
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

module.exports = app;