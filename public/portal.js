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
          password: $("#regPassword").value
        })
      });
      showMessage("#registerMessage", "Account created. You can now sign in.");
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
    if (role === "customer") $("#customerRequestCard").classList.remove("hidden");
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

(async function applyPublicSiteSettings() {
  if ($("#publicAnnouncement") || $("#homeHeroTitle") || $("#siteBrandName")) {
    try {
      const data = await api("/api/site-settings");
      const settings = data.settings || {};
      const textTargets = {
        publicAnnouncement: settings.announcement,
        homeHeroTitle: settings.heroTitle,
        homeHeroDescription: settings.heroDescription,
        siteBrandName: settings.siteName,
        siteTagline: settings.tagline,
        siteFooterNotice: settings.footerText,
        supportEmailLink: settings.supportEmail,
        supportPhoneText: settings.supportPhone
      };
      for (const [id, value] of Object.entries(textTargets)) {
        const element = $("#" + id);
        if (!element || !value) continue;
        if (id === "supportEmailLink") {
          element.textContent = value;
          element.href = "mailto:" + value;
        } else if (id === "supportPhoneText") {
          element.textContent = value;
        } else element.textContent = value;
      }
      if (settings.siteName) document.title = settings.siteName + " | Banking Experience Prototype";
    } catch (error) {
      // Static fallback content remains available if the database is temporarily unavailable.
    }
  }
})();
