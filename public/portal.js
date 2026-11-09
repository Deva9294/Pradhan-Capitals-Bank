const $ = selector => document.querySelector(selector);
const roleNames = {
  customer: "Customer", branch: "Branch Operations", staff: "Branch Staff",
  manager: "Branch Manager", cashier: "Cashier", headquarters: "Headquarters",
  admin: "Website Administrator"
};
const role = location.pathname.split("/").pop();
const showMessage = (selector, message) => {
  const element = $(selector);
  if (element) element.textContent = message;
};
async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({ error: "Unexpected server response." }));
  if (!response.ok) {
    const error = new Error(data.error || "Request failed.");
    error.status = response.status;
    throw error;
  }
  return data;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

if ($("#loginRole")) {
  $("#loginRole").textContent = (roleNames[role] || "Portal") + " Login";
  $("#loginDescription").textContent = role === "customer"
    ? "Sign in or create a customer demo account."
    : "Sign in with a demo account provisioned by Headquarters or Website Administration.";
  if (role === "customer") $("#registerPanel").classList.remove("hidden");

  $("#loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    showMessage("#loginMessage", "Signing in…");
    try {
      const result = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          role,
          email: $("#email").value,
          password: $("#password").value
        })
      });
      location.href = "/dashboard/" + result.user.role;
    } catch (error) {
      showMessage("#loginMessage", error.message);
    }
  });

  $("#registerForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    showMessage("#registerMessage", "Creating account…");
    try {
      await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          name: $("#regName").value,
          email: $("#regEmail").value,
          password: $("#regPassword").value,
          branchName: $("#regBranch").value
        })
      });
      showMessage("#registerMessage", "Application submitted. Sign in to track branch review and approval.");
      $("#email").value = $("#regEmail").value;
      $("#password").value = $("#regPassword").value;
    } catch (error) {
      showMessage("#registerMessage", error.message);
    }
  });
}

async function loadSiteSettingsForm() {
  const data = await api("/api/admin/site-settings");
  const settings = data.settings || {};
  for (const field of [
    "siteName", "tagline", "announcement", "heroTitle",
    "heroDescription", "supportEmail", "supportPhone", "footerText"
  ]) {
    const input = $("#" + field);
    if (input) input.value = settings[field] || "";
  }
}
async function loadDirectory() {
  const data = await api("/api/portal/users");
  $("#userRows").innerHTML = (data.users || []).map(user => {
    const active = user.is_active !== false;
    const action = user.role === "headquarters"
      ? "Protected HQ account"
      : user.role === "admin"
        ? "Managed separately"
        : '<button class="btn outline user-status-btn" type="button" data-id="' + escapeHtml(user.id) +
          '" data-active="' + String(active) + '">' + (active ? "Deactivate" : "Activate") + "</button>";
    return "<tr><td>" + escapeHtml(user.name) + "</td><td>" + escapeHtml(user.email) +
      "</td><td>" + escapeHtml(user.role) + "</td><td>" + escapeHtml(user.branch_name || "—") +
      "</td><td>" + (active ? "Active" : "Inactive") + "</td><td>" + escapeHtml(formatDate(user.created_at)) +
      "</td><td>" + action + "</td></tr>";
  }).join("") || '<tr><td colspan="7">No user records found.</td></tr>';
  $("#auditRows").innerHTML = (data.audit || []).map(item =>
    "<tr><td>" + escapeHtml(formatDate(item.created_at)) + "</td><td>" +
    escapeHtml(item.actor_name || "System") + "</td><td>" + escapeHtml(item.action) +
    "</td><td>" + escapeHtml(item.details || "") + "</td></tr>"
  ).join("") || '<tr><td colspan="4">No activity yet.</td></tr>';
}
async function loadRequests() {
  const data = await api("/api/requests");
  const currentRole = window.currentPortalRole;
  const canUpdate = ["headquarters", "branch", "manager", "staff"].includes(currentRole);
  $("#requestRows").innerHTML = (data.requests || []).map(item => {
    const status = escapeHtml(item.status);
    const action = canUpdate
      ? '<select class="request-status" aria-label="Status for ' + escapeHtml(item.reference) + '">' +
        ["submitted", "in_review", "resolved", "closed"].map(value =>
          '<option value="' + value + '"' + (value === item.status ? " selected" : "") + ">" + value.replace("_", " ") + "</option>"
        ).join("") + '</select> <button class="btn outline request-update-btn" type="button" data-id="' +
        escapeHtml(item.id) + '">Update</button>'
      : "—";
    return "<tr><td>" + escapeHtml(item.reference) + "</td><td>" +
      escapeHtml(item.customerName || "Demo customer") + "</td><td>" +
      escapeHtml((item.type || "").replaceAll("_", " ")) + "</td><td>" +
      escapeHtml(item.branchName || "Unassigned") + "</td><td>" + status +
      "</td><td>" + escapeHtml(formatDate(item.createdAt)) + "</td><td>" + action + "</td></tr>";
  }).join("") || '<tr><td colspan="7">No demo requests found.</td></tr>';
}

