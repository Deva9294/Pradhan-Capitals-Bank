# Pradhan Capitals Bank — Banking Experience Prototype

Multi-role Express demo application. This is an educational prototype, **not a licensed bank or production core-banking system**.

## Database and roles
MongoDB stores user accounts, audit events and demo request records. MongoDB also stores expiring login sessions. Roles: customer, branch, staff, manager and headquarters.

Login URLs: `/login/customer`, `/login/branch`, `/login/staff`, `/login/manager`, `/login/headquarters`.
Dashboard URLs: `/dashboard/customer`, `/dashboard/branch`, `/dashboard/staff`, `/dashboard/manager`, `/dashboard/headquarters`.

Collections: `users`, `audit_logs`, `demo_requests`, `sessions`. Unique email and query indexes are created on startup. Passwords are hashed using bcrypt. Employee accounts are provisioned by HQ; managers can create staff only for their own branch.

## Local setup
1. Install Node.js 20+ and MongoDB.
2. Copy `.env.example` to `.env`.
3. Set `MONGODB_URI`, `MONGODB_DB`, and a strong `SESSION_SECRET`.
4. Run `npm install`, then `npm start`.
5. Check `/api/health` for MongoDB connection status.

## Render deployment
1. Create a MongoDB Atlas cluster or use another MongoDB provider.
2. Configure provider network access so the Render web service can connect. Use the narrowest supported access policy.
3. Connect this repository in Render and apply the Blueprint.
4. Set `MONGODB_URI` to the provider connection string, `MONGODB_DB` to `pradhan_capitals`, and set `BOOTSTRAP_ADMIN_EMAIL` and a unique `BOOTSTRAP_ADMIN_PASSWORD` (16+ characters) in Render Environment.
5. Keep all credentials private; never commit the URI or passwords.
6. Redeploy and verify `/api/health` reports `database: connected` and `databaseType: MongoDB`.
7. Sign in at `/login/headquarters` and create branch, manager and staff demo logins.

The Blueprint does not create or pay for a MongoDB cluster. Review your provider's pricing, storage, backup and network limits before choosing a plan.

## Validation
Run `npm test` for syntax checks. A syntax check is not a live MongoDB integration test; verify the deployed health endpoint and test each role after configuring the database.

## Safety boundary
All balances, rates and transactions are fictitious. No funds move, real accounts are not opened and KYC is not performed. Do not collect real customer information, identity documents or banking credentials. This app must not be represented as an RBI-regulated bank. Real banking requires an authorised regulated partner, legal review and independent security assessment.
