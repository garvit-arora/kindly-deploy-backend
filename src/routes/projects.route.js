const express = require('express');
const prisma = require('../lib/prisma');
const requireAuth = require('../middlewares/requireAuth');

const router = express.Router()

router.use(requireAuth)

router.post('/',async(req,res)=>{
    const {name,repositoryUrl,branch} = req.body;
    const normalizedName = typeof name==="string"?name.trim():"";
    const normalizedRepositoryUrl = typeof repositoryUrl==="string"?repositoryUrl.trim():""
    const normalizedBranch = typeof branch ==="string"?branch.trim():"";
    if(!normalizedName){
        return res.status(400).json({
            message:"Project name is required."
        })
    }
    try {
        const project = await prisma.project.create({
            data:{
                name:normalizedName,
                userId:req.user.id,
                ...(normalizedRepositoryUrl &&{
                    repositoryUrl:normalizedRepositoryUrl
                }),
                ...(normalizedBranch && {
                    branch:normalizedBranch,
                })
            }
        })
        return res.status(201).json({
            project
        })
    } catch (error) {
        console.error("Project Creation Failed",error);
        return res.status(500).json({
            message:"Couldn't create project"
        })
        
    }
})

router.get('/',async(req,res)=>{
    try {
        const projects=await prisma.project.findMany({
            where:{
                userId:req.user.id,
            },
            orderBy:{
                createdAt:'desc'
            },
        })
        return res.status(200).json({
            projects
        })
    } catch (error) {
        console.error("Project Listing Failed",error);
        return res.status(500).json({
            message:"Couldn't Load Projects",
        })
        
    }
})

module.exports=router