async function loadAccountOpening() {
  const role = window.currentPortalRole;
  if (role === "customer") {
    const data = await api("/api/account-opening/my");
    $("#customerAccountOpening").classList.remove("hidden");
    if (data.account) {
      $("#accountOpeningStatus").textContent = "Approved — demo account " + data.account.accountNumber + " is active.";
      $("#accountOpeningDetails").textContent = "Your demo account is ready. Banking features are available below.";
      return true;
    }
    const app = data.application;
    $("#accountOpeningStatus").textContent = app ? app.status.replaceAll("_", " ").toUpperCase() : "Application not found";
    $("#accountOpeningDetails").textContent = app ? "Reference: " + app.reference + " · Branch: " + app.branchName : "Please contact the branch to submit an application.";
    return false;
  }
  if (["headquarters", "manager", "branch", "staff"].includes(role)) {
    $("#accountOpeningQueue").classList.remove("hidden");
    await loadAccountOpeningQueue();
  }
  return false;
}
async function loadAccountOpeningQueue() {
  const data = await api("/api/account-opening/queue");
  const role = window.currentPortalRole;
  $("#accountOpeningRows").innerHTML = (data.applications || []).map(item => {
    let action = "—";
    if (role === "staff" && item.status === "submitted") action = '<button class="btn outline account-review" type="button" data-id="' + escapeHtml(item.id) + '">Mark reviewed</button>';
    if (["manager", "headquarters"].includes(role) && item.status === "under_review") action = '<button class="btn outline account-decision" data-decision="approve" type="button" data-id="' + escapeHtml(item.id) + '">Approve</button> <button class="btn outline account-decision" data-decision="reject" type="button" data-id="' + escapeHtml(item.id) + '">Reject</button>';
    return "<tr><td>" + escapeHtml(item.reference) + "</td><td>" + escapeHtml(item.customerName) + "<br><small>" + escapeHtml(item.customerEmail) + "</small></td><td>" + escapeHtml(item.branchName) + "</td><td>" + escapeHtml(item.status.replaceAll("_", " ")) + "</td><td>" + escapeHtml(formatDate(item.createdAt)) + "</td><td>" + action + "</td></tr>";
  }).join("") || '<tr><td colspan="6">No account applications in this queue.</td></tr>';
}
async function loadBanking() {
  const data = await api("/api/banking/account");
  const account = data.account;
  $("#bankBalance").textContent = "₹" + Number(account.balance).toLocaleString("en-IN", { minimumFractionDigits: 2 });
  $("#bankAccountNumber").textContent = account.accountNumber;
  $("#bankIfsc").textContent = account.ifscDemo + " (demo)";
  $("#bankAccountType").textContent = account.accountType.replaceAll("_", " ");
  const statement = await api("/api/banking/transactions");
  $("#bankTransactionRows").innerHTML = (statement.transactions || []).map(item =>
    "<tr><td>" + escapeHtml(formatDate(item.createdAt)) + "</td><td>" + escapeHtml(item.reference) +
    "</td><td>" + escapeHtml((item.type || "").replaceAll("_", " ")) + "</td><td>" +
    (item.direction === "debit" ? "Debit" : "Credit") + "</td><td>" +
    (item.direction === "debit" ? "−" : "+") + "₹" + Number(item.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 }) +
    "</td><td>" + escapeHtml(item.status) + "</td></tr>"
  ).join("") || '<tr><td colspan="6">No transactions yet.</td></tr>';
}

