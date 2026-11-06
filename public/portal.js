const $=s=>document.querySelector(s);
const roleNames={customer:"Customer",branch:"Branch Operations",staff:"Branch Staff",manager:"Branch Manager",headquarters:"Headquarters"};
const role=location.pathname.split("/").pop();
const showMessage=(id,msg)=>{const el=$(id);if(el)el.textContent=msg};
async function api(url,options={}){const r=await fetch(url,{credentials:"same-origin",headers:{"Content-Type":"application/json",...(options.headers||{})},...options});const d=await r.json().catch(()=>({error:"Unexpected server response"}));if(!r.ok)throw new Error(d.error||"Request failed");return d}
if($("#loginRole")){
 $("#loginRole").textContent=(roleNames[role]||"Portal")+" Login";
 $("#loginDescription").textContent=role==="customer"?"Sign in or create a customer demo account.":"Sign in with a demo account provisioned by Headquarters.";
 if(role==="customer")$("#registerPanel").classList.remove("hidden");
 $("#loginForm").addEventListener("submit",async e=>{e.preventDefault();showMessage("#loginMessage","Signing in…");try{const d=await api("/api/auth/login",{method:"POST",body:JSON.stringify({role,email:$("#email").value,password:$("#password").value})});location.href="/dashboard/"+d.user.role}catch(err){showMessage("#loginMessage",err.message)}});
 $("#registerForm")?.addEventListener("submit",async e=>{e.preventDefault();showMessage("#registerMessage","Creating account…");try{await api("/api/auth/register",{method:"POST",body:JSON.stringify({name:$("#regName").value,email:$("#regEmail").value,password:$("#regPassword").value})});showMessage("#registerMessage","Account created. You can now sign in.");$("#email").value=$("#regEmail").value;$("#password").value=$("#regPassword").value}catch(err){showMessage("#registerMessage",err.message)}});
}
async function loadPortal(){
 if(!$("#portalTitle"))return;
 try{
  const me=await api("/api/auth/me");
  const u=me.user;
  const expected=location.pathname.split("/").pop();
  if(expected!==u.role)throw new Error("This account does not have access to this portal.");
  $("#portalTitle").textContent=(roleNames[u.role]||"User")+" Dashboard";
  $("#portalName").textContent=u.name;
  $("#portalBranch").textContent=u.branchName||"Head Office";
  $("#userBadge").textContent=u.role.toUpperCase();
  const stats=await api("/api/portal/summary");
  $("#statCards").innerHTML=stats.cards.map(x=>'<div class="card"><small class="muted">'+escapeHtml(x.label)+'</small><div class="metric">'+escapeHtml(x.value)+'</div></div>').join("");
  $("#mainPanelTitle").textContent=stats.title;
  $("#mainPanelDescription").textContent=stats.description;
  $("#roleActions").innerHTML=stats.actions.map(x=>'<div class="card"><b>'+x.title+'</b><p class="muted">'+x.description+'</p></div>').join("");
  if(u.role!=="headquarters"&&u.role!=="manager")$("#createUserCard").classList.add("hidden");
  if(["customer","staff"].includes(u.role))$("#directoryCard").classList.add("hidden");
  if(u.role==="manager")$("#newRole").innerHTML='<option value="staff">Branch staff</option>';
  if(u.role==="manager")$("#newBranch").value=u.branchName||"";
  if(u.role==="manager")$("#newBranch").readOnly=true;
  await loadDirectory();
 }catch(err){location.replace("/login/"+(roleNames[location.pathname.split("/").pop()]?location.pathname.split("/").pop():"customer"))}
}
async function loadDirectory(){
 try{
  const data=await api("/api/portal/users");
  $("#userRows").innerHTML=data.users.map(u=>'<tr><td>'+escapeHtml(u.name)+'</td><td>'+escapeHtml(u.email)+'</td><td>'+escapeHtml(u.role)+'</td><td>'+escapeHtml(u.branch_name||"—")+'</td><td>'+new Date(u.created_at).toLocaleDateString()+'</td></tr>').join("")||'<tr><td colspan="5">No user records found.</td></tr>';
  $("#auditRows").innerHTML=data.audit.map(a=>'<tr><td>'+new Date(a.created_at).toLocaleString()+'</td><td>'+escapeHtml(a.actor_name||"System")+'</td><td>'+escapeHtml(a.action)+'</td><td>'+escapeHtml(a.details||"")+'</td></tr>').join("")||'<tr><td colspan="4">No activity yet.</td></tr>';
 }catch(err){showMessage("#directoryMessage",err.message)}
}
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
$("#createUserForm")?.addEventListener("submit",async e=>{e.preventDefault();showMessage("#createUserMessage","Creating account…");try{await api("/api/portal/users",{method:"POST",body:JSON.stringify({name:$("#newName").value,email:$("#newEmail").value,password:$("#newPassword").value,role:$("#newRole").value,branchName:$("#newBranch").value})});showMessage("#createUserMessage","Demo login created successfully.");e.target.reset();await loadDirectory()}catch(err){showMessage("#createUserMessage",err.message)}});
$("#refreshUsers")?.addEventListener("click",loadDirectory);
$("#logoutBtn")?.addEventListener("click",async()=>{try{await api("/api/auth/logout",{method:"POST",body:"{}"})}finally{location.href="/"}});
loadPortal();
