require("dotenv").config();
const express=require("express");
const session=require("express-session");
const MongoStore=require("connect-mongo");
const {MongoClient,ObjectId}=require("mongodb");
const bcrypt=require("bcryptjs");
const helmet=require("helmet");
const rateLimit=require("express-rate-limit");
const path=require("path");

const app=express();
const client=new MongoClient(process.env.MONGODB_URI||"mongodb://127.0.0.1:27017");
const dbName=process.env.MONGODB_DB||"pradhan_capitals";
let db;
const roles=["customer","branch","staff","manager","cashier","headquarters","admin"];
if(process.env.NODE_ENV==="production"&&(!process.env.MONGODB_URI||!process.env.SESSION_SECRET))throw new Error("Set MONGODB_URI and SESSION_SECRET.");

app.disable("x-powered-by");
app.set("trust proxy",1);
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"32kb"}));
app.use("/api",rateLimit({windowMs:60000,limit:60}));
app.use(session({name:"pcb.sid",secret:process.env.SESSION_SECRET||"local-dev-secret-change-me",resave:false,saveUninitialized:false,rolling:true,store:MongoStore.create({client,dbName,collectionName:"sessions",ttl:900}),cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:900000}}));
app.use(express.static(path.join(__dirname,"public")));

const users=()=>db.collection("users");
const logs=()=>db.collection("audit_logs");
const requests=()=>db.collection("demo_requests");
const emailOk=v=>typeof v==="string"&&/^\S+@\S+\.\S+$/.test(v);
const signed=(req,res,next)=>req.session.user?next():res.status(401).json({error:"Please sign in."});
const permit=(...allowed)=>(req,res,next)=>signed(req,res,()=>allowed.includes(req.session.user.role)?next():res.status(403).json({error:"Not permitted."}));
const publicUser=u=>({id:String(u._id),name:u.name,email:u.email,role:u.role,branchName:u.branchName||null,createdAt:u.createdAt});
async function audit(u,action,details){await logs().insertOne({actorId:u?.id||null,actorName:u?.name||"System",action,details:String(details||"").slice(0,500),createdAt:new Date()});}
async function initialise(){
 await client.connect();db=client.db(dbName);
 await users().createIndex({email:1},{unique:true});
 await users().createIndex({role:1,branchName:1,isActive:1});
 await logs().createIndex({createdAt:-1});
 await requests().createIndex({reference:1},{unique:true});
 await requests().createIndex({userId:1,status:1});
 const siteAdminEmail=process.env.BOOTSTRAP_SITE_ADMIN_EMAIL?.trim().toLowerCase();
 if(siteAdminEmail&&process.env.BOOTSTRAP_SITE_ADMIN_PASSWORD&&!await users().findOne({email:siteAdminEmail})){
  const inserted=await users().insertOne({name:"Website Administrator",email:siteAdminEmail,passwordHash:await bcrypt.hash(process.env.BOOTSTRAP_SITE_ADMIN_PASSWORD,12),role:"admin",branchName:"Website Administration",isActive:true,createdAt:new Date()});
  await audit({id:String(inserted.insertedId),name:"System"},"BOOTSTRAP_SITE_ADMIN","Website administrator provisioned");
 }
 const email=process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
 if(email&&process.env.BOOTSTRAP_ADMIN_PASSWORD&&!await users().findOne({email})){
  const inserted=await users().insertOne({name:"Headquarters Administrator",email,passwordHash:await bcrypt.hash(process.env.BOOTSTRAP_ADMIN_PASSWORD,12),role:"headquarters",branchName:"Head Office",isActive:true,createdAt:new Date()});
  await audit({id:String(inserted.insertedId),name:"System"},"BOOTSTRAP_HQ","Headquarters account provisioned");
 }
}