function money(value) {
  return "₹" + Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
async function loadBeneficiaries() {
  const data = await api("/api/banking/beneficiaries");
  $("#beneficiaryRows").innerHTML = (data.beneficiaries || []).map(item =>
    "<tr><td>" + escapeHtml(item.name) + "</td><td>" + escapeHtml(item.accountNumber) +
    '</td><td><button class="btn outline beneficiary-use" type="button" data-account="' + escapeHtml(item.accountNumber) +
    '">Use</button> <button class="btn outline beneficiary-remove" type="button" data-id="' + escapeHtml(item.id) + '">Remove</button></td></tr>'
  ).join("") || '<tr><td colspan="3">No saved beneficiaries.</td></tr>';
}
async function loadFixedDeposits() {
  const data = await api("/api/banking/fixed-deposits");
  $("#fdRows").innerHTML = (data.fixedDeposits || []).map(item =>
    "<tr><td>" + escapeHtml(item.reference) + "</td><td>" + money(item.principal) +
    "</td><td>" + escapeHtml(item.rate) + "%</td><td>" + escapeHtml(item.tenureMonths) +
    " months</td><td>" + money(item.maturityAmount) + "</td><td>" + escapeHtml(formatDate(item.maturityAt)) +
    "</td><td>" + escapeHtml(item.status) + "</td></tr>"
  ).join("") || '<tr><td colspan="7">No fixed deposits yet.</td></tr>';
}

async function loadRecurringDeposits() {
  const data = await api("/api/banking/recurring-deposits");
  $("#rdRows").innerHTML = (data.recurringDeposits || []).map(item => {
    const action = item.status === "active"
      ? '<button class="btn rd-pay" type="button" data-id="' + escapeHtml(item.id) + '">Pay installment</button>'
      : "—";
    return "<tr><td>" + escapeHtml(item.reference) + "</td><td>" + money(item.monthlyAmount) +
      "</td><td>" + escapeHtml(item.rate) + "%</td><td>" + escapeHtml(item.paidInstallments) + "/" +
      escapeHtml(item.totalInstallments) + "</td><td>" + money(item.maturityAmount) +
      "</td><td>" + escapeHtml(item.nextDueAt ? formatDate(item.nextDueAt) : "—") +
      "</td><td>" + escapeHtml(item.status) + " " + action + "</td></tr>";
  }).join("") || '<tr><td colspan="7">No recurring deposits yet.</td></tr>';
}

async function loadDemoCard() {
  const data = await api("/api/banking/cards");
  const card = data.card;
  $("#demoCardPanel").innerHTML = card
    ? '<div class="row"><div><strong>PRADHAN CAPITALS BANK</strong><div class="muted">VIRTUAL DEBIT · DEMO</div></div><span class="security">' + escapeHtml(card.status.toUpperCase()) + '</span></div><h2 style="letter-spacing:3px;margin:20px 0">•••• •••• •••• ' + escapeHtml(card.last4) + '</h2><div class="row"><span>' + escapeHtml(card.holderName) + '</span><span>DEMO</span></div><p class="muted">Ref: ' + escapeHtml(card.reference) + '</p>'
      : '<p class="muted">No virtual demo card issued yet.</p>';
  $("#issueDemoCard").disabled = !!card;
  $("#issueDemoCard").textContent = card ? "Demo card already issued" : "Issue virtual demo debit card";
  $("#cardStatusAction").innerHTML = card
    ? '<button class="btn ' + (card.status === "frozen" ? "" : "outline") + '" type="button" id="toggleDemoCard">' + (card.status === "frozen" ? "Unfreeze card" : "Freeze card") + '</button>'
    : "";
}
async function loadChequeBooks() {
  const data = await api("/api/banking/cheque-books");
  $("#chequeBookRows").innerHTML = (data.chequeBooks || []).map(item =>
    "<tr><td>" + escapeHtml(item.reference) + "</td><td>" + item.leaves +
    "</td><td>" + escapeHtml(formatDate(item.requestedAt)) + "</td><td>" +
    escapeHtml(item.issuedAt ? formatDate(item.issuedAt) : "—") + "</td><td>" +
    escapeHtml(item.status) + "</td></tr>"
  ).join("") || '<tr><td colspan="5">No cheque book requests.</td></tr>';
}
async function loadChequeQueue() {
  const data = await api("/api/banking/cheque-books/queue");
  $("#chequeQueueRows").innerHTML = (data.requests || []).map(item =>
    "<tr><td>" + escapeHtml(item.reference) + "</td><td>" + escapeHtml(item.customerName) +
    "</td><td>" + item.leaves + "</td><td>" + escapeHtml(item.branchName) +
    '</td><td><button class="btn cheque-issue" type="button" data-id="' + escapeHtml(item.id) + '">Mark issued</button></td></tr>'
  ).join("") || '<tr><td colspan="5">No pending cheque book requests.</td></tr>';
}
async function loadLoans() {
  const data = await api("/api/banking/loans");
  const items = data.loans || [];
  if ($("#myLoanRows")) {
    $("#myLoanRows").innerHTML = items.map(item =>
      "<tr><td>" + escapeHtml(item.reference) + "</td><td>" + money(item.amount) +
      "</td><td>" + escapeHtml(item.tenureMonths) + " months</td><td>" +
      escapeHtml(item.purpose) + "</td><td>" + escapeHtml(item.status) +
      (item.emi ? " · EMI " + money(item.emi) + " · Rate " + escapeHtml(item.interestRate) + "% · Paid " + escapeHtml(item.paidInstallments || 0) + "/" + escapeHtml(item.tenureMonths) + " · Outstanding " + money(item.outstanding) + " · Next " + escapeHtml(item.nextDueAt ? formatDate(item.nextDueAt) : "—") : "") +
      "</td><td>" + escapeHtml(formatDate(item.createdAt)) +
      (item.status === "approved" ? '</td><td>' + money(item.emi) + ' <button class="btn loan-repay" type="button" data-id="' + escapeHtml(item.id) + '">Pay EMI</button>' : "</td><td>—") + "</td></tr>"
    ).join("") || '<tr><td colspan="6">No demo applications yet.</td></tr>';
  }
  if ($("#loanRows")) {
    const canDecide = ["headquarters", "branch", "manager"].includes(window.currentPortalRole);
    $("#loanRows").innerHTML = items.map(item => {
      const action = canDecide && item.status === "pending"
        ? '<button class="btn loan-decision" type="button" data-id="' + escapeHtml(item.id) + '" data-decision="approve">Approve</button> <button class="btn outline loan-decision" type="button" data-id="' + escapeHtml(item.id) + '" data-decision="reject">Reject</button>'
        : "—";
      return "<tr><td>" + escapeHtml(item.reference) + "</td><td>" +
        escapeHtml(item.customerName || "Demo customer") + "</td><td>" + money(item.amount) +
        "</td><td>" + escapeHtml(item.tenureMonths) + " months</td><td>" +
        escapeHtml(item.purpose) + "</td><td>" + escapeHtml(item.status) +
        (item.emi ? " · EMI " + money(item.emi) + " · Rate " + escapeHtml(item.interestRate) + "% · Paid " + escapeHtml(item.paidInstallments || 0) + "/" + escapeHtml(item.tenureMonths) + " · Outstanding " + money(item.outstanding) : "") +
        "</td><td>" + action + "</td></tr>";
    }).join("") || '<tr><td colspan="7">No demo loan applications.</td></tr>';
  }
}
async function loadCashOperations() {
  const data = await api("/api/banking/cash-operations");
  const role = window.currentPortalRole;
  const canApprove = ["headquarters", "branch", "manager"].includes(role);
  $("#cashOperationRows").innerHTML = (data.operations || []).map(item => {
    const action = item.status === "pending" && canApprove
      ? '<button class="btn outline cash-approve-btn" type="button" data-id="' + escapeHtml(item.id) + '">Approve</button>'
      : "—";
    return "<tr><td>" + escapeHtml(formatDate(item.createdAt)) + "</td><td>" + escapeHtml(item.reference) +
      "</td><td>" + escapeHtml(item.accountNumber) + "</td><td>" +
      escapeHtml(item.type.replaceAll("_", " ")) + "</td><td>₹" +
      Number(item.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 }) +
      "</td><td>" + escapeHtml(item.status) + "</td><td>" + action + "</td></tr>";
  }).join("") || '<tr><td colspan="7">No cash operations.</td></tr>';
}
async function loadPortal() {
  if (!$("#portalTitle")) return;
  try {
    const identity = await api("/api/auth/me");
    const user = identity.user;
    const expectedRole = location.pathname.split("/").pop();
    if (expectedRole !== user.role) {
      location.replace("/dashboard/" + user.role);
      return;
    }
    window.currentPortalRole = user.role;
    $("#portalTitle").textContent = roleNames[user.role] + " Dashboard";
    $("#portalName").textContent = user.name;
    $("#portalBranch").textContent = user.branchName || "Head Office";
    $("#userBadge").textContent = user.role.toUpperCase();

    const summary = await api("/api/portal/summary");
    $("#statCards").innerHTML = summary.cards.map(card =>
      '<div class="card"><small class="muted">' + escapeHtml(card.label) +
      '</small><div class="metric">' + escapeHtml(card.value) + "</div></div>"
    ).join("");
    $("#mainPanelTitle").textContent = summary.title;
    $("#mainPanelDescription").textContent = summary.description;
    $("#roleActions").innerHTML = summary.actions.map(action =>
      '<div class="card"><b>' + escapeHtml(action.title) + '</b><p class="muted">' +
      escapeHtml(action.description) + "</p></div>"
    ).join("");

    const role = user.role;
    if (["headquarters", "manager"].includes(role)) $("#createUserCard").classList.remove("hidden");
    if (role === "manager") {
      $("#newRole").innerHTML = '<option value="staff">Branch staff</option>';
      $("#newBranch").value = user.branchName || "";
      $("#newBranch").readOnly = true;
    }
    if (role === "admin") {
      $("#siteSettingsCard").classList.remove("hidden");
      await loadSiteSettingsForm();
    }
    if (role === "customer") {
      $("#customerRequestCard").classList.remove("hidden");
      const approved = await loadAccountOpening();
      if (approved) {
        $("#customerBankingCard").classList.remove("hidden");
        $("#customerProductsCard").classList.remove("hidden");
        $("#customerRDCard").classList.remove("hidden");
        $("#customerLoanCard").classList.remove("hidden");
        $("#customerCardCheque").classList.remove("hidden");
        await Promise.all([loadBanking(), loadBeneficiaries(), loadFixedDeposits(), loadRecurringDeposits(), loadLoans(), loadDemoCard(), loadChequeBooks()]);
      }
    }
    if (["headquarters", "manager", "branch", "staff"].includes(role)) await loadAccountOpening();
    if (["headquarters", "branch", "manager"].includes(role)) {
      $("#loanOperationsCard").classList.remove("hidden");
      $("#chequeBookQueue").classList.remove("hidden");
      await Promise.all([loadLoans(), loadChequeQueue()]);
    }
    if (["cashier", "branch", "manager", "headquarters"].includes(role)) {
      $("#cashierBankingCard").classList.remove("hidden");
      await loadCashOperations();
    }
    if (["customer", "headquarters", "branch", "manager", "staff"].includes(role)) {
      $("#requestsCard").classList.remove("hidden");
      await loadRequests();
    }
    if (["headquarters", "manager", "branch"].includes(role)) {
      $("#directoryCard").classList.remove("hidden");
      $("#auditCard").classList.remove("hidden");
      await loadDirectory();
    } else {
      $("#auditCard").classList.add("hidden");
    }
  } catch (error) {
    if (error.status === 401) {
      location.replace("/login/" + (roleNames[location.pathname.split("/").pop()] ? location.pathname.split("/").pop() : "customer"));
      return;
    }
    showMessage("#mainPanelDescription", error.message);
  }
}

