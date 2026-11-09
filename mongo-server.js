require("dotenv").config();
const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const { randomUUID } = require("crypto");

const app = express();
const client = new MongoClient(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017", {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000
});
const dbName = process.env.MONGODB_DB || "pradhan_capitals";
const roles = ["customer", "branch", "staff", "manager", "cashier", "headquarters", "admin"];
const requestTypes = ["account_information", "loan_information", "deposit_information", "general_support"];
const requestStatuses = ["submitted", "in_review", "resolved", "closed"];
const defaultSiteSettings = {
  siteName: "Pradhan Capitals Bank",
  tagline: "Banking • Trust • Progress",
  announcement: "Demonstration platform only — no real banking services are offered.",
  heroTitle: "Move forward with a clearer view of your money.",
  heroDescription: "Explore everyday banking, borrowing and savings tools in one secure, easy-to-use digital experience.",
  supportEmail: "",
  supportPhone: "",
  footerText: "Demonstration interface only. Not a licensed bank; no real deposits, accounts, lending or payments."
};
let db;

if (process.env.NODE_ENV === "production" && (!process.env.MONGODB_URI || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error("Production requires MONGODB_URI and a SESSION_SECRET of at least 32 characters.");
}
const clientPromise = client.connect();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));
app.use("/api", (req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many authentication attempts. Try again in 15 minutes." } });

app.use(session({
  name: "pcb.sid",
  secret: process.env.SESSION_SECRET || "local-development-secret-change-before-deploy-0000",
  resave: false,
  saveUninitialized: false,
  rolling: true,
  store: MongoStore.create({ clientPromise, dbName, collectionName: "sessions", ttl: 900 }),
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 15 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const users = () => db.collection("users");
const logs = () => db.collection("audit_logs");
const requests = () => db.collection("demo_requests");
const siteSettings = () => db.collection("site_settings");
const bankAccounts = () => db.collection("bank_accounts");
const bankTransactions = () => db.collection("bank_transactions");
const cashOperations = () => db.collection("cash_operations");
const beneficiaries = () => db.collection("demo_beneficiaries");
const fixedDeposits = () => db.collection("demo_fixed_deposits");
const recurringDeposits = () => db.collection("demo_recurring_deposits");
const loanApplications = () => db.collection("demo_loan_applications");
const demoCards = () => db.collection("demo_cards");
const chequeBooks = () => db.collection("demo_cheque_books");
const accountOpeningApplications = () => db.collection("account_opening_applications");
const paise = value => Math.round(Number(value) * 100);
const inr = value => Number((Number(value || 0) / 100).toFixed(2));

function calculateDemoEmi(principalPaise, tenureMonths, annualRate = 12) {
  const monthlyRate = annualRate / 1200;
  const factor = Math.pow(1 + monthlyRate, tenureMonths);
  return Math.round(principalPaise * monthlyRate * factor / (factor - 1));
}
function addMonths(date, months) {
  const result = new Date(date);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

async function ensureDemoAccount(user) {
  let account = await bankAccounts().findOne({ userId: user.id });
  if (account) return account;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const accountNumber = "PCBD" + String(Date.now()).slice(-8) + String(Math.floor(1000 + Math.random() * 9000));
    try {
      await bankAccounts().insertOne({
        userId: user.id, accountNumber, accountType: "SAVINGS_DEMO",
        balancePaise: 2500000, // ₹25,000 demo opening balance
        currency: "INR", branchName: user.branchName || "Demo Digital Branch",
        ifscDemo: "PCBD0000001", status: "active", createdAt: new Date()
      });
      account = await bankAccounts().findOne({ userId: user.id });
      await audit(user, "DEMO_ACCOUNT_OPENED", "Demo savings account " + accountNumber);
      return account;
    } catch (error) {
      if (error.code !== 11000) throw error;
      account = await bankAccounts().findOne({ userId: user.id });
      if (account) return account;
    }
  }
  throw new Error("Could not allocate a demo account number.");
}
async function addLedgerPair({ from, to, amountPaise, actor, type, reference, note }) {
  const transferId = randomUUID();
  const debit = await bankTransactions().insertOne({
    transferId, accountId: from._id, userId: from.userId, direction: "debit",
    type, amountPaise, counterparty: to.accountNumber, reference, note,
    status: "completed", createdAt: new Date(), actorEmail: actor?.email || null
  });
  try {
    await bankTransactions().insertOne({
      transferId, accountId: to._id, userId: to.userId, direction: "credit",
      type, amountPaise, counterparty: from.accountNumber, reference, note,
      status: "completed", createdAt: new Date(), actorEmail: actor?.email || null
    });
  } catch (error) {
    await bankTransactions().deleteOne({ _id: debit.insertedId });
    throw error;
  }
  return transferId;
}

const emailOk = value => typeof value === "string" && value.length <= 160 && /^\S+@\S+\.\S+$/.test(value);
const signed = async (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: "Please sign in." });
  try {
    const active = await users().findOne(
      { _id: new ObjectId(req.session.user.id), isActive: true },
      { projection: { _id: 1 } }
    );
    if (!active) {
      return req.session.destroy(() => {
        res.clearCookie("pcb.sid");
        res.status(401).json({ error: "This account is inactive. Contact your administrator." });
      });
    }
    next();
  } catch (error) {
    res.status(503).json({ error: "Could not verify your account status." });
  }
};
const permit = (...allowed) => (req, res, next) => signed(req, res, () =>
  allowed.includes(req.session.user.role) ? next() : res.status(403).json({ error: "Not permitted." })
);
const permitCustomerAccount = (req, res, next) => signed(req, res, async () => {
  if (req.session.user.role !== "customer") return res.status(403).json({ error: "Not permitted." });
  try { const account = await bankAccounts().findOne({ userId: req.session.user.id }, { projection: { _id: 1 } });
    if (!account) return res.status(403).json({ error: "Your demo account is pending approval. Banking features unlock after Branch Manager or HQ approval." });
    next();
  } catch (error) { res.status(503).json({ error: "Could not verify demo account status." }); }
});
const publicUser = user => ({
  id: String(user._id),
  name: user.name,
  email: user.email,
  role: user.role,
  branchName: user.branchName || null,
  createdAt: user.createdAt
});
const cleanText = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
async function audit(actor, action, details) {
  await logs().insertOne({
    actorId: actor?.id || null,
    actorName: actor?.name || "System",
    action,
    details: String(details || "").slice(0, 500),
    createdAt: new Date()
  });
}
function saveSession(req, res, payload) {
  req.session.save(error => error
    ? res.status(500).json({ error: "Could not save your session. Please try again." })
    : res.json(payload));
}
async function bootstrapAccount(emailValue, passwordValue, role, name, branchName) {
  const email = emailValue?.trim().toLowerCase();
  if (!email && !passwordValue) return;
  if (!emailOk(email)) throw new Error("Bootstrap account email is invalid.");
  const existing = await users().findOne({ email });
  if (existing) {
    if (existing.role !== role) throw new Error("Bootstrap email is already assigned to a different role.");
    return;
  }
  if (typeof passwordValue !== "string" || passwordValue.length < 16) {
    throw new Error("A new bootstrap account requires a password of at least 16 characters.");
  }
  const result = await users().insertOne({
    name,
    email,
    passwordHash: await bcrypt.hash(passwordValue, 12),
    role,
    branchName,
    isActive: true,
    createdAt: new Date()
  });
  await audit({ id: String(result.insertedId), name: "System" }, "BOOTSTRAP_ACCOUNT", role + " account provisioned");
}
async function initialise() {
  await clientPromise;
  db = client.db(dbName);
  await Promise.all([
    users().createIndex({ email: 1 }, { unique: true }),
    users().createIndex({ role: 1, branchName: 1, isActive: 1 }),
    logs().createIndex({ createdAt: -1 }),
    logs().createIndex({ actorId: 1, createdAt: -1 }),
    requests().createIndex({ reference: 1 }, { unique: true }),
    requests().createIndex({ userId: 1, createdAt: -1 }),
    requests().createIndex({ branchName: 1, status: 1, createdAt: -1 }),
    siteSettings().createIndex({ key: 1 }, { unique: true }),
    bankAccounts().createIndex({ userId: 1 }, { unique: true }),
    bankAccounts().createIndex({ accountNumber: 1 }, { unique: true }),
    bankTransactions().createIndex({ accountId: 1, createdAt: -1 }),
    bankTransactions().createIndex({ transferId: 1 }),
    cashOperations().createIndex({ status: 1, branchName: 1, createdAt: -1 }),
    beneficiaries().createIndex({ userId: 1, accountNumber: 1 }, { unique: true }),
    fixedDeposits().createIndex({ userId: 1, status: 1, maturityAt: 1 }),
    recurringDeposits().createIndex({ userId: 1, status: 1, createdAt: -1 }),
    demoCards().createIndex({ userId: 1 }, { unique: true }),
    chequeBooks().createIndex({ userId: 1, createdAt: -1 }),
    chequeBooks().createIndex({ reference: 1 }, { unique: true }),
    loanApplications().createIndex({ userId: 1, createdAt: -1 }),
    loanApplications().createIndex({ status: 1, branchName: 1, createdAt: -1 }),
    accountOpeningApplications().createIndex({ reference: 1 }, { unique: true }),
    accountOpeningApplications().createIndex({ userId: 1, createdAt: -1 }),
    accountOpeningApplications().createIndex({ branchName: 1, status: 1, createdAt: -1 })

  ]);
  await bootstrapAccount(
    process.env.BOOTSTRAP_SITE_ADMIN_EMAIL,
    process.env.BOOTSTRAP_SITE_ADMIN_PASSWORD,
    "admin",
    "Website Administrator",
    "Website Administration"
  );
  await bootstrapAccount(
    process.env.BOOTSTRAP_ADMIN_EMAIL,
    process.env.BOOTSTRAP_ADMIN_PASSWORD,
    "headquarters",
    "Headquarters Administrator",
    "Head Office"
  );
  await siteSettings().updateOne(
    { key: "public" },
    { $setOnInsert: { key: "public", ...defaultSiteSettings, updatedAt: new Date() } },
    { upsert: true }
  );
}

app.get("/api/health", async (req, res) => {
  try {
    await db.command({ ping: 1 });
    res.json({ status: "ok", database: "connected", databaseType: "MongoDB", mode: "prototype" });
  } catch (error) {
    res.status(503).json({ status: "degraded", database: "unavailable", databaseType: "MongoDB" });
  }
});

app.get("/api/site-settings", async (req, res) => {
  try {
    const stored = await siteSettings().findOne({ key: "public" }, { projection: { _id: 0, key: 0, updatedBy: 0, updatedAt: 0 } });
    res.set("Cache-Control", "no-store").json({ settings: { ...defaultSiteSettings, ...(stored || {}) } });
  } catch (error) {
    res.status(503).json({ error: "Website settings are temporarily unavailable." });
  }
});

app.get("/api/admin/site-settings", permit("admin"), async (req, res) => {
  const stored = await siteSettings().findOne({ key: "public" }, { projection: { _id: 0, key: 0 } });
  res.json({ settings: { ...defaultSiteSettings, ...(stored || {}) } });
});

app.put("/api/admin/site-settings", permit("admin"), async (req, res) => {
  try {
    const input = req.body || {};
    const limits = { siteName: 80, tagline: 120, announcement: 240, heroTitle: 140, heroDescription: 400, supportEmail: 160, supportPhone: 30, footerText: 240 };
    const updates = {};
    for (const [field, max] of Object.entries(limits)) {
      if (input[field] !== undefined) {
        if (typeof input[field] !== "string" || input[field].trim().length > max) {
          return res.status(400).json({ error: "Invalid value for " + field + "." });
        }
        updates[field] = input[field].trim();
      }
    }
    if (updates.supportEmail && !emailOk(updates.supportEmail)) return res.status(400).json({ error: "Enter a valid support email." });
    if (updates.supportPhone && !/^[+0-9 ()-]{7,30}$/.test(updates.supportPhone)) return res.status(400).json({ error: "Enter a valid support phone number." });
    updates.updatedAt = new Date();
    updates.updatedBy = req.session.user.email;
    await siteSettings().updateOne({ key: "public" }, { $set: updates, $setOnInsert: { key: "public" } }, { upsert: true });
    await audit(req.session.user, "SITE_SETTINGS_UPDATED", "Public website content settings updated");
    const stored = await siteSettings().findOne({ key: "public" }, { projection: { _id: 0, key: 0 } });
    res.json({ ok: true, settings: { ...defaultSiteSettings, ...(stored || {}) } });
  } catch (error) {
    res.status(500).json({ error: "Could not save website settings." });
  }
});

app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80 ||
        !emailOk(normalizedEmail) || typeof password !== "string" || password.length < 10 || password.length > 128) {
      return res.status(400).json({ error: "Enter a valid name, email and password (10–128 characters)." });
    }
    const created = await users().insertOne({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash: await bcrypt.hash(password, 12),
      role: "customer", isActive: true, accountOpeningStatus: "pending", createdAt: new Date()
    });
    const branchName = cleanText(req.body?.branchName, 100) || "Demo Digital Branch";
    const reference = "OPEN-" + randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
    await accountOpeningApplications().insertOne({ reference, userId: String(created.insertedId), customerName: name.trim(), customerEmail: normalizedEmail, branchName, accountType: "SAVINGS_DEMO", status: "submitted", staffNote: "", decisionNote: "", createdAt: new Date(), updatedAt: new Date() });
    await audit({ id: String(created.insertedId), name: name.trim(), email: normalizedEmail }, "DEMO_ACCOUNT_APPLICATION_SUBMITTED", reference + " / " + branchName);
    res.status(201).json({ ok: true, message: "Registration complete. Your demo account application is awaiting branch review.", application: { reference, status: "submitted", branchName } });
  } catch (error) {
    res.status(error.code === 11000 ? 409 : 500).json({
      error: error.code === 11000 ? "Email already exists." : "Could not create account."
    });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const { role, email, password } = req.body || {};
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!roles.includes(role) || !emailOk(normalizedEmail) || typeof password !== "string" || password.length > 128) {
      return res.status(400).json({ error: "Invalid login details." });
    }
    const user = await users().findOne({ email: normalizedEmail, isActive: true });
    if (!user || user.role !== role || !await bcrypt.compare(password, user.passwordHash)) {
      await audit(null, "LOGIN_FAILED", "Failed " + role + " portal sign-in for " + normalizedEmail);
      return res.status(401).json({ error: "Email, password or selected portal is incorrect." });
    }
    req.session.regenerate(error => {
      if (error) return res.status(500).json({ error: "Could not start a secure session." });
      req.session.user = publicUser(user);
      audit(req.session.user, "LOGIN", role + " portal login")
        .then(() => saveSession(req, res, { ok: true, user: req.session.user }))
        .catch(() => res.status(500).json({ error: "Could not complete sign-in." }));
    });
  } catch (error) {
    res.status(500).json({ error: "Login service unavailable." });
  }
});