app.get("/api/health",async(req,res)=>{try{await db.command({ping:1});res.json({status:"ok",database:"connected",databaseType:"MongoDB",mode:"prototype"});}catch(e){res.status(503).json({status:"degraded",database:"unavailable",databaseType:"MongoDB"});}});
app.post("/api/auth/register",async(req,res)=>{try{
 const {name,email,password}=req.body||{};
 if(typeof name!=="string"||name.trim().length<2||name.length>80||!emailOk(email)||typeof password!=="string"||password.length<10||password.length>128)return res.status(400).json({error:"Enter a valid name, email and password (10–128 characters)."});
 await users().insertOne({name:name.trim(),email:email.toLowerCase().trim(),passwordHash:await bcrypt.hash(password,12),role:"customer",isActive:true,createdAt:new Date()});
 res.status(201).json({ok:true,message:"Customer demo account created. Sign in to continue."});
 }catch(e){res.status(e.code===11000?409:500).json({error:e.code===11000?"Email already exists.":"Could not create account."});}});
app.post("/api/auth/login",async(req,res)=>{try{
 const {role,email,password}=req.body||{};
 if(!roles.includes(role)||!emailOk(email)||typeof password!=="string")return res.status(400).json({error:"Invalid login details."});
 const u=await users().findOne({email:email.toLowerCase().trim(),isActive:true});
 if(!u||u.role!==role||!await bcrypt.compare(password,u.passwordHash))return res.status(401).json({error:"Email, password or selected portal is incorrect."});
 req.session.user=publicUser(u);await audit(req.session.user,"LOGIN",role+" portal login");
 req.session.save(err=>err?res.status(500).json({error:"Could not start session."}):res.json({ok:true,user:req.session.user}));
 }catch(e){res.status(500).json({error:"Login service unavailable."});}});
app.get("/api/auth/me",signed,(req,res)=>res.json({user:req.session.user}));
app.post("/api/auth/logout",signed,async(req,res)=>{await audit(req.session.user,"LOGOUT","Signed out");req.session.destroy(()=>{res.clearCookie("pcb.sid");res.json({ok:true});});});