$("#createUserForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  showMessage("#createUserMessage", "Creating account…");
  try {
    await api("/api/portal/users", {
      method: "POST",
      body: JSON.stringify({
        name: $("#newName").value,
        email: $("#newEmail").value,
        password: $("#newPassword").value,
        role: $("#newRole").value,
        branchName: $("#newBranch").value
      })
    });
    showMessage("#createUserMessage", "Demo login created successfully.");
    event.target.reset();
    if (window.currentPortalRole === "manager") {
      $("#newBranch").value = $("#portalBranch").textContent;
      $("#newBranch").readOnly = true;
    }
    await loadDirectory();
  } catch (error) {
    showMessage("#createUserMessage", error.message);
  }
});

$("#siteSettingsForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  showMessage("#siteSettingsMessage", "Saving…");
  const payload = {};
  for (const field of [
    "siteName", "tagline", "announcement", "heroTitle",
    "heroDescription", "supportEmail", "supportPhone", "footerText"
  ]) payload[field] = $("#" + field).value;
  try {
    await api("/api/admin/site-settings", { method: "PUT", body: JSON.stringify(payload) });
    showMessage("#siteSettingsMessage", "Saved to MongoDB. Public homepage updated.");
  } catch (error) {
    showMessage("#siteSettingsMessage", error.message);
  }
});


