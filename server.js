require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");
const app = express();
const PORT = process.env.PORT || 3000;
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
const roleMap = { customer: "customer", staff: "staff", manager: "manager", admin: "admin" };
app.get("/api/health", (_req, res) => res.json({ status: "ok", mode: "prototype", timestamp: new Date().toISOString() }));
app.post("/api/demo-login", (req, res) => {
  const { role, username, password } = req.body || {};
  if (!roleMap[role] || !username || !password) return res.status(400).json({ error: "Enter a role, username and password." });
  // Prototype only: never use this demo credential flow for a real bank.
  const token = crypto.randomBytes(24).toString("hex");
  res.json({ token, role: roleMap[role], displayName: username, expiresIn: 900, notice: "Demo session only. No real banking access." });
});
app.get("/api/demo/summary", (_req, res) => res.json({
  mode: "SIMULATED DATA",
  account: { maskedNumber: "XXXX XXXX 4821", availableBalance: 125480.75, currency: "INR" },
  transactions: demoTransactions
}));
app.post("/api/demo/transfer", (req, res) => {
  const { beneficiary, amount, rail } = req.body || {};
  const value = Number(amount);
  if (!beneficiary || !Number.isFinite(value) || value <= 0 || value > 100000) return res.status(400).json({ error: "Enter a beneficiary and a valid demo amount (up to ₹1,00,000)." });
  res.status(202).json({ reference: "DEMO-" + crypto.randomBytes(4).toString("hex").toUpperCase(), status: "SIMULATION_ONLY", rail: rail || "IMPS", amount: value, message: "No money moved. This is a user-interface simulation." });
});
app.get("/robots.txt", (_req, res) => res.type("text").send("User-agent: *\nAllow: /\nDisallow: /login/\nSitemap: /sitemap.xml\n"));
app.get("/sitemap.xml", (_req, res) => res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${process.env.PUBLIC_URL || "http://localhost:3000"}/</loc></url><url><loc>${process.env.PUBLIC_URL || "http://localhost:3000"}/account-opening.html</loc></url><url><loc>${process.env.PUBLIC_URL || "http://localhost:3000"}/loans.html</loc></url><url><loc>${process.env.PUBLIC_URL || "http://localhost:3000"}/fd-investments.html</loc></url><url><loc>${process.env.PUBLIC_URL || "http://localhost:3000"}/interest-rates.html</loc></url></urlset>`));
app.get("/login/:role", (req, res) => {
  if (!roleMap[req.params.role]) return res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.get("*", (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.listen(PORT, () => console.log(`Pradhan Capitals Bank prototype listening on ${PORT}`));