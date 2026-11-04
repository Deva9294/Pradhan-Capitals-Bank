require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const sessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000;
const roleMap = { customer: "customer", staff: "staff", manager: "manager", admin: "admin" };

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public")));

const demoTransactions = [
  { id: "TXN-1042", date: "2026-11-03", description: "Demo salary credit", type: "credit", amount: 42000, status: "Completed" },
  { id: "TXN-1038", date: "2026-11-02", description: "Utility payment simulation", type: "debit", amount: 1850, status: "Completed" },
  { id: "TXN-1029", date: "2026-10-30", description: "Demo transfer", type: "debit", amount: 2500, status: "Completed" }
];

function requireDemoSession(req, res, next) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const session = token && sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: "Demo session expired. Please sign in again." });
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  req.demoSession = session;
  next();
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", mode: "prototype", timestamp: new Date().toISOString() }));

app.post("/api/demo-login", (req, res) => {
  const { role, username, password } = req.body || {};
  if (!roleMap[role] || typeof username !== "string" || !username.trim() || typeof password !== "string" || !password) {
    return res.status(400).json({ error: "Enter a valid demo role, username and password." });
  }
  // Demo-only: accepts any non-empty password. Never use as production authentication.
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { role: roleMap[role], displayName: username.trim().slice(0, 60), expiresAt: Date.now() + SESSION_TTL_MS });
  res.json({ token, role: roleMap[role], displayName: username.trim().slice(0, 60), expiresIn: SESSION_TTL_MS / 1000, notice: "Demo session only. No real banking access." });
});

app.get("/api/demo/session", requireDemoSession, (req, res) => {
  res.json({ role: req.demoSession.role, displayName: req.demoSession.displayName, expiresIn: Math.max(0, Math.floor((req.demoSession.expiresAt - Date.now()) / 1000)) });
});

app.post("/api/demo-logout", requireDemoSession, (req, res) => {
  const token = req.get("authorization").replace(/^Bearer\s+/i, "");
  sessions.delete(token);
  res.json({ ok: true, message: "Demo session ended." });
});

app.get("/api/demo/summary", requireDemoSession, (_req, res) => res.json({
  mode: "SIMULATED DATA",
  account: { maskedNumber: "XXXX XXXX 4821", availableBalance: 125480.75, currency: "INR" },
  transactions: demoTransactions
}));

app.post("/api/demo/transfer", requireDemoSession, (req, res) => {
  if (req.demoSession.role !== "customer") return res.status(403).json({ error: "Only the customer demo role can access transfer simulation." });
  const { beneficiary, amount, rail } = req.body || {};
  const value = Number(amount);
  if (typeof beneficiary !== "string" || !beneficiary.trim() || !Number.isFinite(value) || value <= 0 || value > 100000) {
    return res.status(400).json({ error: "Enter a beneficiary and a valid demo amount (up to ₹1,00,000)." });
  }
  res.status(202).json({ reference: "DEMO-" + crypto.randomBytes(4).toString("hex").toUpperCase(), status: "SIMULATION_ONLY", rail: ["IMPS", "NEFT", "RTGS", "UPI"].includes(rail) ? rail : "IMPS", amount: value, message: "No money moved. This is a user-interface simulation." });
});

app.get("/robots.txt", (_req, res) => res.type("text").send("User-agent: *\nAllow: /\nDisallow: /login/\nDisallow: /dashboard.html\nSitemap: /sitemap.xml\n"));
app.get("/sitemap.xml", (_req, res) => {
  const base = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
  const pages = ["", "/account-opening.html", "/loans.html", "/fd-investments.html", "/interest-rates.html"];
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(page => `<url><loc>${base}${page}</loc></url>`).join("")}</urlset>`);
});
app.get("/login/:role", (req, res) => {
  if (!roleMap[req.params.role]) return res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.get("*", (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Pradhan Capitals Bank prototype listening on ${PORT}`));