app.get("/api/auth/me", signed, (req, res) => res.json({ user: req.session.user }));
app.post("/api/auth/logout", signed, async (req, res) => {
  try {
    await audit(req.session.user, "LOGOUT", "Signed out");
    req.session.destroy(error => {
      res.clearCookie("pcb.sid", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
      if (error) return res.status(500).json({ error: "Could not end session." });
      res.json({ ok: true });
    });
  } catch (error) {
    res.status(500).json({ error: "Could not complete sign out." });
  }
});

app.get("/api/portal/summary", signed, async (req, res) => {
  try {
    const user = req.session.user;
    const role = user.role;
    const grouped = await users().aggregate([
      { $match: { isActive: true } },
      { $group: { _id: "$role", total: { $sum: 1 } } }
    ]).toArray();
    const counts = Object.fromEntries(grouped.map(item => [item._id, item.total]));
    let cards;
    if (role === "headquarters") {
      cards = [
        { label: "Customer demo accounts", value: counts.customer || 0 },
        { label: "Branches", value: counts.branch || 0 },
        { label: "Managers", value: counts.manager || 0 },
        { label: "Staff accounts", value: counts.staff || 0 },
        { label: "Cashier accounts", value: counts.cashier || 0 },
        { label: "Demo bank accounts", value: await bankAccounts().countDocuments({}) },
        { label: "Pending cash approvals", value: await cashOperations().countDocuments({ status: "pending" }) },
        { label: "Demo requests", value: await requests().countDocuments({}) }
      ];
    } else if (role === "admin") {
      cards = [
        { label: "Website role", value: "Administrator" },
        { label: "Public settings", value: "Editable" },
        { label: "Financial operations", value: "Demo ledger only" },
        { label: "Mode", value: "Prototype" }
      ];
    } else if (role === "customer") {
      const demoAccount = await bankAccounts().findOne({ userId: user.id });
      const application = await accountOpeningApplications().findOne({ userId: user.id }, { sort: { createdAt: -1 } });
      cards = demoAccount ? [
        { label: "Available demo balance", value: "₹" + inr(demoAccount.balancePaise).toLocaleString("en-IN") },
        { label: "Demo account", value: demoAccount.accountNumber },
        { label: "My demo requests", value: await requests().countDocuments({ userId: user.id }) },
        { label: "Account status", value: "Active • Demo" }
      ] : [
        { label: "Account application", value: application?.reference || "Not submitted" },
        { label: "Application status", value: application?.status || "Pending" },
        { label: "Assigned branch", value: application?.branchName || "To be assigned" },
        { label: "Banking access", value: "Locked until approval" }
      ];
    } else {
      const branchFilter = { branchName: user.branchName || "" };
      cards = [
        { label: "Branch", value: user.branchName || "Unassigned" },
        { label: "Branch team", value: await users().countDocuments({ ...branchFilter, role: { $in: ["branch", "manager", "staff", "cashier"] }, isActive: true }) },
        { label: "Open demo requests", value: await requests().countDocuments({ ...branchFilter, status: { $in: ["submitted", "in_review"] } }) },
        { label: "Workspace", value: "Active" }
      ];
    }
    const titles = {
      admin: "Website administration dashboard",
      headquarters: "Headquarters control centre",
      branch: "Branch operations dashboard",
      staff: "Branch staff dashboard",
      manager: "Branch manager dashboard",
      cashier: "Cashier dashboard",
      customer: "Customer dashboard"
    };
    const actionSets = {
      admin: [
        { title: "Website content", description: "Edit homepage headline, announcement, public contact details and footer text." },
        { title: "Site configuration", description: "Changes are stored in MongoDB and served to the public website." },
        { title: "Access boundary", description: "Website Admin cannot provision HQ, branch, manager, staff or cashier accounts." }
      ],
      headquarters: [
        { title: "Organisation directory", description: "Review customer and employee demo accounts." },
        { title: "Access governance", description: "Provision branch, manager, staff and cashier demo logins." },
        { title: "Demo request desk", description: "Review and update requests routed to branches." },
        { title: "Audit trail", description: "Review recent administrative activity." }
      ],
      branch: [{ title: "Branch operations", description: "Review your branch team and assigned demo requests." }],
      staff: [{ title: "Staff workspace", description: "Review and update demo service requests assigned to your branch." }],
      manager: [{ title: "Team oversight", description: "Create staff accounts and manage branch demo requests." }],
      cashier: [{ title: "Branch cash desk", description: "Submit simulated deposit/withdrawal entries; manager, branch or HQ approval is required." }],
      customer: [{ title: "Customer banking", description: "View your demo account, transfer simulated funds internally and download your passbook statement." }]
    };
    res.json({
      title: titles[role],
      description: "Role-based demonstration workspace. All financial activity is simulated.",
      cards,
      actions: actionSets[role] || []
    });
  } catch (error) {
    res.status(500).json({ error: "Could not load portal summary." });
  }
});

app.get("/api/portal/users", permit("headquarters", "manager", "branch"), async (req, res) => {
  try {
    const user = req.session.user;
    const filter = user.role === "headquarters" ? {} : { branchName: user.branchName || "" };
    const list = await users().find(filter, { projection: { passwordHash: 0 } }).sort({ createdAt: -1 }).limit(200).toArray();
    const actorIds = user.role === "headquarters"
      ? null
      : list.map(item => String(item._id));
    const activity = await logs().find(actorIds ? { actorId: { $in: actorIds } } : {})
      .sort({ createdAt: -1 }).limit(50).toArray();
    res.json({
      users: list.map(item => ({
        id: String(item._id), name: item.name, email: item.email, role: item.role,
        branch_name: item.branchName || null, is_active: item.isActive !== false, created_at: item.createdAt
      })),
      audit: activity.map(item => ({
        actor_name: item.actorName, action: item.action, details: item.details, created_at: item.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: "Could not load the organisation directory." });
  }
});

app.post("/api/portal/users", permit("headquarters", "manager"), async (req, res) => {
  try {
    const { name, email, password, role, branchName } = req.body || {};
    const actor = req.session.user;
    const allowed = actor.role === "headquarters"
      ? ["branch", "manager", "staff", "cashier"].includes(role)
      : role === "staff";
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!allowed) return res.status(403).json({ error: "You cannot create this role." });
    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80 ||
        !emailOk(normalizedEmail) || typeof password !== "string" || password.length < 10 || password.length > 128) {
      return res.status(400).json({ error: "Enter valid account details." });
    }
    const branch = actor.role === "manager" ? actor.branchName : cleanText(branchName, 100);
    if (!branch) return res.status(400).json({ error: "Branch name is required." });
    const document = {
      name: name.trim(), email: normalizedEmail,
      passwordHash: await bcrypt.hash(password, 12),
      role, branchName: branch, isActive: true, createdAt: new Date()
    };
    const result = await users().insertOne(document);
    await audit(actor, "USER_CREATED", role + " demo login created for " + branch);
    res.status(201).json({
      ok: true,
      user: { id: String(result.insertedId), name: document.name, email: document.email, role, branch_name: branch, is_active: true }
    });
  } catch (error) {
    res.status(error.code === 11000 ? 409 : 500).json({
      error: error.code === 11000 ? "Email already exists." : "Could not create login."
    });
  }
});

app.patch("/api/portal/users/:id/status", permit("headquarters"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid user id." });
    const isActive = req.body?.isActive;
    if (typeof isActive !== "boolean") return res.status(400).json({ error: "isActive must be true or false." });
    const target = await users().findOne({ _id: new ObjectId(req.params.id) });
    if (!target) return res.status(404).json({ error: "User not found." });
    if (target.role === "admin") return res.status(403).json({ error: "Website Admin accounts are managed separately." });
    if (target.role === "headquarters" && target.email === req.session.user.email) {
      return res.status(400).json({ error: "You cannot deactivate your own HQ account." });
    }
    await users().updateOne({ _id: target._id }, { $set: { isActive, updatedAt: new Date() } });
    await audit(req.session.user, isActive ? "USER_ACTIVATED" : "USER_DEACTIVATED", target.email);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Could not update account status." });
  }
});

// DEMO ACCOUNT OPENING — staff review followed by manager/HQ decision.
app.get("/api/account-opening/my", permit("customer"), async (req, res) => {
  const application = await accountOpeningApplications().findOne({ userId: req.session.user.id }, { sort: { createdAt: -1 } });
  const account = await bankAccounts().findOne({ userId: req.session.user.id }, { projection: { accountNumber: 1, accountType: 1, status: 1 } });
  res.json({ application: application ? { reference: application.reference, branchName: application.branchName, status: application.status, staffNote: application.staffNote || "", decisionNote: application.decisionNote || "", createdAt: application.createdAt } : null, account: account ? { accountNumber: account.accountNumber, accountType: account.accountType, status: account.status } : null });
});
app.get("/api/account-opening/queue", permit("headquarters", "manager", "branch", "staff"), async (req, res) => {
  const user = req.session.user;
  const filter = user.role === "headquarters" ? {} : { branchName: user.branchName || "" };
  const items = await accountOpeningApplications().find(filter).sort({ createdAt: -1 }).limit(200).toArray();
  res.json({ applications: items.map(item => ({ id: String(item._id), reference: item.reference, customerName: item.customerName, customerEmail: item.customerEmail, branchName: item.branchName, status: item.status, createdAt: item.createdAt })) });
});
app.patch("/api/account-opening/:id/review", permit("staff"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid application id." });
    const filter = { _id: new ObjectId(req.params.id), branchName: req.session.user.branchName || "", status: "submitted" };
    const item = await accountOpeningApplications().findOneAndUpdate(filter, { $set: { status: "under_review", staffNote: cleanText(req.body?.note, 300), reviewedBy: req.session.user.email, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!item) return res.status(404).json({ error: "Submitted application not found in your branch." });
    await audit(req.session.user, "DEMO_ACCOUNT_APPLICATION_REVIEWED", item.reference);
    res.json({ ok: true, status: item.status });
  } catch (error) { res.status(500).json({ error: "Could not review account application." }); }
});
app.patch("/api/account-opening/:id/decision", permit("headquarters", "manager"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid application id." });
    const decision = req.body?.decision, note = cleanText(req.body?.note, 300);
    if (!["approve", "reject"].includes(decision)) return res.status(400).json({ error: "Choose approve or reject." });
    const filter = { _id: new ObjectId(req.params.id), status: "under_review" };
    if (req.session.user.role === "manager") filter.branchName = req.session.user.branchName || "";
    const application = await accountOpeningApplications().findOne(filter);
    if (!application) return res.status(404).json({ error: "Reviewed application not found in your permitted branch." });
    const changed = await accountOpeningApplications().updateOne(filter, { $set: { status: decision === "approve" ? "approving" : "rejected", decisionNote: note, decidedBy: req.session.user.email, updatedAt: new Date() } });
    if (!changed.modifiedCount) return res.status(409).json({ error: "Application was already processed." });
    if (decision === "reject") {
      await users().updateOne({ _id: new ObjectId(application.userId) }, { $set: { accountOpeningStatus: "rejected" } });
      await audit(req.session.user, "DEMO_ACCOUNT_APPLICATION_REJECTED", application.reference);
      return res.json({ ok: true, status: "rejected" });
    }
    try {
      await users().updateOne({ _id: new ObjectId(application.userId) }, { $set: { accountOpeningStatus: "approved", branchName: application.branchName } });
      const customer = await users().findOne({ _id: new ObjectId(application.userId), role: "customer" });
      if (!customer) throw new Error("Customer profile not found.");
      const account = await ensureDemoAccount({ id: application.userId, name: customer.name, email: customer.email, role: "customer", branchName: application.branchName });
      await accountOpeningApplications().updateOne({ _id: application._id, status: "approving" }, { $set: { status: "approved", accountNumber: account.accountNumber, updatedAt: new Date() } });
      await audit(req.session.user, "DEMO_ACCOUNT_APPLICATION_APPROVED", application.reference + " / " + account.accountNumber);
      return res.json({ ok: true, status: "approved", accountNumber: account.accountNumber });
    } catch (error) {
      await accountOpeningApplications().updateOne({ _id: application._id, status: "approving" }, { $set: { status: "under_review", updatedAt: new Date() } });
      throw error;
    }
  } catch (error) { res.status(500).json({ error: "Could not process account-opening decision." }); }
});

app.post("/api/requests", permit("customer"), async (req, res) => {
  try {
    const { type, branchName, note } = req.body || {};
    if (!requestTypes.includes(type)) return res.status(400).json({ error: "Choose a valid demo request type." });
    const branch = cleanText(branchName, 100);
    if (typeof note !== "string" || note.trim().length > 300) return res.status(400).json({ error: "Request note must be 300 characters or fewer." });
    const reference = "PCB-" + randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
    const document = {
      reference, userId: req.session.user.id, customerName: req.session.user.name,
      type, branchName: branch || null, note: note.trim(),
      status: "submitted", createdAt: new Date(), updatedAt: new Date()
    };
    await requests().insertOne(document);
    if (branch) await bankAccounts().updateOne({ userId: req.session.user.id, branchName: "Demo Digital Branch" }, { $set: { branchName: branch } });
    await audit(req.session.user, "DEMO_REQUEST_CREATED", reference + " / " + type);
    res.status(201).json({ ok: true, request: { reference, type, status: document.status, createdAt: document.createdAt } });
  } catch (error) {
    res.status(500).json({ error: "Could not submit demo request." });
  }
});

app.get("/api/requests", signed, async (req, res) => {
  try {
    const user = req.session.user;
    let filter;
    if (user.role === "customer") filter = { userId: user.id };
    else if (user.role === "headquarters") filter = {};
    else if (["branch", "manager", "staff"].includes(user.role)) filter = { branchName: user.branchName || "" };
    else return res.status(403).json({ error: "Not permitted." });
    const items = await requests().find(filter).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ requests: items.map(item => ({
      id: String(item._id), reference: item.reference, customerName: item.customerName,
      type: item.type, branchName: item.branchName, note: item.note,
      status: item.status, createdAt: item.createdAt
    })) });
  } catch (error) {
    res.status(500).json({ error: "Could not load demo requests." });
  }
});