$("#demoTransferForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  showMessage("#transferMessage", "Processing internal demo transfer…");
  try {
    const result = await api("/api/banking/transfer", {
      method: "POST", body: JSON.stringify({
        accountNumber: $("#transferAccount").value,
        amount: $("#transferAmount").value,
        note: $("#transferNote").value
      })
    });
    showMessage("#transferMessage", "Demo transfer successful. Reference: " + result.reference + " · New balance ₹" + result.balance);
    event.target.reset();
    await loadBanking();
  } catch (error) { showMessage("#transferMessage", error.message); }
});
$("#refreshBanking")?.addEventListener("click", loadBanking);

$("#downloadStatement")?.addEventListener("click", async () => {
  try {
    const [accountData, statement] = await Promise.all([api("/api/banking/account"), api("/api/banking/transactions")]);
    const account = accountData.account;
    const rows = (statement.transactions || []).map(item =>
      "<tr><td>" + escapeHtml(formatDate(item.createdAt)) + "</td><td>" + escapeHtml(item.reference) +
      "</td><td>" + escapeHtml((item.type || "").replaceAll("_", " ")) + "</td><td>" +
      escapeHtml(item.direction) + "</td><td>" + money(item.amount) + "</td><td>" + escapeHtml(item.status) + "</td></tr>"
    ).join("");
    const printWindow = window.open("", "_blank");
    if (!printWindow) throw new Error("Allow pop-ups to create your statement PDF.");
    printWindow.document.write("<!doctype html><html><head><title>Demo Passbook Statement</title><style>body{font:14px Arial,sans-serif;padding:28px;color:#111}h1{margin-bottom:4px}p{color:#444}.notice{border:1px solid #999;padding:10px;margin:16px 0}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{border:1px solid #bbb;padding:8px;text-align:left;font-size:11px}th{background:#eee}</style></head><body><h1>Pradhan Capitals Bank</h1><h2>Demo Passbook / Account Statement</h2><p>Account: " +
      escapeHtml(account.accountNumber) + " · Type: " + escapeHtml(account.accountType) + " · Demo balance: " + money(account.balance) +
      "</p><div class='notice'>DEMO STATEMENT ONLY — not a bank statement or proof of funds. No real banking transaction has occurred.</div><table><thead><tr><th>Date</th><th>Reference</th><th>Type</th><th>Direction</th><th>Amount</th><th>Status</th></tr></thead><tbody>" +
      (rows || "<tr><td colspan='6'>No transactions recorded.</td></tr>") +
      "</tbody></table><p>Generated: " + escapeHtml(new Date().toLocaleString()) + "</p><button onclick='window.print()'>Print / Save as PDF</button></body></html>");
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  } catch (error) { showMessage("#transferMessage", error.message); }
});