app.get("/api/portal/summary",signed,async(req,res)=>{
 const u=req.session.user,r=u.role;
 const grouped=await users().aggregate([{$match:{isActive:true}},{$group:{_id:"$role",total:{$sum:1}}}]).toArray();
 const counts=Object.fromEntries(grouped.map(x=>[x._id,x.total]));
 let cards;
 if(r==="headquarters")cards=[{label:"Total demo users",value:counts.customer||0},{label:"Branches",value:counts.branch||0},{label:"Managers",value:counts.manager||0},{label:"Staff accounts",value:counts.staff||0},{label:"Cashier accounts",value:counts.cashier||0}];
 else if(r==="admin")cards=[{label:"Website role",value:"Administrator"},{label:"Management access",value:"Website"},{label:"Financial operations",value:"Disabled"},{label:"Mode",value:"Prototype"}];
 else if(r==="customer")cards=[{label:"Profile",value:"Active"},{label:"Demo requests",value:await requests().countDocuments({userId:new ObjectId(u.id)})},{label:"Service mode",value:"Simulation"},{label:"Portal",value:"Customer"}];
 else {const team=await users().countDocuments({branchName:u.branchName,role:{$in:["branch","manager","staff","cashier"]},isActive:true});cards=[{label:"Branch",value:u.branchName||"Unassigned"},{label:"Branch team",value:team},{label:"Demo requests",value:0},{label:"Workspace",value:"Active"}];}
 const titles={admin:"Website administration dashboard",headquarters:"Headquarters control centre",branch:"Branch operations dashboard",staff:"Branch staff dashboard",manager:"Branch manager dashboard",customer:"Customer dashboard"};
 const actionSets={admin:[{title:"Website administration",description:"Website administrator portal. Content publishing and settings tools can be added here."},{title:"Site health",description:"Review deployment and public website availability."},{title:"Security boundary",description:"No access to HQ, branch, manager, staff or cashier account provisioning."}],headquarters:[{title:"Organisation directory",description:"Review employee and branch accounts in MongoDB."},{title:"Access governance",description:"Provision role-based demo logins."},{title:"Platform oversight",description:"Review organisation-wide prototype metrics."},{title:"Audit trail",description:"Review recent administrative activity."}],branch:[{title:"Branch operations",description:"Review branch workspace and assigned team."},{title:"Service desk",description:"Explore sample service workflows."}],staff:[{title:"Staff workspace",description:"Explore customer assistance demo workflows."}],manager:[{title:"Team oversight",description:"Create staff accounts for your branch."},{title:"Branch activity",description:"Review branch-scoped audit events."}],customer:[{title:"My profile",description:"Review your demo customer profile."},{title:"Service requests",description:"Explore sample-only service requests."}]};res.json({title:titles[r],description:"Role-based demonstration workspace. All financial activity is simulated.",cards,actions:actionSets[r]||[]});
});
app.get("/api/portal/users",permit("headquarters","manager","branch"),async(req,res)=>{
 const u=req.session.user,filter=u.role==="headquarters"?{}:{branchName:u.branchName||""};
 const list=await users().find(filter,{projection:{passwordHash:0}}).sort({createdAt:-1}).limit(200).toArray();
 const actorIds=u.role==="headquarters"?null:(await users().find(filter,{projection:{_id:1}}).toArray()).map(x=>String(x._id));
 const activity=await logs().find(actorIds?{actorId:{$in:actorIds}}:{}).sort({createdAt:-1}).limit(50).toArray();
 res.json({users:list.map(x=>({id:String(x._id),name:x.name,email:x.email,role:x.role,branch_name:x.branchName||null,created_at:x.createdAt})),audit:activity.map(x=>({actor_name:x.actorName,action:x.action,details:x.details,created_at:x.createdAt}))});
});
app.post("/api/portal/users",permit("headquarters","manager"),async(req,res)=>{try{
 const {name,email,password,role,branchName}=req.body||{},actor=req.session.user;
 const allowed=actor.role==="headquarters"?["branch","manager","staff","cashier"].includes(role):role==="staff";
 if(!allowed)return res.status(403).json({error:"You cannot create this role."});
 if(typeof name!=="string"||name.trim().length<2||!emailOk(email)||typeof password!=="string"||password.length<10||password.length>128)return res.status(400).json({error:"Enter valid account details."});
 const branch=actor.role==="manager"?actor.branchName:String(branchName||"").trim().slice(0,100);
 if(!branch)return res.status(400).json({error:"Branch name is required."});
 const doc={name:name.trim(),email:email.toLowerCase().trim(),passwordHash:await bcrypt.hash(password,12),role,branchName:branch,isActive:true,createdAt:new Date()};
 const result=await users().insertOne(doc);await audit(actor,"USER_CREATED",role+" login created");
 res.status(201).json({ok:true,user:{id:String(result.insertedId),name:doc.name,email:doc.email,role,branch_name:branch}});
 }catch(e){res.status(e.code===11000?409:500).json({error:e.code===11000?"Email already exists.":"Could not create login."});}});

app.get("/robots.txt",(req,res)=>res.type("text").send("User-agent: *\nAllow: /\nDisallow: /login/\nDisallow: /dashboard/\nSitemap: /sitemap.xml\n"));
app.get("/sitemap.xml",(req,res)=>{const base=(process.env.PUBLIC_URL||process.env.RENDER_EXTERNAL_URL||"http://localhost:3000").replace(/\/$/,"");const pages=["","/account-opening.html","/loans.html","/fd-investments.html","/interest-rates.html"];res.type("application/xml").send(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(p=>`<url><loc>${base}${p}</loc></url>`).join("")}</urlset>`);});
app.get("/login/:role",(req,res)=>roles.includes(req.params.role)?res.sendFile(path.join(__dirname,"public","login.html")):res.sendStatus(404));
app.get("/dashboard/:role",(req,res)=>roles.includes(req.params.role)?res.sendFile(path.join(__dirname,"public","dashboard.html")):res.sendStatus(404));
app.get("*",(req,res,next)=>path.extname(req.path)?next():res.sendFile(path.join(__dirname,"public","index.html")));
initialise().then(()=>app.listen(process.env.PORT||3000,()=>console.log("MongoDB banking prototype running"))).catch(err=>{console.error("MongoDB startup failed",err);process.exit(1);});