app.patch("/api/requests/:id/status", permit("headquarters", "branch", "manager", "staff"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid request id." });
    const status = req.body?.status;
    if (!requestStatuses.includes(status)) return res.status(400).json({ error: "Invalid request status." });
    const filter = { _id: new ObjectId(req.params.id) };
    if (req.session.user.role !== "headquarters") filter.branchName = req.session.user.branchName || "";
    const item = await requests().findOne(filter);
    if (!item) return res.status(404).json({ error: "Request not found in your permitted scope." });
    await requests().updateOne(filter, { $set: { status, updatedAt: new Date(), updatedBy: req.session.user.email } });
    await audit(req.session.user, "DEMO_REQUEST_STATUS_CHANGED", item.reference + " → " + status);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Could not update request status." });
  }
});



// DEMO BANKING ENGINE — internal MongoDB simulation only; no external payment/bank APIs.
app.get("/api/banking/account", permitCustomerAccount, async (req, res) => {
  try {
    const account = await ensureDemoAccount(req.session.user);
    res.json({ account: {
      accountNumber: account.accountNumber, accountType: account.accountType,
      balance: inr(account.balancePaise), currency: "INR", ifscDemo: account.ifscDemo,
      branchName: account.branchName, status: account.status, mode: "DEMO"
    } });
  } catch (error) { res.status(500).json({ error: "Could not load demo account." }); }
});

