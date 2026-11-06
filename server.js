require("dotenv").config();
const express=require("express");
const helmet=require("helmet");
const rateLimit=require("express-rate-limit");
const session=require("express-session");
const PgSession=require("connect-pg-simple")(session);
const {Pool}=require("pg");
const bcrypt=require("bcryptjs");
const path=require("path");
const crypto=require("crypto");

if(process.env.NODE_ENV==="production"&&!process.env.SESSION_SECRET)throw new Error("SESSION_SECRET is required in production.");
const app=express();
const PORT=process.env.PORT||3000;
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:false});
const ROLE_NAMES=["customer","branch","staff","manager","headquarters"];
const STAFF_ROLES=["branch","staff","manager","headquarters"];
app.disable("x-powered-by");
app.set("trust proxy",1);
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"32kb"}));
app.use("/api",rateLimit({windowMs:60_000,limit:60,standardHeaders:true,legacyHeaders:false}));
app.use(session({
 store:new PgSession({pool,tableName:"user_sessions",createTableIfMissing:true}),
 name:"pcb.sid",
 secret:process.env.SESSION_SECRET||"local-development-only-change-this-secret",
 resave:false,saveUninitialized:false,rolling:true,
 cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:15*60*1000}
}));
app.use(express.static(path.join(__dirname,"public")));