$("#cashOperationForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  showMessage("#cashOperationMessage", "Submitting for approval…");
  try {
    const result = await api("/api/banking/cash-operations", {
      method: "POST", body: JSON.stringify({
        accountNumber: $("#cashAccount").value, type: $("#cashType").value,
        amount: $("#cashAmount").value, note: $("#cashNote").value
      })
    });
    showMessage("#cashOperationMessage", "Submitted: " + result.reference + " · Pending approval.");
    event.target.reset();
    await loadCashOperations();
  } catch (error) { showMessage("#cashOperationMessage", error.message); }
});
$("#refreshCashOperations")?.addEventListener("click", loadCashOperations);
$("#cashOperationRows")?.addEventListener("click", async event => {
  const button = event.target.closest(".cash-approve-btn");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api("/api/banking/cash-operations/" + encodeURIComponent(button.dataset.id) + "/approve", {
      method: "PATCH", body: JSON.stringify({})
    });
    showMessage("#cashOperationMessage", "Approved: " + result.reference);
    await loadCashOperations();
  } catch (error) {
    showMessage("#cashOperationMessage", error.message);
    button.disabled = false;
  }
});

$("#beneficiaryForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  showMessage("#beneficiaryMessage", "Saving beneficiary…");
  try {
    const result = await api("/api/banking/beneficiaries", {
      method: "POST", body: JSON.stringify({
        name: $("#beneficiaryName").value,
        accountNumber: $("#beneficiaryAccount").value
      })
    });
    showMessage("#beneficiaryMessage", "Saved: " + result.beneficiary.accountNumber);
    event.target.reset();
    await loadBeneficiaries();
  } catch (error) { showMessage("#beneficiaryMessage", error.message); }
});
$("#beneficiaryRows")?.addEventListener("click", async event => {
  const use = event.target.closest(".beneficiary-use");
  if (use) {
    $("#transferAccount").value = use.dataset.account;
    $("#transferAccount").focus();
    showMessage("#transferMessage", "Beneficiary selected. Enter amount to continue.");
    return;
  }
  const remove = event.target.closest(".beneficiary-remove");
  if (!remove) return;
  remove.disabled = true;
  try {
    await api("/api/banking/beneficiaries/" + encodeURIComponent(remove.dataset.id), { method: "DELETE" });
    await loadBeneficiaries();
  } catch (error) {
    showMessage("#beneficiaryMessage", error.message);
    remove.disabled = false;
  }
});
$("#fdForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  showMessage("#fdMessage", "Opening simulated fixed deposit…");
  try {
    const result = await api("/api/banking/fixed-deposits", {
      method: "POST", body: JSON.stringify({ amount: $("#fdAmount").value, tenureMonths: $("#fdTenure").value })
    });
    showMessage("#fdMessage", "Demo FD opened: " + result.reference + " · Maturity estimate " + money(result.maturityAmount));
    event.target.reset();
    await Promise.all([loadBanking(), loadFixedDeposits()]);
  } catch (error) { showMessage("#fdMessage", error.message); }
});
$("#refreshFDs")?.addEventListener("click", async () => {
  await Promise.all([loadFixedDeposits(), loadBanking()]);
});