app.get("/api/banking/transactions", permitCustomerAccount, async (req, res) => {
  try {
    const account = await ensureDemoAccount(req.session.user);
    const items = await bankTransactions().find({ accountId: account._id }).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ transactions: items.map(item => ({
      id: String(item._id), reference: item.reference, direction: item.direction,
      type: item.type, amount: inr(item.amountPaise), counterparty: item.counterparty,
      note: item.note, status: item.status, createdAt: item.createdAt
    })) });
  } catch (error) { res.status(500).json({ error: "Could not load demo statement." }); }
});

app.post("/api/banking/transfer", permitCustomerAccount, async (req, res) => {
  try {
    const accountNumber = cleanText(req.body?.accountNumber, 30).toUpperCase();
    const amountPaise = paise(req.body?.amount);
    const note = cleanText(req.body?.note, 100);
    if (!/^PCBD\d{12}$/.test(accountNumber) || !Number.isSafeInteger(amountPaise) || amountPaise < 100 || amountPaise > 5000000) {
      return res.status(400).json({ error: "Enter a valid demo account number and amount between ₹1 and ₹50,000." });
    }
    const sender = await ensureDemoAccount(req.session.user);
    if (sender.accountNumber === accountNumber) return res.status(400).json({ error: "You cannot transfer to your own account." });
    const receiver = await bankAccounts().findOne({ accountNumber, status: "active" });
    if (!receiver) return res.status(404).json({ error: "Demo beneficiary account not found." });
    const debit = await bankAccounts().updateOne(
      { _id: sender._id, status: "active", balancePaise: { $gte: amountPaise } },
      { $inc: { balancePaise: -amountPaise }, $set: { updatedAt: new Date() } }
    );
    if (!debit.modifiedCount) return res.status(400).json({ error: "Insufficient demo balance or account unavailable." });
    const credit = await bankAccounts().updateOne(
      { _id: receiver._id, status: "active" },
      { $inc: { balancePaise: amountPaise }, $set: { updatedAt: new Date() } }
    );
    if (!credit.modifiedCount) {
      await bankAccounts().updateOne({ _id: sender._id }, { $inc: { balancePaise: amountPaise } });
      return res.status(409).json({ error: "Beneficiary account changed. Demo transfer reversed." });
    }
    const reference = "PCBT" + randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
    try {
      await addLedgerPair({ from: sender, to: receiver, amountPaise, actor: req.session.user, type: "internal_transfer", reference, note });
    } catch (error) {
      await bankAccounts().updateOne({ _id: receiver._id }, { $inc: { balancePaise: -amountPaise } });
      await bankAccounts().updateOne({ _id: sender._id }, { $inc: { balancePaise: amountPaise } });
      throw error;
    }
    await audit(req.session.user, "DEMO_TRANSFER_COMPLETED", reference + " / ₹" + inr(amountPaise));
    const updated = await bankAccounts().findOne({ _id: sender._id });
    res.status(201).json({ ok: true, reference, amount: inr(amountPaise), balance: inr(updated.balancePaise), mode: "DEMO" });
  } catch (error) { res.status(500).json({ error: "Could not complete demo transfer." }); }
});