async function initDb(){
 await pool.query(`CREATE TABLE IF NOT EXISTS users(
 id BIGSERIAL PRIMARY KEY,name VARCHAR(80) NOT NULL,email VARCHAR(160) NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,role VARCHAR(24) NOT NULL CHECK(role IN ('customer','branch','staff','manager','headquarters')),
 branch_name VARCHAR(100),is_active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`);
 await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs(
 id BIGSERIAL PRIMARY KEY,actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
 actor_name VARCHAR(80),action VARCHAR(80) NOT NULL,details TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`);
 await pool.query(`CREATE TABLE IF NOT EXISTS demo_requests(
 id BIGSERIAL PRIMARY KEY,user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
 request_type VARCHAR(50) NOT NULL,status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
 reference VARCHAR(40) NOT NULL UNIQUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`);
 if(process.env.BOOTSTRAP_ADMIN_EMAIL&&process.env.BOOTSTRAP_ADMIN_PASSWORD){
  const email=process.env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase();
  const found=await pool.query("SELECT id FROM users WHERE email=$1",[email]);
  if(!found.rowCount){
   const hash=await bcrypt.hash(process.env.BOOTSTRAP_ADMIN_PASSWORD,12);
   const result=await pool.query("INSERT INTO users(name,email,password_hash,role,branch_name) VALUES($1,$2,$3,'headquarters','Head Office') RETURNING id",["Headquarters Administrator",email,hash]);
   await pool.query("INSERT INTO audit_logs(actor_id,actor_name,action,details) VALUES($1,$2,$3,$4)",[result.rows[0].id,"System","BOOTSTRAP_HQ","Initial headquarters login provisioned"]);
  }
 }
}
function requireAuth(req,res,next){if(!req.session.user)return res.status(401).json({error:"Please sign in."});next()}
function allow(...roles){return (req,res,next)=>{if(!req.session.user)return res.status(401).json({error:"Please sign in."});if(!roles.includes(req.session.user.role))return res.status(403).json({error:"Your role is not permitted to perform this action."});next()}}
async function audit(user,action,details){await pool.query("INSERT INTO audit_logs(actor_id,actor_name,action,details) VALUES($1,$2,$3,$4)",[user?.id||null,user?.name||"System",action,String(details||"").slice(0,500)])}
function publicUser(row){return {id:row.id,name:row.name,email:row.email,role:row.role,branchName:row.branch_name||null,createdAt:row.created_at}}

app.get("/api/health",async(_req,res)=>{try{await pool.query("SELECT 1");res.json({status:"ok",database:"connected",mode:"prototype",timestamp:new Date().toISOString()})}catch(_){res.status(503).json({status:"degraded",database:"unavailable",mode:"prototype"})}});
app.post("/api/auth/register",async(req,res)=>{
 try{
  const {name,email,password}=req.body||{};
  if(typeof name!=="string"||name.trim().length<2||name.length>80||typeof email!=="string"||!/^\S+@\S+\.\S+$/.test(email)||typeof password!=="string"||password.length<10||password.length>128)return res.status(400).json({error:"Enter a valid name, email and password (10–128 characters)."});
  const hash=await bcrypt.hash(password,12);
  await pool.query("INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'customer')",[name.trim(),email.trim().toLowerCase(),hash]);
  res.status(201).json({ok:true,message:"Customer demo account created. Sign in to continue."});
 }catch(e){res.status(e.code==="23505"?409:500).json({error:e.code==="23505"?"An account with this email already exists.":"Could not create account. Please try again."})}
});
app.post("/api/auth/login",async(req,res)=>{
 try{
  const {role,email,password}=req.body||{};
  if(!ROLE_NAMES.includes(role)||typeof email!=="string"||typeof password!=="string")return res.status(400).json({error:"Invalid login details."});
  const result=await pool.query("SELECT * FROM users WHERE email=$1 AND is_active=TRUE",[email.trim().toLowerCase()]);
  const user=result.rows[0];
  if(!user||user.role!==role||!await bcrypt.compare(password,user.password_hash))return res.status(401).json({error:"Email, password or selected portal is incorrect."});
  req.session.user=publicUser(user);
  await audit(req.session.user,"LOGIN",role+" portal login");
  req.session.save(err=>err?res.status(500).json({error:"Could not start a secure session."}):res.json({ok:true,user:publicUser(user)}));
 }catch(_){res.status(500).json({error:"Login service temporarily unavailable."})}
});
app.get("/api/auth/me",requireAuth,(req,res)=>res.json({user:req.session.user}));
app.post("/api/auth/logout",requireAuth,async(req,res)=>{await audit(req.session.user,"LOGOUT","Signed out");req.session.destroy(()=>{res.clearCookie("pcb.sid");res.json({ok:true})})});

app.get("/api/portal/summary",requireAuth,async(req,res)=>{
 const role=req.session.user.role;
 const counts=await pool.query("SELECT role,COUNT(*)::int AS total FROM users WHERE is_active=TRUE GROUP BY role");
 const map=Object.fromEntries(counts.rows.map(x=>[x.role,x.total]));
 const cards=role==="headquarters"?[
  {label:"Total demo users",value:map.customer||0},{label:"Branches",value:map.branch||0},{label:"Managers",value:map.manager||0},{label:"Staff accounts",value:map.staff||0}
 ]:role==="manager"?[
  {label:"Branch team",value:await countBranchTeam(req.session.user.branchName)},{label:"Open demo requests",value:await countRequests(req.session.user.branchName)},{label:"Branch",value:req.session.user.branchName||"Unassigned"},{label:"Workspace",value:"Active"}
 ]:role==="branch"||role==="staff"?[
  {label:"Branch",value:req.session.user.branchName||"Unassigned"},{label:"Branch team",value:await countBranchTeam(req.session.user.branchName)},{label:"Demo requests",value:await countRequests(req.session.user.branchName)},{label:"Workspace",value:"Active"}
 ]:[
  {label:"Profile",value:"Active"},{label:"Demo requests",value:await countUserRequests(req.session.user.id)},{label:"Service mode",value:"Simulation"},{label:"Portal",value:"Customer"}
 ];
 const configs={
 headquarters:["Headquarters control centre","Manage the demo organisation, provision branch and manager logins, and review platform audit events.",[{title:"Organisation directory",description:"Review branch and employee accounts stored in PostgreSQL."},{title:"Access governance",description:"Create scoped demo logins and review sign-in activity."},{title:"Platform oversight",description:"View organisation-wide prototype metrics."},{title:"Audit trail",description:"Review recent administrative actions."}]],
 branch:["Branch operations dashboard","Branch workspace for demo service queues, local staff visibility and operational summaries.",[{title:"Service desk",description:"Track sample service requests and counter workflows."},{title:"Branch roster",description:"View your assigned branch team."},{title:"Daily operations",description:"Review simulated branch activity."},{title:"Customer support",description:"Use sample-only customer workflow concepts."}]],
 staff:["Branch staff dashboard","Staff workspace for sample service requests and customer assistance workflows.",[{title:"My work queue",description:"View assigned demo tasks."},{title:"Customer assistance",description:"Explore non-production service workflows."},{title:"Request tracking",description:"Track simulated request statuses."},{title:"Activity history",description:"Review your sample activity."}]],
 manager:["Branch manager dashboard","Manage your branch team demo accounts and review branch-scoped activity.",[{title:"Team oversight",description:"Create branch staff accounts and review the roster."},{title:"Request review",description:"View sample branch requests."},{title:"Branch performance",description:"Review simulated activity counts."},{title:"Audit visibility",description:"Review branch-scoped audit events."}]],
 customer:["Customer dashboard","View your demo profile and sample service request workspace.",[{title:"My profile",description:"Review the demo identity attached to this login."},{title:"Service requests",description:"Track sample-only requests."},{title:"Statements",description:"Explore illustrative statement layouts."},{title:"Support",description:"Explore customer help workflow concepts."}]]
 };
 const [title,description,actions]=configs[role];
 res.json({cards,title,description,actions});
});
async function countBranchTeam(branch){if(!branch)return 0;const r=await pool.query("SELECT COUNT(*)::int n FROM users WHERE branch_name=$1 AND role IN ('staff','manager','branch') AND is_active=TRUE",[branch]);return r.rows[0].n}
async function countRequests(branch){if(!branch)return 0;const r=await pool.query("SELECT COUNT(*)::int n FROM demo_requests d JOIN users u ON u.id=d.user_id WHERE u.branch_name=$1 AND d.status='PENDING'",[branch]);return r.rows[0].n}
async function countUserRequests(id){const r=await pool.query("SELECT COUNT(*)::int n FROM demo_requests WHERE user_id=$1",[id]);return r.rows[0].n}

app.get("/api/portal/users",requireAuth,async(req,res)=>{
 const u=req.session.user;
 if(!["headquarters","manager","branch"].includes(u.role))return res.status(403).json({error:"Directory access is not allowed."});
 const params=[];let where="TRUE";
 if(u.role!=="headquarters"){params.push(u.branchName||"");where="branch_name=$1"}
 const users=await pool.query("SELECT id,name,email,role,branch_name,created_at FROM users WHERE "+where+" ORDER BY created_at DESC LIMIT 200",params);
 const auditRows= u.role==="headquarters"
  ? await pool.query("SELECT actor_name,action,details,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 50")
  : await pool.query("SELECT a.actor_name,a.action,a.details,a.created_at FROM audit_logs a JOIN users u ON u.id=a.actor_id WHERE u.branch_name=$1 ORDER BY a.created_at DESC LIMIT 50",[u.branchName||""]);
 res.json({users:users.rows,audit:auditRows.rows});
});
app.post("/api/portal/users",allow("headquarters","manager"),async(req,res)=>{
 try{
  const {name,email,password,role,branchName}=req.body||{};
  const actor=req.session.user;
  const permitted=actor.role==="headquarters"?["branch","staff","manager"].includes(role):role==="staff";
  if(!permitted)return res.status(403).json({error:"You cannot create this role."});
  if(typeof name!=="string"||name.trim().length<2||name.length>80||typeof email!=="string"||!/^\S+@\S+\.\S+$/.test(email)||typeof password!=="string"||password.length<10||password.length>128)return res.status(400).json({error:"Enter a valid name, email and password (10–128 characters)."});
  const branch=actor.role==="manager"?actor.branchName:(typeof branchName==="string"?branchName.trim().slice(0,100):"");
  if(role!=="headquarters"&&!branch)return res.status(400).json({error:"A branch name is required."});
  const hash=await bcrypt.hash(password,12);
  const result=await pool.query("INSERT INTO users(name,email,password_hash,role,branch_name) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role,branch_name,created_at",[name.trim(),email.trim().toLowerCase(),hash,role,branch||null]);
  await audit(actor,"USER_CREATED",role+" login created for "+email.trim().toLowerCase());
  res.status(201).json({ok:true,user:result.rows[0]});
 }catch(e){res.status(e.code==="23505"?409:500).json({error:e.code==="23505"?"This email already has an account.":"Could not create the requested login."})}
});

app.get("/robots.txt",(_req,res)=>res.type("text").send("User-agent: *\nAllow: /\nDisallow: /login/\nDisallow: /dashboard/\nSitemap: /sitemap.xml\n"));
app.get("/sitemap.xml",(_req,res)=>{const base=(process.env.PUBLIC_URL||process.env.RENDER_EXTERNAL_URL||"http://localhost:3000").replace(/\/$/,"");const pages=["","/account-opening.html","/loans.html","/fd-investments.html","/interest-rates.html"];res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(p=>`<url><loc>${base}${p}</loc></url>`).join("")}</urlset>`)});
app.get("/login/:role",(req,res)=>ROLE_NAMES.includes(req.params.role)?res.sendFile(path.join(__dirname,"public","login.html")):res.status(404).sendFile(path.join(__dirname,"public","404.html")));
app.get("/dashboard/:role",(req,res)=>ROLE_NAMES.includes(req.params.role)?res.sendFile(path.join(__dirname,"public","dashboard.html")):res.status(404).sendFile(path.join(__dirname,"public","404.html")));
app.get("*",(req,res,next)=>{if(path.extname(req.path))return next();res.sendFile(path.join(__dirname,"public","index.html"))});

initDb().then(()=>app.listen(PORT,()=>console.log("Pradhan Capitals Bank prototype listening on "+PORT))).catch(err=>{console.error("Database initialization failed:",err);process.exit(1)});
