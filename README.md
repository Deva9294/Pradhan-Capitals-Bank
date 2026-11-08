# Pradhan Capitals Bank — Banking Experience Prototype

A MongoDB-backed, multi-role banking experience demonstration. This project is **not a licensed bank, payment provider, deposit-taking institution or production core-banking system**. It must not be used to hold funds, process real payments, make credit decisions, or collect real KYC/identity information.

## Roles and permissions

- **Website Admin** (\`/login/admin\`): edits public homepage name, tagline, announcement, headline, description, support contact and footer notice. Does not manage banking roles.
- **Headquarters** (\`/login/headquarters\`): creates branch, manager, staff and cashier demo accounts; views organisation users and audit events; reviews and updates demo requests.
- **Branch** (\`/login/branch\`): sees users and requests scoped to its assigned branch.
- **Manager** (\`/login/manager\`): creates staff accounts only within their own branch; sees and updates branch demo requests.
- **Staff** (\`/login/staff\`): sees and updates demo requests assigned to their branch.
- **Cashier** (\`/login/cashier\`): submits simulated branch cash entries; manager/branch/HQ approval is required before the demo ledger changes.
- **Customer** (\`/login/customer\`): receives a sample demo account, transfers simulated funds internally, saves beneficiaries, opens demo fixed deposits, views a passbook, submits demo loan applications and repays simulated EMIs after approval.

## MongoDB collections

- \`users\`: role accounts, bcrypt password hashes and account active state.
- \`sessions\`: expiring server-side login sessions.
- \`audit_logs\`: authentication, account and request status activity.
- \`demo_requests\`: customer sample enquiries and branch workflow statuses.
- \`site_settings\`: public homepage content configured by Website Admin.\n- \`bank_accounts\`, \`bank_transactions\`: simulated account balances and ledger entries.\n- \`cash_operations\`: pending branch cash desk entries and approvals.\n- \`demo_beneficiaries\`: customer-saved internal demo beneficiaries.\n- \`demo_fixed_deposits\`: simulated fixed deposits and maturity crediting.\n- \`demo_loan_applications\`: sample loan requests and HQ/branch/manager decisions.

Indexes for unique email, request references, role/branch lookups and audit history are created at startup.

## Local setup

1. Install Node.js 20+ and MongoDB.
2. Copy \`.env.example\` to \`.env\`.
3. Set \`MONGODB_URI\`, \`MONGODB_DB\` and a random \`SESSION_SECRET\` (at least 32 characters).
4. Set distinct \`BOOTSTRAP_SITE_ADMIN_EMAIL\` / \`BOOTSTRAP_SITE_ADMIN_PASSWORD\` and \`BOOTSTRAP_ADMIN_EMAIL\` / \`BOOTSTRAP_ADMIN_PASSWORD\`. Bootstrap passwords must be at least 16 characters.
5. Run \`npm install\`, then \`npm test\`, then \`npm start\`.
6. Open \`/api/health\`; it must report \`database: "connected"\`.

## Render deployment

1. Configure a MongoDB Atlas cluster and network access for the Render service. Prefer the narrowest available network access policy.
2. Set these Render environment variables privately:
   - \`MONGODB_URI\`
   - \`MONGODB_DB=pradhan_capitals\`
   - \`SESSION_SECRET\` (at least 32 random characters)
   - \`BOOTSTRAP_SITE_ADMIN_EMAIL\` and \`BOOTSTRAP_SITE_ADMIN_PASSWORD\`
   - \`BOOTSTRAP_ADMIN_EMAIL\` and \`BOOTSTRAP_ADMIN_PASSWORD\`
3. Use different email addresses for Website Admin and Headquarters. Never commit credentials or the MongoDB URI.
4. Deploy the latest \`main\` commit and wait for the Render health check.
5. Verify \`/api/health\` returns \`status: "ok"\`, \`database: "connected"\` and \`databaseType: "MongoDB"\`.
6. Sign in through the relevant role portal. HQ provisions branch/manager/staff/cashier accounts; managers provision staff within their branch.

Render Blueprint variables marked \`sync: false\` must still be entered in the existing service's Environment page if the Blueprint has not been applied to that service. The Blueprint does not create or pay for a MongoDB cluster.

## Validation

- \`npm test\` runs Node.js syntax checks for the server and browser scripts.
- The test command is not a live MongoDB integration or penetration test.
- Test all seven role logins, create a customer demo request, update its status from HQ/branch, change homepage content as Website Admin, deactivate a user from HQ and verify that the inactive user's session is rejected.
- Confirm Render health is healthy after every deployment.

## Security notes and boundaries

The app uses bcrypt password hashing, MongoDB-backed sessions, HttpOnly/SameSite cookies, session ID regeneration at login, server-side active-account checks, role/branch-scoped routes, authentication rate limiting, input validation and audit events. This is a starter prototype, not an independently security-audited production service. It does not provide real KYC, OTP verification, deposits, withdrawals, UPI/Razorpay payments, account opening, lending or regulated banking services. Demo account numbers begin with `PCBD`; the displayed IFSC is fictional. Internal transfers, FD principal/maturity and approved sample loan credits and customer-initiated EMI repayments update MongoDB demo balances only. Loan repayments use a sample 12% p.a. rate, show EMI/outstanding/next due date, and create a debit entry in the demo passbook. Cashier deposit/withdrawal entries require manager, branch or HQ approval. Demo transfers are limited to ₹50,000 per operation; cash desk entries are limited to ₹1,00,000; FD amounts are ₹100–₹10,00,000 with 3–36 month sample tenures; loan requests are ₹1,000–₹5,00,000 and require branch/manager/HQ review. FD rates and maturity values are illustrative, not an offer. These controls are not a substitute for production core-banking controls or audited database transactions. Do not enter real customer information, passwords, OTPs, PINs, Aadhaar/PAN data or identity documents.