app.post("/api/banking/cash-operations", permit("cashier", "branch", "manager", "headquarters"), async (req, res) => {
  try {
    const accountNumber = cleanText(req.body?.accountNumber, 30).toUpperCase();
    const type = req.body?.type;
    const amountPaise = paise(req.body?.amount);
    const note = cleanText(req.body?.note, 120);
    if (!/^PCBD\d{12}$/.test(accountNumber) || !["cash_deposit", "cash_withdrawal"].includes(type) ||
        !Number.isSafeInteger(amountPaise) || amountPaise < 100 || amountPaise > 10000000) {
      return res.status(400).json({ error: "Invalid demo cash operation. Amount limit is ₹1–₹1,00,000." });
    }
    const account = await bankAccounts().findOne({ accountNumber, status: "active" });
    if (!account) return res.status(404).json({ error: "Demo account not found." });
    const actor = req.session.user;
    if (actor.role !== "headquarters" && actor.branchName && actor.branchName !== account.branchName) {
      return res.status(403).json({ error: "Account belongs to another branch." });
    }
    const operation = {
      reference: "PCBC" + randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase(),
      accountId: account._id, accountNumber, userId: account.userId, type, amountPaise,
      note, branchName: account.branchName, status: "pending",
      createdBy: actor.email, createdAt: new Date()
    };
    await cashOperations().insertOne(operation);
    await audit(actor, "DEMO_CASH_OPERATION_REQUESTED", operation.reference + " / " + type);
    res.status(201).json({ ok: true, reference: operation.reference, status: operation.status, message: "Demo cash entry submitted for approval." });
  } catch (error) { res.status(500).json({ error: "Could not create demo cash entry." }); }
});

app.get("/api/banking/cash-operations", permit("cashier", "branch", "manager", "headquarters"), async (req, res) => {
  try {
    const actor = req.session.user;
    const filter = actor.role === "headquarters" ? {} : { branchName: actor.branchName || "" };
    const items = await cashOperations().find(filter).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ operations: items.map(item => ({
      id: String(item._id), reference: item.reference, accountNumber: item.accountNumber,
      type: item.type, amount: inr(item.amountPaise), status: item.status,
      branchName: item.branchName, createdAt: item.createdAt
    })) });
  } catch (error) { res.status(500).json({ error: "Could not load cash operations." }); }
});

app.patch("/api/banking/cash-operations/:id/approve", permit("headquarters", "branch", "manager"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid operation id." });
    const actor = req.session.user;
    const filter = { _id: new ObjectId(req.params.id), status: "pending" };
    if (actor.role !== "headquarters") filter.branchName = actor.branchName || "";
    const operation = await cashOperations().findOne(filter);
    if (!operation) return res.status(404).json({ error: "Pending operation not found in your branch." });
    const delta = operation.type === "cash_deposit" ? operation.amountPaise : -operation.amountPaise;
    const balanceFilter = { _id: operation.accountId, status: "active" };
    if (delta < 0) balanceFilter.balancePaise = { $gte: operation.amountPaise };
    const changed = await bankAccounts().updateOne(balanceFilter, { $inc: { balancePaise: delta }, $set: { updatedAt: new Date() } });
    if (!changed.modifiedCount) return res.status(400).json({ error: "Insufficient demo balance or account unavailable." });
    const reference = operation.reference;
    try {
      await bankTransactions().insertOne({
        transferId: reference, accountId: operation.accountId, userId: operation.userId,
        direction: delta > 0 ? "credit" : "debit", type: operation.type,
        amountPaise: operation.amountPaise, counterparty: "BRANCH CASH DESK",
        reference, note: operation.note, status: "completed", createdAt: new Date(), actorEmail: actor.email
      });
      const approved = await cashOperations().updateOne(filter, { $set: { status: "approved", approvedBy: actor.email, approvedAt: new Date() } });
      if (!approved.modifiedCount) throw new Error("Operation was already processed.");
    } catch (error) {
      await bankTransactions().deleteOne({ transferId: reference });
      await bankAccounts().updateOne({ _id: operation.accountId }, { $inc: { balancePaise: -delta } });
      throw error;
    }
    await audit(actor, "DEMO_CASH_OPERATION_APPROVED", reference);
    res.json({ ok: true, reference, status: "approved", mode: "DEMO" });
  } catch (error) { res.status(500).json({ error: "Could not approve demo cash operation." }); }
});



// Customer conveniences: saved beneficiaries, fixed deposits and demo loan workflow.
app.get("/api/banking/beneficiaries", permitCustomerAccount, async (req, res) => {
  try {
    const items = await beneficiaries().find({ userId: req.session.user.id }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json({ beneficiaries: items.map(item => ({ id: String(item._id), name: item.name, accountNumber: item.accountNumber, createdAt: item.createdAt })) });
  } catch (error) { res.status(500).json({ error: "Could not load saved beneficiaries." }); }
});

app.post("/api/banking/beneficiaries", permitCustomerAccount, async (req, res) => {
  try {
    const name = cleanText(req.body?.name, 60);
    const accountNumber = cleanText(req.body?.accountNumber, 30).toUpperCase();
    const own = await ensureDemoAccount(req.session.user);
    if (name.length < 2 || !/^PCBD\d{12}$/.test(accountNumber) || accountNumber === own.accountNumber) {
      return res.status(400).json({ error: "Enter a beneficiary name and a different valid demo account number." });
    }
    const target = await bankAccounts().findOne({ accountNumber, status: "active" }, { projection: { _id: 1 } });
    if (!target) return res.status(404).json({ error: "Demo beneficiary account not found." });
    const result = await beneficiaries().insertOne({ userId: req.session.user.id, name, accountNumber, createdAt: new Date() });
    await audit(req.session.user, "DEMO_BENEFICIARY_ADDED", accountNumber);
    res.status(201).json({ ok: true, beneficiary: { id: String(result.insertedId), name, accountNumber } });
  } catch (error) {
    res.status(error.code === 11000 ? 409 : 500).json({ error: error.code === 11000 ? "This beneficiary is already saved." : "Could not save beneficiary." });
  }
});

app.delete("/api/banking/beneficiaries/:id", permitCustomerAccount, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid beneficiary id." });
    const result = await beneficiaries().deleteOne({ _id: new ObjectId(req.params.id), userId: req.session.user.id });
    if (!result.deletedCount) return res.status(404).json({ error: "Beneficiary not found." });
    await audit(req.session.user, "DEMO_BENEFICIARY_REMOVED", req.params.id);
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: "Could not remove beneficiary." }); }
});

async function matureDueFixedDeposits(userId) {
  const due = await fixedDeposits().find({ userId, status: "active", maturityAt: { $lte: new Date() } }).limit(50).toArray();
  for (const fd of due) {
    const claim = await fixedDeposits().updateOne({ _id: fd._id, status: "active" }, { $set: { status: "matured", maturedAt: new Date() } });
    if (!claim.modifiedCount) continue;
    const account = await bankAccounts().findOne({ userId, status: "active" });
    if (!account) {
      await fixedDeposits().updateOne({ _id: fd._id, status: "matured" }, { $set: { status: "maturity_pending" } });
      continue;
    }
    await bankAccounts().updateOne({ _id: account._id }, { $inc: { balancePaise: fd.maturityAmountPaise }, $set: { updatedAt: new Date() } });
    await bankTransactions().insertOne({
      transferId: fd.reference, accountId: account._id, userId,
      direction: "credit", type: "fd_maturity", amountPaise: fd.maturityAmountPaise,
      counterparty: "DEMO FIXED DEPOSIT", reference: fd.reference,
      note: "Principal and simulated interest credited at maturity",
      status: "completed", createdAt: new Date()
    });
  }
}

app.get("/api/banking/fixed-deposits", permitCustomerAccount, async (req, res) => {
  try {
    await matureDueFixedDeposits(req.session.user.id);
    const items = await fixedDeposits().find({ userId: req.session.user.id }).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ fixedDeposits: items.map(item => ({
      id: String(item._id), reference: item.reference, principal: inr(item.principalPaise),
      rate: item.rate, tenureMonths: item.tenureMonths, maturityAmount: inr(item.maturityAmountPaise),
      maturityAt: item.maturityAt, status: item.status, createdAt: item.createdAt
    })) });
  } catch (error) { res.status(500).json({ error: "Could not load demo fixed deposits." }); }
});