$("#rdForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  showMessage("#rdMessage", "Opening demo recurring deposit…");
  try {
    const result = await api("/api/banking/recurring-deposits", {
      method: "POST", body: JSON.stringify({ monthlyAmount: $("#rdMonthlyAmount").value, tenureMonths: $("#rdTenure").value })
    });
    showMessage("#rdMessage", "Demo RD opened: " + result.reference + " · Estimated maturity " + money(result.maturityAmount));
    event.target.reset();
    await loadRecurringDeposits();
  } catch (error) { showMessage("#rdMessage", error.message); }
});
$("#refreshRDs")?.addEventListener("click", loadRecurringDeposits);

$("#issueDemoCard")?.addEventListener("click", async () => {
  $("#issueDemoCard").disabled = true;
  try {
    await api("/api/banking/cards", { method: "POST", body: "{}" });
    showMessage("#cardMessage", "Virtual demo debit card issued.");
    await loadDemoCard();
  } catch (error) { showMessage("#cardMessage", error.message); $("#issueDemoCard").disabled = false; }
});
$("#demoCardPanel")?.addEventListener("click", async event => {
  if (event.target.id !== "toggleDemoCard") return;
  const data = await api("/api/banking/cards");
  const next = data.card.status === "frozen" ? "active" : "frozen";
  try {
    await api("/api/banking/cards/status", { method: "PATCH", body: JSON.stringify({ status: next }) });
    showMessage("#cardMessage", "Demo card " + next + ".");
    await loadDemoCard();
  } catch (error) { showMessage("#cardMessage", error.message); }
});
$("#chequeBookForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const result = await api("/api/banking/cheque-books", { method: "POST", body: JSON.stringify({ leaves: $("#chequeLeaves").value }) });
    showMessage("#chequeMessage", "Request submitted: " + result.reference);
    await loadChequeBooks();
  } catch (error) { showMessage("#chequeMessage", error.message); }
});
$("#refreshChequeQueue")?.addEventListener("click", loadChequeQueue);
$("#chequeQueueRows")?.addEventListener("click", async event => {
  const button = event.target.closest(".cheque-issue");
  if (!button) return;
  button.disabled = true;
  try {
    await api("/api/banking/cheque-books/" + encodeURIComponent(button.dataset.id) + "/issue", { method: "PATCH", body: "{}" });
    showMessage("#chequeQueueMessage", "Cheque book marked as issued.");
    await loadChequeQueue();
  } catch (error) { showMessage("#chequeQueueMessage", error.message); button.disabled = false; }
});

$("#rdRows")?.addEventListener("click", async event => {
  const button = event.target.closest(".rd-pay");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api("/api/banking/recurring-deposits/" + encodeURIComponent(button.dataset.id) + "/pay", {
      method: "POST", body: "{}"
    });
    showMessage("#rdMessage", "Installment " + result.installmentNumber + " paid: " + money(result.paidAmount) +
      (result.status === "matured" ? " · Maturity credited: " + money(result.maturityAmount) : ""));
    await Promise.all([loadRecurringDeposits(), loadBanking()]);
  } catch (error) {
    showMessage("#rdMessage", error.message);
    button.disabled = false;
  }
});

$("#loanForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  showMessage("#loanMessage", "Submitting demo loan application…");
  try {
    const result = await api("/api/banking/loans", {
      method: "POST", body: JSON.stringify({
        amount: $("#loanAmount").value, tenureMonths: $("#loanTenure").value,
        purpose: $("#loanPurpose").value
      })
    });
    showMessage("#loanMessage", "Application submitted: " + result.reference + " · Pending demo review.");
    event.target.reset();
    await loadLoans();
  } catch (error) { showMessage("#loanMessage", error.message); }
});

