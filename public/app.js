const $=(s,r=document)=>r.querySelector(s);const $$=(s,r=document)=>[...r.querySelectorAll(s)];const money=n=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(n);
function emi(p,r,months){const m=r/1200;return m? p*m*Math.pow(1+m,months)/(Math.pow(1+m,months)-1):p/months}
function updateLoan(){const p=Number($("#loanAmount")?.value||2500000),r=Number($("#loanRate")?.value||9),y=Number($("#loanYears")?.value||20),v=emi(p,r,y*12);if($("#emiValue"))$("#emiValue").textContent=money(v);if($("#loanPrincipal"))$("#loanPrincipal").textContent=money(p);if($("#loanInterest"))$("#loanInterest").textContent=money(v*y*12-p);["loanAmount","loanRate","loanYears"].forEach(id=>{const el=$("#"+id),out=$("#"+id+"Out");if(el&&out)out.textContent=id==="loanAmount"?money(Number(el.value)):el.value+(id==="loanRate"?"%":" years")})}
function updateFD(){const p=Number($("#fdAmount")?.value||100000),rate=Number($("#fdRate")?.value||7),years=Number($("#fdYears")?.value||3),n=4;const total=p*Math.pow(1+rate/100/n,n*years);if($("#fdMaturity"))$("#fdMaturity").textContent=money(total);if($("#fdInterest"))$("#fdInterest").textContent=money(total-p)}
["loanAmount","loanRate","loanYears","fdAmount","fdRate","fdYears"].forEach(id=>$("#"+id)?.addEventListener("input",id.startsWith("fd")?updateFD:updateLoan));updateLoan();updateFD();
$$("[data-tab]").forEach(btn=>btn.addEventListener("click",()=>{$$("[data-tab]").forEach(x=>x.classList.toggle("active",x===btn));$$("[data-panel]").forEach(x=>x.classList.toggle("hidden",x.dataset.panel!==btn.dataset.tab))}));
const stepEls=$$("[data-step]");let step=0;function showStep(){stepEls.forEach((e,i)=>e.classList.toggle("hidden",i!==step));if($("#stepProgress"))$("#stepProgress").style.width=((step+1)/stepEls.length*100)+"%";if($("#stepLabel"))$("#stepLabel").textContent="Step "+(step+1)+" of "+stepEls.length}
$("#nextStep")?.addEventListener("click",()=>{const fields=$$("[data-step]")[step].querySelectorAll("input[required],select[required]");for(const f of fields){if(!f.reportValidity())return}if(step<stepEls.length-1){step++;showStep()}else{$("#accountResult")?.classList.remove("hidden");$("#referenceId").textContent="PCB-"+Date.now().toString().slice(-8)}});$("#prevStep")?.addEventListener("click",()=>{if(step>0){step--;showStep()}});if(stepEls.length)showStep();
$("#loginForm")?.addEventListener("submit",async e=>{e.preventDefault();const role=location.pathname.split("/").pop()||"customer";const body={role,username:$("#username").value,password:$("#password").value};try{const r=await fetch("/api/demo-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error);sessionStorage.setItem("pcb-demo-session",JSON.stringify(d));location.href="/dashboard.html?role="+role}catch(err){$("#loginMessage").textContent=err.message}});
$("#transferForm")?.addEventListener("submit",async e=>{e.preventDefault();const session=JSON.parse(sessionStorage.getItem("pcb-demo-session")||"null");if(!session){alert("Please sign in to the demo portal.");return}const demoOtp=prompt("DEMO OTP challenge: enter 123456 to continue (simulation only).");if(demoOtp!=="123456"){alert("Demo verification cancelled or incorrect.");return}const r=await fetch("/api/demo/transfer",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+session.token},body:JSON.stringify({beneficiary:$("#beneficiary").value,amount:$("#transferAmount").value,rail:$("#rail").value})});const d=await r.json();$("#transferMessage").textContent=d.message||d.error;if(r.status===401){sessionStorage.removeItem("pcb-demo-session");location.replace("/login/customer")}});
$("#exportCsv")?.addEventListener("click",()=>{const rows=[["Date","Description","Type","Amount"],["2026-11-03","Demo salary credit","Credit","42000"],["2026-11-02","Utility payment simulation","Debit","1850"]];const csv=rows.map(x=>x.join(",")).join("\n");const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download="pcb-demo-statement.csv";a.click();URL.revokeObjectURL(a.href)});
const role=new URLSearchParams(location.search).get("role");if($("#dashboardRole"))$("#dashboardRole").textContent=(role||"customer").toUpperCase()+" DEMO CONSOLE";if($("#dashboardName")){const s=JSON.parse(sessionStorage.getItem("pcb-demo-session")||"null");$("#dashboardName").textContent=s?.displayName||"Demo User"};if($("#loginRole"))$("#loginRole").textContent=(location.pathname.split("/").pop()||"customer").toUpperCase();


/* Prototype-only security UX: client-side idle warning and demo step-up challenge.
   Production sessions must be enforced server-side with secure, HttpOnly cookies. */
(function securityDemo(){
  const session=JSON.parse(sessionStorage.getItem("pcb-demo-session")||"null");
  if(location.pathname==="/dashboard.html"){
    const expected=new URLSearchParams(location.search).get("role");
    if(!session || !expected || session.role!==expected){location.replace("/login/"+(expected||"customer"));return;}
    let idleTimer,warningTimer;
    const lock=()=>{sessionStorage.removeItem("pcb-demo-session");alert("Demo session expired due to inactivity.");location.replace("/login/"+expected)};
    const reset=()=>{clearTimeout(idleTimer);clearTimeout(warningTimer);warningTimer=setTimeout(()=>alert("Your demo session will expire soon due to inactivity."),13*60*1000);idleTimer=setTimeout(lock,15*60*1000)};
    ["click","keydown","mousemove","touchstart"].forEach(evt=>document.addEventListener(evt,reset,{passive:true}));
    reset();
  }
  const transfer=$("#transferForm");
  if(transfer)transfer.addEventListener("submit",e=>{
    // Existing submit handler performs the mock API request. This handler only documents
    // that a demo OTP challenge is not a real authentication factor.
  },true);
})();


/* Server-validated demo identity and sample statement. */
(async function loadDemoWorkspace(){
  if(location.pathname!=="/dashboard.html") return;
  const stored=JSON.parse(sessionStorage.getItem("pcb-demo-session")||"null");
  if(!stored?.token) return;
  try{
    const response=await fetch("/api/demo/session",{headers:{Authorization:"Bearer "+stored.token}});
    if(!response.ok) throw new Error("Demo session expired");
    const identity=await response.json();
    if(identity.role!==new URLSearchParams(location.search).get("role")) throw new Error("Role mismatch");
    if($("#dashboardName")) $("#dashboardName").textContent=identity.displayName;
    const summaryResponse=await fetch("/api/demo/summary",{headers:{Authorization:"Bearer "+stored.token}});
    if(!summaryResponse.ok) throw new Error("Could not load demo summary");
    const summary=await summaryResponse.json();
    const balance=$(".metric");
    if(balance) balance.textContent=money(summary.account.availableBalance);
    const target=$("#demoTransactions");
    if(target) target.innerHTML=summary.transactions.map(tx=>`<tr><td>${tx.date}</td><td>${tx.description}</td><td>${tx.type}</td><td>${money(tx.amount)}</td><td>${tx.status}</td></tr>`).join("");
  }catch(error){
    sessionStorage.removeItem("pcb-demo-session");
    location.replace("/login/"+(new URLSearchParams(location.search).get("role")||"customer"));
  }
})();
$("#logoutBtn")?.addEventListener("click",async()=>{
  const stored=JSON.parse(sessionStorage.getItem("pcb-demo-session")||"null");
  if(stored?.token) await fetch("/api/demo-logout",{method:"POST",headers:{Authorization:"Bearer "+stored.token}}).catch(()=>{});
  sessionStorage.removeItem("pcb-demo-session");
  location.replace("/login/customer");
});

// Role portal implementation is loaded separately on auth and dashboard pages.
