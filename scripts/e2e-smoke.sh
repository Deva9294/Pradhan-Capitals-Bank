#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
expect() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $label (expected HTTP $expected, got $actual)"
    cat "$TMP_DIR/body.json" || true
    exit 1
  fi
  echo "PASS: $label"
}
request() {
  local method="$1" cookie="$2" path="$3" payload="${4:-}"
  local args=(-sS -o "$TMP_DIR/body.json" -w "%{http_code}" -X "$method" "$BASE_URL$path")
  if [[ -n "$cookie" ]]; then args+=(-b "$cookie" -c "$cookie"); fi
  if [[ -n "$payload" ]]; then args+=(-H "Content-Type: application/json" -d "$payload"); fi
  HTTP_CODE="$(curl "${args[@]}")"
}
login() {
  local role="$1" email="$2" password="$3" cookie="$4"
  request POST "$cookie" "/api/auth/login" "$(jq -nc --arg role "$role" --arg email "$email" --arg password "$password" '{role:$role,email:$email,password:$password}')"
  expect 200 "$HTTP_CODE" "$role login"
}
ADMIN_COOKIE="$TMP_DIR/admin.cookie"
HQ_COOKIE="$TMP_DIR/hq.cookie"
MANAGER_COOKIE="$TMP_DIR/manager.cookie"
BRANCH_COOKIE="$TMP_DIR/branch.cookie"
STAFF_COOKIE="$TMP_DIR/staff.cookie"
CASHIER_COOKIE="$TMP_DIR/cashier.cookie"
CUSTOMER_COOKIE="$TMP_DIR/customer.cookie"
request GET "" "/api/health"
expect 200 "$HTTP_CODE" "MongoDB health endpoint"
jq -e '.status == "ok" and .database == "connected" and .databaseType == "MongoDB"' "$TMP_DIR/body.json" >/dev/null
login admin "$BOOTSTRAP_SITE_ADMIN_EMAIL" "$BOOTSTRAP_SITE_ADMIN_PASSWORD" "$ADMIN_COOKIE"
request GET "$ADMIN_COOKIE" "/api/admin/site-settings"
expect 200 "$HTTP_CODE" "Website Admin reads site settings"
request PUT "$ADMIN_COOKIE" "/api/admin/site-settings" '{"siteName":"PCB CI Test","tagline":"Automated workflow test","announcement":"CI verification","heroTitle":"Test headline","heroDescription":"Test description","supportEmail":"support@example.com","supportPhone":"+911234567890","footerText":"Prototype test footer"}'
expect 200 "$HTTP_CODE" "Website Admin saves settings"
request GET "" "/api/site-settings"
expect 200 "$HTTP_CODE" "Public homepage settings endpoint"
jq -e '.settings.siteName == "PCB CI Test" and .settings.announcement == "CI verification"' "$TMP_DIR/body.json" >/dev/null
request GET "$ADMIN_COOKIE" "/api/portal/users"
expect 403 "$HTTP_CODE" "Website Admin cannot access HQ directory"
login headquarters "$BOOTSTRAP_ADMIN_EMAIL" "$BOOTSTRAP_ADMIN_PASSWORD" "$HQ_COOKIE"
create_user() {
  local cookie="$1" name="$2" email="$3" role="$4" branch="$5" password="$6" expected="$7" label="$8"
  local payload
  payload="$(jq -nc --arg name "$name" --arg email "$email" --arg role "$role" --arg branchName "$branch" --arg password "$password" '{name:$name,email:$email,role:$role,branchName:$branchName,password:$password}')"
  request POST "$cookie" "/api/portal/users" "$payload"
  expect "$expected" "$HTTP_CODE" "$label"
}
create_user "$HQ_COOKIE" "CI Branch" "branch.ci@example.com" branch "Bhopal Test" "ci-branch-password-123" 201 "HQ creates branch"
BRANCH_ID="$(jq -r '.user.id' "$TMP_DIR/body.json")"
create_user "$HQ_COOKIE" "CI Manager" "manager.ci@example.com" manager "Bhopal Test" "ci-manager-password-123" 201 "HQ creates manager"
create_user "$HQ_COOKIE" "CI Staff" "staff.ci@example.com" staff "Bhopal Test" "ci-staff-password-123" 201 "HQ creates staff"
create_user "$HQ_COOKIE" "CI Cashier" "cashier.ci@example.com" cashier "Bhopal Test" "ci-cashier-password-123" 201 "HQ creates cashier"
login manager manager.ci@example.com ci-manager-password-123 "$MANAGER_COOKIE"
create_user "$MANAGER_COOKIE" "Manager Staff" "manager.staff.ci@example.com" staff "Bhopal Test" "ci-manager-staff-password-123" 201 "Manager creates staff in own branch"
create_user "$MANAGER_COOKIE" "Forbidden Cashier" "forbidden.cashier@example.com" cashier "Bhopal Test" "ci-forbidden-password-123" 403 "Manager cannot create cashier"
login branch branch.ci@example.com ci-branch-password-123 "$BRANCH_COOKIE"
request GET "$BRANCH_COOKIE" "/api/portal/users"
expect 200 "$HTTP_CODE" "Branch reads its directory"
jq -e 'all(.users[]; .branch_name == "Bhopal Test")' "$TMP_DIR/body.json" >/dev/null
login staff staff.ci@example.com ci-staff-password-123 "$STAFF_COOKIE"
login cashier cashier.ci@example.com ci-cashier-password-123 "$CASHIER_COOKIE"
request GET "$CASHIER_COOKIE" "/api/requests"
expect 403 "$HTTP_CODE" "Cashier cannot access customer request records"
request POST "" "/api/auth/register" '{"name":"CI Customer","email":"customer.ci@example.com","password":"ci-customer-password-123"}'
expect 201 "$HTTP_CODE" "Customer registration"
jq -e '.demoAccount.accountNumber | startswith("PCBD")' "$TMP_DIR/body.json" >/dev/null
login customer customer.ci@example.com ci-customer-password-123 "$CUSTOMER_COOKIE"
request GET "$CUSTOMER_COOKIE" "/api/banking/account"
expect 200 "$HTTP_CODE" "Customer reads simulated banking account"
jq -e '.account.mode == "DEMO" and .account.balance == 25000' "$TMP_DIR/body.json" >/dev/null
CUSTOMER_ACCOUNT="$(jq -r '.account.accountNumber' "$TMP_DIR/body.json")"
request POST "" "/api/auth/register" '{"name":"CI Beneficiary","email":"beneficiary.ci@example.com","password":"ci-beneficiary-password-123"}'
expect 201 "$HTTP_CODE" "Beneficiary demo registration"
BENEFICIARY_ACCOUNT="$(jq -r '.demoAccount.accountNumber' "$TMP_DIR/body.json")"
request POST "$CUSTOMER_COOKIE" "/api/banking/beneficiaries" "$(jq -nc --arg accountNumber "$BENEFICIARY_ACCOUNT" '{name:"CI Saved Beneficiary",accountNumber:$accountNumber}')"
expect 201 "$HTTP_CODE" "Customer saves demo beneficiary"
request GET "$CUSTOMER_COOKIE" "/api/banking/beneficiaries"
expect 200 "$HTTP_CODE" "Customer reads saved beneficiaries"
jq -e --arg account "$BENEFICIARY_ACCOUNT" 'any(.beneficiaries[]; .accountNumber == $account)' "$TMP_DIR/body.json" >/dev/null
BENEFICIARY_COOKIE="$TMP_DIR/beneficiary.cookie"
login customer beneficiary.ci@example.com ci-beneficiary-password-123 "$BENEFICIARY_COOKIE"
request POST "$CUSTOMER_COOKIE" "/api/banking/transfer" "$(jq -nc --arg accountNumber "$BENEFICIARY_ACCOUNT" '{accountNumber:$accountNumber,amount:500,note:"CI transfer"}')"
expect 201 "$HTTP_CODE" "Internal demo transfer"
TRANSFER_REF="$(jq -r '.reference' "$TMP_DIR/body.json")"
request GET "$CUSTOMER_COOKIE" "/api/banking/account"
expect 200 "$HTTP_CODE" "Sender demo balance updated"
jq -e '.account.balance == 24500' "$TMP_DIR/body.json" >/dev/null
request GET "$BENEFICIARY_COOKIE" "/api/banking/account"
expect 200 "$HTTP_CODE" "Beneficiary demo balance updated"
jq -e '.account.balance == 25500' "$TMP_DIR/body.json" >/dev/null
request GET "$CUSTOMER_COOKIE" "/api/banking/transactions"
expect 200 "$HTTP_CODE" "Demo passbook statement"
jq -e --arg ref "$TRANSFER_REF" 'any(.transactions[]; .reference == $ref and .direction == "debit")' "$TMP_DIR/body.json" >/dev/null
request POST "$CUSTOMER_COOKIE" "/api/requests" '{"type":"account_information","branchName":"Bhopal Test","note":"Automated CI request"}'
expect 201 "$HTTP_CODE" "Customer creates demo request"
REQUEST_REF="$(jq -r '.request.reference' "$TMP_DIR/body.json")"
request POST "$CUSTOMER_COOKIE" "/api/banking/fixed-deposits" '{"amount":1000,"tenureMonths":3}'
expect 201 "$HTTP_CODE" "Customer opens demo fixed deposit"
FD_REF="$(jq -r '.reference' "$TMP_DIR/body.json")"
jq -e '.rate == 6.5 and .maturityAmount > 1000' "$TMP_DIR/body.json" >/dev/null
request GET "$CUSTOMER_COOKIE" "/api/banking/account"
expect 200 "$HTTP_CODE" "FD principal is moved from available demo balance"
jq -e '.account.balance == 23600' "$TMP_DIR/body.json" >/dev/null
request GET "$CUSTOMER_COOKIE" "/api/banking/fixed-deposits"
expect 200 "$HTTP_CODE" "Customer reads fixed deposit portfolio"
jq -e --arg ref "$FD_REF" 'any(.fixedDeposits[]; .reference == $ref and .status == "active")' "$TMP_DIR/body.json" >/dev/null
request POST "$CUSTOMER_COOKIE" "/api/banking/loans" '{"amount":10000,"tenureMonths":12,"purpose":"CI demo education loan"}'
expect 201 "$HTTP_CODE" "Customer submits demo loan application"
LOAN_REF="$(jq -r '.reference' "$TMP_DIR/body.json")"
request GET "$MANAGER_COOKIE" "/api/banking/loans"
expect 200 "$HTTP_CODE" "Manager reads branch loan review queue"
LOAN_ID="$(jq -r --arg ref "$LOAN_REF" '.loans[] | select(.reference == $ref) | .id' "$TMP_DIR/body.json")"
test -n "$LOAN_ID"
request PATCH "$MANAGER_COOKIE" "/api/banking/loans/$LOAN_ID/decision" '{"decision":"approve","note":"CI demo approval"}'
expect 200 "$HTTP_CODE" "Manager approves demo loan and simulates disbursement"
request GET "$CUSTOMER_COOKIE" "/api/banking/account"
expect 200 "$HTTP_CODE" "Demo loan disbursement updates customer balance"
jq -e '.account.balance == 33600' "$TMP_DIR/body.json" >/dev/null
request GET "$CUSTOMER_COOKIE" "/api/banking/transactions"
expect 200 "$HTTP_CODE" "Passbook includes demo loan disbursement"
jq -e --arg ref "$LOAN_REF" 'any(.transactions[]; .reference == $ref and .type == "demo_loan_disbursement")' "$TMP_DIR/body.json" >/dev/null
request POST "$CASHIER_COOKIE" "/api/banking/cash-operations" "$(jq -nc --arg accountNumber "$CUSTOMER_ACCOUNT" '{accountNumber:$accountNumber,type:"cash_deposit",amount:100,note:"CI demo deposit"}')"
expect 201 "$HTTP_CODE" "Cashier submits pending demo cash deposit"
CASH_REF="$(jq -r '.reference' "$TMP_DIR/body.json")"
request GET "$CASHIER_COOKIE" "/api/banking/cash-operations"
expect 200 "$HTTP_CODE" "Cashier views cash queue"
CASH_ID="$(jq -r --arg ref "$CASH_REF" '.operations[] | select(.reference == $ref) | .id' "$TMP_DIR/body.json")"
test -n "$CASH_ID"
request PATCH "$CASHIER_COOKIE" "/api/banking/cash-operations/$CASH_ID/approve" '{}'
expect 403 "$HTTP_CODE" "Cashier cannot approve own cash entry"
request PATCH "$MANAGER_COOKIE" "/api/banking/cash-operations/$CASH_ID/approve" '{}'
expect 200 "$HTTP_CODE" "Manager approves branch cash deposit"
request GET "$CUSTOMER_COOKIE" "/api/banking/account"
expect 200 "$HTTP_CODE" "Approved cash deposit updates demo balance"
jq -e '.account.balance == 24600' "$TMP_DIR/body.json" >/dev/null
request GET "$CUSTOMER_COOKIE" "/api/requests"
expect 200 "$HTTP_CODE" "Customer reads own requests"
REQUEST_ID="$(jq -r --arg ref "$REQUEST_REF" '.requests[] | select(.reference == $ref) | .id' "$TMP_DIR/body.json")"
test -n "$REQUEST_ID"
request GET "$HQ_COOKIE" "/api/requests"
expect 200 "$HTTP_CODE" "HQ reads request queue"
request PATCH "$HQ_COOKIE" "/api/requests/$REQUEST_ID/status" '{"status":"in_review"}'
expect 200 "$HTTP_CODE" "HQ updates request status"
request GET "$BRANCH_COOKIE" "/api/requests"
expect 200 "$HTTP_CODE" "Branch reads its assigned requests"
jq -e --arg ref "$REQUEST_REF" 'any(.requests[]; .reference == $ref and .status == "in_review")' "$TMP_DIR/body.json" >/dev/null
request PATCH "$STAFF_COOKIE" "/api/requests/$REQUEST_ID/status" '{"status":"resolved"}'
expect 200 "$HTTP_CODE" "Staff resolves branch request"
request GET "$CUSTOMER_COOKIE" "/api/requests"
expect 200 "$HTTP_CODE" "Customer sees updated request status"
jq -e --arg ref "$REQUEST_REF" 'any(.requests[]; .reference == $ref and .status == "resolved")' "$TMP_DIR/body.json" >/dev/null
request PATCH "$HQ_COOKIE" "/api/portal/users/$BRANCH_ID/status" '{"isActive":false}'
expect 200 "$HTTP_CODE" "HQ deactivates branch login"
request GET "$BRANCH_COOKIE" "/api/auth/me"
expect 401 "$HTTP_CODE" "Inactive account session is rejected"
request PATCH "$HQ_COOKIE" "/api/portal/users/$BRANCH_ID/status" '{"isActive":true}'
expect 200 "$HTTP_CODE" "HQ reactivates branch login"
request POST "$HQ_COOKIE" "/api/auth/logout" '{}'
expect 200 "$HTTP_CODE" "HQ logout"
echo "PASS: all MongoDB-backed role and workflow integration checks completed"
