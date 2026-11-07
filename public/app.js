const $ = selector => document.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = value => new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR", maximumFractionDigits: 0
}).format(Number.isFinite(value) ? value : 0);

function emi(principal, annualRate, months) {
  const monthlyRate = annualRate / 1200;
  return monthlyRate
    ? principal * monthlyRate * Math.pow(1 + monthlyRate, months) / (Math.pow(1 + monthlyRate, months) - 1)
    : principal / months;
}
function updateLoan() {
  const principal = Number($("#loanAmount")?.value || 2500000);
  const rate = Number($("#loanRate")?.value || 9);
  const years = Number($("#loanYears")?.value || 20);
  const monthly = emi(principal, rate, years * 12);
  if ($("#emiValue")) $("#emiValue").textContent = money(monthly);
  if ($("#loanPrincipal")) $("#loanPrincipal").textContent = money(principal);
  if ($("#loanInterest")) $("#loanInterest").textContent = money(monthly * years * 12 - principal);
  for (const id of ["loanAmount", "loanRate", "loanYears"]) {
    const input = $("#" + id), output = $("#" + id + "Out");
    if (input && output) output.textContent = id === "loanAmount"
      ? money(Number(input.value))
      : input.value + (id === "loanRate" ? "%" : " years");
  }
}
function updateFD() {
  const principal = Number($("#fdAmount")?.value || 100000);
  const rate = Number($("#fdRate")?.value || 7);
  const years = Number($("#fdYears")?.value || 3);
  const maturity = principal * Math.pow(1 + rate / 400, 4 * years);
  if ($("#fdMaturity")) $("#fdMaturity").textContent = money(maturity);
  if ($("#fdInterest")) $("#fdInterest").textContent = money(maturity - principal);
  if ($("#fdAmountOut")) $("#fdAmountOut").textContent = money(principal);
  if ($("#fdRateOut")) $("#fdRateOut").textContent = rate.toFixed(1) + "%";
  if ($("#fdYearsOut")) $("#fdYearsOut").textContent = years + " years";
}
for (const id of ["loanAmount", "loanRate", "loanYears"]) {
  $("#" + id)?.addEventListener("input", updateLoan);
}
for (const id of ["fdAmount", "fdRate", "fdYears"]) {
  $("#" + id)?.addEventListener("input", updateFD);
}
updateLoan();
updateFD();

$$("[data-tab]").forEach(button => button.addEventListener("click", () => {
  $$("[data-tab]").forEach(item => item.classList.toggle("active", item === button));
  $$("[data-panel]").forEach(panel => panel.classList.toggle("hidden", panel.dataset.panel !== button.dataset.tab));
}));

async function submitDemoRequest(type, branchName, note) {
  const response = await fetch("/api/requests", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, branchName, note })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      location.href = "/login/customer";
      throw new Error("Please sign in with your customer demo account. You will be returned to the portal.");
    }
    throw new Error(data.error || "Could not submit demo request.");
  }
  return data.request;
}

const accountSteps = $$("[data-step]");
let accountStep = 0;
function showAccountStep() {
  accountSteps.forEach((section, index) => section.classList.toggle("hidden", index !== accountStep));
  if ($("#stepProgress")) $("#stepProgress").style.width = ((accountStep + 1) / accountSteps.length * 100) + "%";
  if ($("#stepLabel")) $("#stepLabel").textContent = "Step " + (accountStep + 1) + " of " + accountSteps.length;
}
$("#nextStep")?.addEventListener("click", async () => {
  const required = accountSteps[accountStep].querySelectorAll("input[required],select[required]");
  for (const field of required) if (!field.reportValidity()) return;
  if (accountStep < accountSteps.length - 1) {
    accountStep++;
    showAccountStep();
    return;
  }
  const button = $("#nextStep");
  button.disabled = true;
  try {
    const request = await submitDemoRequest(
      "account_information",
      $("#preferredBranch").value,
      "Demo account enquiry: " + $("#accountType").value + "; funding range: " + $("#fundingRange").value
    );
    $("#referenceId").textContent = request.reference;
    $("#accountResult")?.classList.remove("hidden");
    $("#accountWizard")?.classList.add("hidden");
  } catch (error) {
    $("#accountMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("#prevStep")?.addEventListener("click", () => {
  if (accountStep > 0) {
    accountStep--;
    showAccountStep();
  }
});
if (accountSteps.length) showAccountStep();

$("#loanEnquiryForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.target.querySelector("button[type=submit]");
  const message = $("#loanEnquiryMessage");
  button.disabled = true;
  message.textContent = "Submitting demo enquiry…";
  try {
    const request = await submitDemoRequest(
      "loan_information",
      $("#loanBranch").value,
      "Demo loan enquiry: " + $("#loanCategory").value + "; amount range: " + $("#loanAmountBand").value
    );
    message.textContent = "Saved in MongoDB. Reference: " + request.reference;
    event.target.reset();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