app.post("/api/banking/fixed-deposits", permitCustomerAccount, async (req, res) => {
  try {
    const principalPaise = paise(req.body?.amount);
    const tenureMonths = Number(req.body?.tenureMonths);
    if (!Number.isSafeInteger(principalPaise) || principalPaise < 10000 || principalPaise > 100000000 ||
        !Number.isInteger(tenureMonths) || tenureMonths < 3 || tenureMonths > 36 || tenureMonths % 3 !== 0) {
      return res.status(400).json({ error: "Demo FD amount must be ₹100–₹10,00,000 and tenure 3–36 months." });
    }
    const account = await ensureDemoAccount(req.session.user);
    const rate = 6.5;
    const maturityAmountPaise = Math.round(principalPaise * Math.pow(1 + rate / 400, tenureMonths / 3));
    const debit = await bankAccounts().updateOne(
      { _id: account._id, status: "active", balancePaise: { $gte: principalPaise } },
      { $inc: { balancePaise: -principalPaise }, $set: { updatedAt: new Date() } }
    );
    if (!debit.modifiedCount) return res.status(400).json({ error: "Insufficient demo balance." });
    const now = new Date();
    const maturityAt = new Date(now);
    maturityAt.setMonth(maturityAt.getMonth() + tenureMonths);
    const reference = "PCFD" + randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
    try {
      await fixedDeposits().insertOne({
        userId: req.session.user.id, accountId: account._id, reference,
        principalPaise, rate, tenureMonths, maturityAmountPaise, maturityAt,
        status: "active", createdAt: now
      });
      await bankTransactions().insertOne({
        transferId: reference, accountId: account._id, userId: req.session.user.id,
        direction: "debit", type: "fixed_deposit_opened", amountPaise: principalPaise,
        counterparty: "DEMO FIXED DEPOSIT", reference, note: "Principal placed in simulated fixed deposit",
        status: "completed", createdAt: now
      });
    } catch (error) {
      await fixedDeposits().deleteOne({ reference });
      await bankTransactions().deleteOne({ transferId: reference });
      await bankAccounts().updateOne({ _id: account._id }, { $inc: { balancePaise: principalPaise } });
      throw error;
    }
    await audit(req.session.user, "DEMO_FD_OPENED", reference + " / ₹" + inr(principalPaise));
    res.status(201).json({ ok: true, reference, principal: inr(principalPaise), rate, maturityAmount: inr(maturityAmountPaise), maturityAt, mode: "DEMO" });
  } catch (error) { res.status(500).json({ error: "Could not open demo fixed deposit." }); }
});


app.get("/api/banking/recurring-deposits", permitCustomerAccount, async (req, res) => {
  try {
    const items = await recurringDeposits().find({ userId: req.session.user.id }).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ recurringDeposits: items.map(item => ({
      id: String(item._id), reference: item.reference, monthlyAmount: inr(item.monthlyAmountPaise),
      rate: item.rate, tenureMonths: item.tenureMonths, paidInstallments: item.paidInstallments,
      totalInstallments: item.tenureMonths, maturityAmount: inr(item.maturityAmountPaise),
      nextDueAt: item.nextDueAt, status: item.status, createdAt: item.createdAt
    })) });
  } catch (error) { res.status(500).json({ error: "Could not load demo recurring deposits." }); }
});

app.post("/api/banking/recurring-deposits", permitCustomerAccount, async (req, res) => {
  try {
    const monthlyAmountPaise = paise(req.body?.monthlyAmount);
    const tenureMonths = Number(req.body?.tenureMonths);
    if (!Number.isSafeInteger(monthlyAmountPaise) || monthlyAmountPaise < 10000 || monthlyAmountPaise > 5000000 ||
        !Number.isInteger(tenureMonths) || tenureMonths < 6 || tenureMonths > 36 || tenureMonths % 6 !== 0) {
      return res.status(400).json({ error: "Demo RD monthly amount must be ₹100–₹50,000 and tenure 6–36 months in 6-month steps." });
    }
    const rate = 6.5;
    const monthlyRate = rate / 1200;
    const maturityAmountPaise = Math.round(monthlyAmountPaise * ((Math.pow(1 + monthlyRate, tenureMonths) - 1) / monthlyRate));
    const now = new Date();
    const reference = "PCRD" + randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
    const result = await recurringDeposits().insertOne({
      userId: req.session.user.id, accountId: (await ensureDemoAccount(req.session.user))._id,
      reference, monthlyAmountPaise, rate, tenureMonths, maturityAmountPaise,
      paidInstallments: 0, nextDueAt: addMonths(now, 1), status: "active", createdAt: now, updatedAt: now
    });
    await audit(req.session.user, "DEMO_RD_OPENED", reference + " / monthly ₹" + inr(monthlyAmountPaise));
    res.status(201).json({ ok: true, id: String(result.insertedId), reference, monthlyAmount: inr(monthlyAmountPaise), rate, tenureMonths, maturityAmount: inr(maturityAmountPaise), nextDueAt: addMonths(now, 1), mode: "DEMO" });
  } catch (error) { res.status(500).json({ error: "Could not open demo recurring deposit." }); }
});

app.post("/api/banking/recurring-deposits/:id/pay", permitCustomerAccount, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid recurring deposit id." });
  const userId = req.session.user.id;
  const rd = await recurringDeposits().findOne({ _id: new ObjectId(req.params.id), userId, status: "active" });
  if (!rd) return res.status(404).json({ error: "Active demo recurring deposit not found." });
  const installmentNumber = rd.paidInstallments + 1;
  if (installmentNumber > rd.tenureMonths) return res.status(409).json({ error: "All installments are already paid." });
  const finalInstallment = installmentNumber === rd.tenureMonths;
  const reference = rd.reference + "-I" + String(installmentNumber).padStart(2, "0");
  const claim = await recurringDeposits().updateOne(
    { _id: rd._id, userId, status: "active", paidInstallments: rd.paidInstallments },
    { $set: { status: finalInstallment ? "maturing" : "active", lastPaymentReference: reference, updatedAt: new Date() },
      $inc: { paidInstallments: 1 }
    }
  );
  if (!claim.modifiedCount) return res.status(409).json({ error: "This installment was already processed. Refresh the RD list." });
  let debited = false;
  let installmentLedger = false;
  let maturityCredited = false;
  let maturityLedger = false;
  try {
    const account = await bankAccounts().updateOne(
      { _id: rd.accountId, userId, status: "active", balancePaise: { $gte: rd.monthlyAmountPaise } },
      { $inc: { balancePaise: -rd.monthlyAmountPaise }, $set: { updatedAt: new Date() } }
    );
    if (!account.modifiedCount) throw new Error("Insufficient demo balance or account unavailable.");
    debited = true;
    await bankTransactions().insertOne({
      transferId: reference, accountId: rd.accountId, userId, direction: "debit",
      type: "demo_rd_installment", amountPaise: rd.monthlyAmountPaise,
      counterparty: "DEMO RECURRING DEPOSIT", reference,
      note: "Manually paid simulated recurring deposit installment " + installmentNumber,
      status: "completed", createdAt: new Date()
    });
    installmentLedger = true;
    if (finalInstallment) {
      const credited = await bankAccounts().updateOne({ _id: rd.accountId, userId, status: "active" },
        { $inc: { balancePaise: rd.maturityAmountPaise }, $set: { updatedAt: new Date() } });
      if (!credited.modifiedCount) throw new Error("Could not credit demo RD maturity.");
      maturityCredited = true;
      await bankTransactions().insertOne({
        transferId: rd.reference + "-MATURITY", accountId: rd.accountId, userId, direction: "credit",
        type: "demo_rd_maturity", amountPaise: rd.maturityAmountPaise,
        counterparty: "DEMO RECURRING DEPOSIT", reference: rd.reference,
        note: "Simulated recurring deposit maturity including illustrative interest",
        status: "completed", createdAt: new Date()
      });
      maturityLedger = true;
      await recurringDeposits().updateOne({ _id: rd._id, status: "maturing" }, { $set: { status: "matured", maturedAt: new Date(), nextDueAt: null } });
    } else {
      await recurringDeposits().updateOne({ _id: rd._id, status: "active" }, { $set: { nextDueAt: addMonths(rd.nextDueAt || new Date(), 1) } });
    }
    await audit(req.session.user, "DEMO_RD_INSTALLMENT_PAID", reference);
    res.json({ ok: true, reference, installmentNumber, paidAmount: inr(rd.monthlyAmountPaise),
      paidInstallments: installmentNumber, maturityAmount: finalInstallment ? inr(rd.maturityAmountPaise) : null,
      status: finalInstallment ? "matured" : "active", mode: "DEMO" });
  } catch (error) {
    if (maturityLedger) await bankTransactions().deleteOne({ transferId: rd.reference + "-MATURITY" });
    if (maturityCredited) await bankAccounts().updateOne({ _id: rd.accountId }, { $inc: { balancePaise: -rd.maturityAmountPaise } });
    if (installmentLedger) await bankTransactions().deleteOne({ transferId: reference });
    if (debited) await bankAccounts().updateOne({ _id: rd.accountId }, { $inc: { balancePaise: rd.monthlyAmountPaise } });
    await recurringDeposits().updateOne({ _id: rd._id }, { $set: { status: "active", paidInstallments: rd.paidInstallments, nextDueAt: rd.nextDueAt, lastPaymentReference: null }, $unset: { maturedAt: "" } });
    return res.status(400).json({ error: error.message || "Could not process demo RD installment." });
  }
});

