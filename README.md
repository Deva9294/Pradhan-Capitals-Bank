# Pradhan Capitals Bank — Banking Experience Prototype

A responsive multi-page banking UI and Express demo API. This repository is an educational/prototype application, **not a licensed bank or production core banking system**.

## Included
- Public pages: home, account opening wizard, loans + EMI calculator, FD calculator, rates & charges.
- Role entry points: `/login/customer`, `/login/staff`, `/login/manager`, `/login/admin`.
- Demo console: simulated account summary, transaction history export and transfer simulation.
- Express API: health, demo login, sample summary, transfer simulation.
- SEO: per-page metadata, FinancialService / FAQ structured data, robots.txt and sitemap.xml.
- Responsive design, accessible labels and semantic page structure.

## Run locally
1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set a strong random `SESSION_SECRET`.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000`.

## Important safety boundary
All balances, interest rates, references and transfers are fictitious. The demo login accepts any non-empty username/password and does not authenticate a real customer. No funds move, no accounts are opened, no KYC is performed and no identity documents should be uploaded. The app must not be represented as an RBI-regulated bank or used to collect real customer data.

## Production integration roadmap (requires authorised banking partner and regulatory/legal review)
- Replace demo login with an audited identity provider, MFA, short-lived server-side sessions, CSRF protection, secure cookies, device risk checks and account lockout.
- Use a regulated bank / licensed banking partner for account issuance, payment rails and ledger operations. Never implement a pretend core ledger as a substitute.
- Integrate KYC only through approved provider APIs with consent, data minimisation, encryption at rest, retention controls and audit trails. Do not store Aadhaar/PAN in browser storage or logs.
- Build a double-entry ledger with immutable journal entries, idempotency keys, reconciliation, maker-checker approvals and daily settlement controls in a properly reviewed financial backend.
- Use PostgreSQL with migrations, least-privilege service accounts, encrypted backups, secrets manager, WAF, TLS, monitoring and incident response.
- Add API contract tests, unit/integration tests, dependency scanning, SAST/DAST, penetration testing and independent security review before any real-world use.

## Suggested service boundaries
`identity`, `customer-profile`, `accounts`, `ledger`, `payments`, `kyc`, `lending`, `deposits`, `cards`, `notifications`, `audit`, `admin-policy`.

Never expose admin or employee APIs directly to the public frontend. Enforce authorization on every server request; hiding UI elements is not access control.