$("#myLoanRows")?.addEventListener("click", async event => {
  const button = event.target.closest(".loan-repay");
  if (!button) return;
  button.disabled = true;
  showMessage("#loanMessage", "Processing demo EMI payment…");
  try {
    const result = await api("/api/banking/loans/" + encodeURIComponent(button.dataset.id) + "/repay", {
      method: "POST", body: "{}"
    });
    showMessage("#loanMessage", "EMI " + result.installmentNumber + " paid: " + money(result.paidAmount) +
      " · Outstanding " + money(result.outstanding) + " · " + result.status);
    await Promise.all([loadLoans(), loadBanking()]);
  } catch (error) {
    showMessage("#loanMessage", error.message);
    button.disabled = false;
  }
});
$("#refreshMyLoans")?.addEventListener("click", loadLoans);
$("#refreshLoans")?.addEventListener("click", loadLoans);
$("#loanRows")?.addEventListener("click", async event => {
  const button = event.target.closest(".loan-decision");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api("/api/banking/loans/" + encodeURIComponent(button.dataset.id) + "/decision", {
      method: "PATCH", body: JSON.stringify({ decision: button.dataset.decision, note: "Demo workflow decision" })
    });
    showMessage("#loanOperationsMessage", result.reference + " · " + result.status);
    await loadLoans();
  } catch (error) {
    showMessage("#loanOperationsMessage", error.message);
    button.disabled = false;
  }
});
$("#customerRequestForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  showMessage("#customerRequestMessage", "Submitting…");
  try {
    const result = await api("/api/requests", {
      method: "POST",
      body: JSON.stringify({
        type: $("#requestType").value,
        branchName: $("#requestBranch").value,
        note: $("#requestNote").value
      })
    });
    showMessage("#customerRequestMessage", "Request created: " + result.request.reference);
    event.target.reset();
    await loadRequests();
  } catch (error) {
    showMessage("#customerRequestMessage", error.message);
  }
});

$("#accountOpeningRows")?.addEventListener("click", async event => {
  const review = event.target.closest(".account-review"), decision = event.target.closest(".account-decision"), button = review || decision;
  if (!button) return;
  button.disabled = true;
  try {
    if (review) {
      await api("/api/account-opening/" + encodeURIComponent(button.dataset.id) + "/review", { method: "PATCH", body: JSON.stringify({ note: "Sample details reviewed by branch staff." }) });
      showMessage("#accountOpeningMessage", "Application reviewed and sent to Branch Manager.");
    } else {
      const result = await api("/api/account-opening/" + encodeURIComponent(button.dataset.id) + "/decision", { method: "PATCH", body: JSON.stringify({ decision: button.dataset.decision, note: "Demo application decision." }) });
      showMessage("#accountOpeningMessage", result.status === "approved" ? "Approved. Demo account " + result.accountNumber + " created." : "Application rejected.");
    }
    await loadAccountOpeningQueue();
  } catch (error) { showMessage("#accountOpeningMessage", error.message); button.disabled = false; }
});
$("#refreshAccountOpening")?.addEventListener("click", loadAccountOpeningQueue);

$("#requestRows")?.addEventListener("click", async event => {
  const button = event.target.closest(".request-update-btn");
  if (!button) return;
  const row = button.closest("tr");
  const status = row.querySelector(".request-status")?.value;
  button.disabled = true;
  try {
    await api("/api/requests/" + encodeURIComponent(button.dataset.id) + "/status", {
      method: "PATCH", body: JSON.stringify({ status })
    });
    showMessage("#requestsMessage", "Request status updated.");
    await loadRequests();
  } catch (error) {
    showMessage("#requestsMessage", error.message);
    button.disabled = false;
  }
});

$("#userRows")?.addEventListener("click", async event => {
  const button = event.target.closest(".user-status-btn");
  if (!button) return;
  const nextActive = button.dataset.active !== "true";
  button.disabled = true;
  try {
    await api("/api/portal/users/" + encodeURIComponent(button.dataset.id) + "/status", {
      method: "PATCH", body: JSON.stringify({ isActive: nextActive })
    });
    showMessage("#directoryMessage", "Account status updated.");
    await loadDirectory();
  } catch (error) {
    showMessage("#directoryMessage", error.message);
    button.disabled = false;
  }
});

$("#refreshUsers")?.addEventListener("click", loadDirectory);
$("#refreshRequests")?.addEventListener("click", loadRequests);
$("#logoutBtn")?.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } finally {
    location.href = "/";
  }
});

loadPortal();