app.post("/api/banking/loans", permitCustomerAccount, async (req, res) => {
  try {
    const amountPaise = paise(req.body?.amount);
    const tenureMonths = Number(req.body?.tenureMonths);
    const purpose = cleanText(req.body?.purpose, 120);
    if (!Number.isSafeInteger(amountPaise) || amountPaise < 100000 || amountPaise > 50000000 ||
        !Number.isInteger(tenureMonths) || tenureMonths < 3 || tenureMonths > 60 || purpose.length < 3) {
      return res.status(400).json({ error: "Demo loan must be ₹1,000–₹5,00,000, tenure 3–60 months and purpose at least 3 characters." });
    }
    const account = await ensureDemoAccount(req.session.user);
    const existing = await loanApplications().findOne({ userId: req.session.user.id, status: { $in: ["pending", "processing", "approved"] } });
    if (existing) return res.status(409).json({ error: "You already have a pending or approved demo loan application." });
    const reference = "PCLA" + randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
    const document = {
      userId: req.session.user.id, customerName: req.session.user.name,
      accountId: account._id, accountNumber: account.accountNumber,
      branchName: account.branchName, reference, amountPaise, tenureMonths,
      purpose, status: "pending", createdAt: new Date(), updatedAt: new Date()
    };
    await loanApplications().insertOne(document);
    await audit(req.session.user, "DEMO_LOAN_APPLIED", reference + " / ₹" + inr(amountPaise));
    res.status(201).json({ ok: true, reference, status: "pending", mode: "DEMO" });
  } catch (error) { res.status(500).json({ error: "Could not submit demo loan application." }); }
});


app.get("/api/banking/cards", permitCustomerAccount, async (req, res) => {
  const card = await demoCards().findOne({ userId: req.session.user.id });
  res.json({ card: card ? { id: String(card._id), reference: card.reference, holderName: card.holderName, last4: card.last4, network: card.network, cardType: card.cardType, status: card.status, issuedAt: card.issuedAt } : null, mode: "DEMO" });
});
app.post("/api/banking/cards", permitCustomerAccount, async (req, res) => {
  try {
    if (await demoCards().findOne({ userId: req.session.user.id })) return res.status(409).json({ error: "A demo debit card already exists." });
    const account = await ensureDemoAccount(req.session.user);
    const card = { userId: req.session.user.id, accountId: account._id, reference: "PCDC" + randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase(), holderName: cleanText(req.session.user.name, 80).toUpperCase(), last4: String(Math.floor(1000 + Math.random() * 9000)), network: "DEMO", cardType: "VIRTUAL DEBIT", status: "active", issuedAt: new Date(), createdAt: new Date() };
    const inserted = await demoCards().insertOne(card);
    await audit(req.session.user, "DEMO_CARD_ISSUED", card.reference);
    res.status(201).json({ ok: true, card: { id: String(inserted.insertedId), reference: card.reference, holderName: card.holderName, last4: card.last4, network: card.network, cardType: card.cardType, status: card.status, issuedAt: card.issuedAt }, mode: "DEMO" });
  } catch (error) { res.status(500).json({ error: "Could not issue demo debit card." }); }
});
app.patch("/api/banking/cards/status", permitCustomerAccount, async (req, res) => {
  const status = req.body?.status;
  if (!["active", "frozen"].includes(status)) return res.status(400).json({ error: "Choose active or frozen." });
  const result = await demoCards().findOneAndUpdate({ userId: req.session.user.id }, { $set: { status, updatedAt: new Date() } }, { returnDocument: "after" });
  const card = result?.value || result;
  if (!card) return res.status(404).json({ error: "Issue a demo card first." });
  await audit(req.session.user, status === "frozen" ? "DEMO_CARD_FROZEN" : "DEMO_CARD_UNFROZEN", card.reference);
  res.json({ ok: true, status: card.status, reference: card.reference, mode: "DEMO" });
});
app.get("/api/banking/cheque-books", permitCustomerAccount, async (req, res) => {
  const items = await chequeBooks().find({ userId: req.session.user.id }).sort({ createdAt: -1 }).limit(50).toArray();
  res.json({ chequeBooks: items.map(item => ({ id: String(item._id), reference: item.reference, leaves: item.leaves, status: item.status, requestedAt: item.createdAt, issuedAt: item.issuedAt || null })) });
});
app.post("/api/banking/cheque-books", permitCustomerAccount, async (req, res) => {
  const leaves = Number(req.body?.leaves);
  if (![10, 25, 50].includes(leaves)) return res.status(400).json({ error: "Choose 10, 25 or 50 leaves." });
  const account = await ensureDemoAccount(req.session.user);
  if (await chequeBooks().findOne({ userId: req.session.user.id, status: "requested" })) return res.status(409).json({ error: "You already have a pending cheque book request." });
  const reference = "PCCB" + randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  const inserted = await chequeBooks().insertOne({ userId: req.session.user.id, accountId: account._id, customerName: req.session.user.name, branchName: req.session.user.branchName || account.branchName, reference, leaves, status: "requested", createdAt: new Date() });
  await audit(req.session.user, "DEMO_CHEQUE_BOOK_REQUESTED", reference + " / " + leaves + " leaves");
  res.status(201).json({ ok: true, id: String(inserted.insertedId), reference, leaves, status: "requested", mode: "DEMO" });
});
app.get("/api/banking/cheque-books/queue", permit("headquarters", "branch", "manager"), async (req, res) => {
  const actor = req.session.user;
  const filter = { status: "requested" };
  if (actor.role !== "headquarters") filter.branchName = actor.branchName || "";
  const items = await chequeBooks().find(filter).sort({ createdAt: 1 }).limit(100).toArray();
  res.json({ requests: items.map(item => ({ id: String(item._id), reference: item.reference, customerName: item.customerName, leaves: item.leaves, branchName: item.branchName, status: item.status, createdAt: item.createdAt })) });
});
app.patch("/api/banking/cheque-books/:id/issue", permit("headquarters", "branch", "manager"), async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid cheque book request." });
  const actor = req.session.user;
  const filter = { _id: new ObjectId(req.params.id), status: "requested" };
  if (actor.role !== "headquarters") filter.branchName = actor.branchName || "";
  const result = await chequeBooks().findOneAndUpdate(filter, { $set: { status: "issued", issuedAt: new Date(), issuedBy: actor.email } }, { returnDocument: "after" });
  const item = result?.value || result;
  if (!item) return res.status(404).json({ error: "Pending cheque book request not found in your branch." });
  await audit(actor, "DEMO_CHEQUE_BOOK_ISSUED", item.reference);
  res.json({ ok: true, reference: item.reference, status: item.status, mode: "DEMO" });
});

app.get("/api/banking/loans", signed, async (req, res) => {
  try {
    const actor = req.session.user;
    if (actor.role === "customer" && !await bankAccounts().findOne({ userId: actor.id }, { projection: { _id: 1 } })) {
      return res.status(403).json({ error: "Your demo account is pending approval." });
    }
    let filter;
    if (actor.role === "customer") filter = { userId: actor.id };
    else if (actor.role === "headquarters") filter = {};
    else if (["branch", "manager"].includes(actor.role)) filter = { branchName: actor.branchName || "" };
    else return res.status(403).json({ error: "Not permitted." });
    const items = await loanApplications().find(filter).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ loans: items.map(item => ({
      id: String(item._id), reference: item.reference, customerName: item.customerName,
      amount: inr(item.amountPaise), tenureMonths: item.tenureMonths, purpose: item.purpose,
      status: item.status, branchName: item.branchName, createdAt: item.createdAt,
      decisionAt: item.decisionAt || null, decisionNote: item.decisionNote || "",
      interestRate: item.interestRate || null, emi: item.emiPaise ? inr(item.emiPaise) : null,
      totalPayable: item.totalPayablePaise ? inr(item.totalPayablePaise) : null,
      outstanding: item.outstandingPaise !== undefined ? inr(item.outstandingPaise) : null,
      paidInstallments: item.paidInstallments || 0, nextDueAt: item.nextDueAt || null
    })) });
  } catch (error) { res.status(500).json({ error: "Could not load demo loan applications." }); }
});

app.patch("/api/banking/loans/:id/decision", permit("headquarters", "branch", "manager"), async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid loan application id." });
    const decision = req.body?.decision;
    const decisionNote = cleanText(req.body?.note, 160);
    if (!["approve", "reject"].includes(decision)) return res.status(400).json({ error: "Choose approve or reject." });
    const actor = req.session.user;
    const filter = { _id: new ObjectId(req.params.id), status: "pending" };
    if (actor.role !== "headquarters") filter.branchName = actor.branchName || "";
    const application = await loanApplications().findOne(filter);
    if (!application) return res.status(404).json({ error: "Pending demo loan not found in your branch." });
    if (decision === "reject") {
      const changed = await loanApplications().updateOne(filter, { $set: { status: "rejected", decisionAt: new Date(), decisionBy: actor.email, decisionNote } });
      if (!changed.modifiedCount) return res.status(409).json({ error: "Application has already been processed." });
      await audit(actor, "DEMO_LOAN_REJECTED", application.reference);
      return res.json({ ok: true, reference: application.reference, status: "rejected" });
    }
    const claimed = await loanApplications().updateOne(filter, { $set: { status: "processing", decisionBy: actor.email, decisionNote } });
    if (!claimed.modifiedCount) return res.status(409).json({ error: "Application has already been processed." });
    let creditApplied = false;
    try {
      const rate = 12;
      const emiPaise = calculateDemoEmi(application.amountPaise, application.tenureMonths, rate);
      const totalPayablePaise = emiPaise * application.tenureMonths;
      const firstDueAt = addMonths(new Date(), 1);
      const credit = await bankAccounts().updateOne({ _id: application.accountId, status: "active" }, { $inc: { balancePaise: application.amountPaise }, $set: { updatedAt: new Date() } });
      if (!credit.modifiedCount) throw new Error("Customer demo account is unavailable.");
      creditApplied = true;
      await bankTransactions().insertOne({
        transferId: application.reference, accountId: application.accountId, userId: application.userId,
        direction: "credit", type: "demo_loan_disbursement", amountPaise: application.amountPaise,
        counterparty: "DEMO LOAN DESK", reference: application.reference,
        note: "Simulated loan disbursement; not a real credit facility",
        status: "completed", createdAt: new Date(), actorEmail: actor.email
      });
      await loanApplications().updateOne({ _id: application._id, status: "processing" }, { $set: {
        status: "approved", decisionAt: new Date(), interestRate: rate,
        emiPaise, totalPayablePaise, outstandingPaise: totalPayablePaise,
        paidInstallments: 0, nextDueAt: firstDueAt
      } });
    } catch (error) {
      await bankTransactions().deleteOne({ transferId: application.reference });
      if (creditApplied) await bankAccounts().updateOne({ _id: application.accountId }, { $inc: { balancePaise: -application.amountPaise } });
      await loanApplications().updateOne({ _id: application._id, status: "processing" }, { $set: { status: "pending", decisionBy: null } });
      throw error;
    }
    await audit(actor, "DEMO_LOAN_APPROVED", application.reference);
    res.json({ ok: true, reference: application.reference, status: "approved", mode: "DEMO" });
  } catch (error) { res.status(500).json({ error: "Could not process demo loan decision." }); }
});


app.post("/api/banking/loans/:id/repay", permitCustomerAccount, async (req, res) => {
  let claimedLoan = null;
  let debitedAccount = null;
  let ledgerInserted = false;
  let installmentReference = null;
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid demo loan id." });
    const loanId = new ObjectId(req.params.id);
    const loan = await loanApplications().findOne({
      _id: loanId, userId: req.session.user.id, status: "approved"
    });
    if (!loan) return res.status(404).json({ error: "No repayable demo loan found." });
    const paid = Number(loan.paidInstallments || 0);
    if (paid >= loan.tenureMonths || !(loan.emiPaise > 0) || !(loan.outstandingPaise > 0)) {
      return res.status(409).json({ error: "All demo loan installments are already paid." });
    }
    const emiPaise = Math.min(loan.emiPaise, loan.outstandingPaise);
    const claim = await loanApplications().updateOne(
      { _id: loanId, userId: req.session.user.id, status: "approved", paidInstallments: paid, outstandingPaise: loan.outstandingPaise },
      { $set: { status: "repayment_processing", repaymentStartedAt: new Date() } }
    );
    if (!claim.modifiedCount) return res.status(409).json({ error: "A repayment is already processing. Refresh and try again." });
    claimedLoan = loan;
    const debit = await bankAccounts().updateOne(
      { _id: loan.accountId, userId: req.session.user.id, status: "active", balancePaise: { $gte: emiPaise } },
      { $inc: { balancePaise: -emiPaise }, $set: { updatedAt: new Date() } }
    );
    if (!debit.modifiedCount) {
      await loanApplications().updateOne({ _id: loanId, status: "repayment_processing" }, { $set: { status: "approved" }, $unset: { repaymentStartedAt: "" } });
      claimedLoan = null;
      return res.status(400).json({ error: "Insufficient demo balance to pay this installment." });
    }
    debitedAccount = loan.accountId;
    const installmentNumber = paid + 1;
    installmentReference = loan.reference + "-EMI-" + String(installmentNumber).padStart(3, "0");
    await bankTransactions().insertOne({
      transferId: installmentReference, accountId: loan.accountId, userId: loan.userId,
      direction: "debit", type: "demo_loan_emi", amountPaise: emiPaise,
      counterparty: "DEMO LOAN REPAYMENT", reference: loan.reference,
      note: "Simulated EMI installment " + installmentNumber + " of " + loan.tenureMonths,
      status: "completed", createdAt: new Date(), actorEmail: req.session.user.email
    });
    ledgerInserted = true;
    const nextPaid = installmentNumber;
    const nextOutstanding = Math.max(0, loan.outstandingPaise - emiPaise);
    const nextStatus = nextPaid >= loan.tenureMonths || nextOutstanding === 0 ? "paid" : "approved";
    const nextDueAt = nextStatus === "paid" ? null : addMonths(loan.nextDueAt || new Date(), 1);
    const updated = await loanApplications().updateOne(
      { _id: loanId, status: "repayment_processing", paidInstallments: paid },
      { $set: {
        status: nextStatus, paidInstallments: nextPaid, outstandingPaise: nextOutstanding,
        nextDueAt, lastPaidAt: new Date(), updatedAt: new Date()
      }, $unset: { repaymentStartedAt: "" } }
    );
    if (!updated.modifiedCount) throw new Error("Could not complete installment update.");
    claimedLoan = null;
    await audit(req.session.user, "DEMO_LOAN_EMI_PAID", installmentReference + " / ₹" + inr(emiPaise)).catch(() => {});
    return res.json({
      ok: true, mode: "DEMO", reference: loan.reference, installmentReference,
      installmentNumber: nextPaid, paidAmount: inr(emiPaise),
      outstanding: inr(nextOutstanding), status: nextStatus, nextDueAt
    });
  } catch (error) {
    if (claimedLoan) {
      if (ledgerInserted && installmentReference) await bankTransactions().deleteOne({ transferId: installmentReference }).catch(() => {});
      if (debitedAccount) await bankAccounts().updateOne({ _id: debitedAccount }, { $inc: { balancePaise: claimedLoan.emiPaise }, $set: { updatedAt: new Date() } }).catch(() => {});
      await loanApplications().updateOne(
        { _id: claimedLoan._id, status: "repayment_processing" },
        { $set: { status: "approved" }, $unset: { repaymentStartedAt: "" } }
      ).catch(() => {});
    }
    return res.status(500).json({ error: "Could not complete demo loan repayment. Refresh before retrying." });
  }
});

app.use("/api", (req, res) => res.status(404).json({ error: "API route not found." }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(status).json({
      error: status === 400 ? "Invalid request body." : "The server could not complete this request."
    });
  }
  res.status(status).send("The server could not complete this request.");
});

app.get("/robots.txt", (req, res) => res.type("text").send(
  "User-agent: *\nAllow: /\nDisallow: /login/\nDisallow: /dashboard/\nSitemap: /sitemap.xml\n"
));
app.get("/sitemap.xml", (req, res) => {
  const base = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000").replace(/\/$/, "");
  const pages = ["", "/account-opening.html", "/loans.html", "/fd-investments.html", "/interest-rates.html"];
  const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    pages.map(page => "<url><loc>" + base + page + "</loc></url>").join("") + "</urlset>";
  res.type("application/xml").send(xml);
});

app.get("/login/:role", (req, res) => roles.includes(req.params.role)
  ? res.sendFile(path.join(__dirname, "public", "login.html"))
  : res.sendStatus(404));
app.get("/dashboard/:role", (req, res) => roles.includes(req.params.role)
  ? res.sendFile(path.join(__dirname, "public", "dashboard.html"))
  : res.sendStatus(404));
app.get("*", (req, res, next) => path.extname(req.path)
  ? next()
  : res.sendFile(path.join(__dirname, "public", "index.html")));

initialise()
  .then(() => app.listen(process.env.PORT || 3000, () => console.log("Pradhan Capitals Bank prototype running with MongoDB")))
  .catch(error => {
    console.error("MongoDB startup failed:", error.message);
    process.exit(1);
  });
