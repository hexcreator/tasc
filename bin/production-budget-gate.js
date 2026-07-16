#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { check: pauseCheck } = require("./production-pause-checkpoint");
const { DEFAULT_ENV_FILE } = require("./production-env");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_POLICY = ".tascverifier/production-budget-policy.json";
const PRIVATE_KEY_RE = /(PRIVATE_KEY|SECRET_KEY|KEYPAIR|MNEMONIC|SEED_PHRASE)/i;
const ACTIONS = [
  "mainnet_program_deploy",
  "buyer_worker_usdc_ata_setup",
  "fund_10_usdc_task",
  "claim_attest_release_wallet_sends",
];

function usage() {
  console.error([
    "Usage:",
    "  node bin/production-budget-gate.js plan [options]",
    "  node bin/production-budget-gate.js check [options]",
    "  node bin/production-budget-gate.js --self-test",
    "",
    "Options:",
    "  --env <file>                              production env file; default .env.solana-mainnet.local",
    "  --policy <file>                           ignored budget policy file; default .tascverifier/production-budget-policy.json",
    "  --now <iso>                               validation timestamp; default now",
    "",
    "This budget gate is read-only. It never accepts private keys, never calls RPC, never writes files, and never sends transactions.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    command: "check",
    envFile: DEFAULT_ENV_FILE,
    policy: DEFAULT_POLICY,
    now: "",
    selfTest: false,
  };
  const args = [...argv];
  if (["plan", "check"].includes(args[0])) options.command = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = requireValue(args, ++i, arg);
    else if (arg === "--policy") options.policy = requireValue(args, ++i, arg);
    else if (arg === "--now") options.now = requireValue(args, ++i, arg);
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  return options;
}

function requireValue(args, index, label) {
  const value = args[index] || "";
  if (!value) throw new Error(`${label} requires a value`);
  return value;
}

function rel(file) {
  if (!file) return "";
  return path.relative(ROOT, path.resolve(file));
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertIso(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} is required`);
  assert(Number.isFinite(Date.parse(value)), `${label} must be an ISO timestamp`);
  return value;
}

function usdCents(value, label) {
  const text = String(value ?? "");
  assert(/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(text), `${label} must be a USD decimal string`);
  const [dollars, cents = ""] = text.split(".");
  return (BigInt(dollars) * 100n) + BigInt(cents.padEnd(2, "0"));
}

function formatUsd(cents) {
  const value = BigInt(cents);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

function privateLikePaths(value, prefix = "") {
  if (!value || typeof value !== "object") return [];
  const out = [];
  for (const [key, child] of Object.entries(value)) {
    const current = prefix ? `${prefix}.${key}` : key;
    if (PRIVATE_KEY_RE.test(key)) out.push(current);
    if (child && typeof child === "object") out.push(...privateLikePaths(child, current));
  }
  return out;
}

function normalizedAllow(input) {
  const allow = input && typeof input === "object" ? input : {};
  const out = {};
  for (const action of ACTIONS) out[action] = allow[action] === true;
  return out;
}

function validatePolicy(policy, options = {}) {
  assert(policy && typeof policy === "object", "budget policy must be a JSON object");
  assert(policy.kind === "tasc.production_budget.policy", "budget policy kind mismatch");
  assert(policy.version === "0.1", "budget policy version mismatch");
  assert(policy.goal === "make $10 in less than a minute", "budget policy goal mismatch");
  assertIso(policy.created_at, "created_at");
  assertIso(policy.expires_at, "expires_at");
  const now = assertIso(options.now || new Date().toISOString(), "now");
  const expired = Date.parse(policy.expires_at) <= Date.parse(now);
  const privatePaths = privateLikePaths(policy);
  const total = usdCents(policy.max_total_usd, "max_total_usd");
  const usdcPrincipal = usdCents(policy.max_usdc_principal, "max_usdc_principal");
  const solFees = usdCents(policy.max_sol_fees_usd, "max_sol_fees_usd");
  const rpcCredits = usdCents(policy.max_rpc_credits_usd, "max_rpc_credits_usd");
  const allow = normalizedAllow(policy.allow);
  const allowedActions = ACTIONS.filter((action) => allow[action]);
  const blockers = [];
  if (privatePaths.length > 0) blockers.push(`budget policy contains private-key-like keys: ${privatePaths.join(", ")}`);
  if (expired) blockers.push("budget policy is expired");
  if (total < (usdcPrincipal + solFees + rpcCredits)) {
    blockers.push("max_total_usd is below the sum of sub-budgets");
  }
  if (allow.fund_10_usdc_task && usdcPrincipal < 1000n) {
    blockers.push("fund_10_usdc_task requires max_usdc_principal >= 10.00");
  }
  if (allowedActions.length === 0) blockers.push("budget policy does not allow any spendful actions");
  return {
    ok: blockers.length === 0,
    kind: "tasc.production_budget.policy.validation",
    version: "0.1",
    expired,
    created_at: policy.created_at,
    expires_at: policy.expires_at,
    max_total_usd: formatUsd(total),
    max_usdc_principal: formatUsd(usdcPrincipal),
    max_sol_fees_usd: formatUsd(solFees),
    max_rpc_credits_usd: formatUsd(rpcCredits),
    allowed_actions: allowedActions,
    disallowed_actions: ACTIONS.filter((action) => !allow[action]),
    blockers,
    sends_transactions: false,
    calls_rpc: false,
    writes_files: false,
    accepts_private_keys: false,
    no_new_dependencies: true,
  };
}

function policyTemplate(now = new Date().toISOString()) {
  const created = assertIso(now, "now");
  const expires = new Date(Date.parse(created) + 24 * 60 * 60 * 1000).toISOString();
  return {
    kind: "tasc.production_budget.policy",
    version: "0.1",
    goal: "make $10 in less than a minute",
    created_at: created,
    expires_at: expires,
    max_total_usd: "15.00",
    max_usdc_principal: "10.00",
    max_sol_fees_usd: "5.00",
    max_rpc_credits_usd: "0.00",
    allow: {
      mainnet_program_deploy: false,
      buyer_worker_usdc_ata_setup: false,
      fund_10_usdc_task: false,
      claim_attest_release_wallet_sends: false,
    },
    note: "Set only the spend phases you explicitly approve to true before resuming.",
  };
}

function plan(options = {}) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const policyFile = options.policy || DEFAULT_POLICY;
  return {
    ok: true,
    kind: "tasc.production_budget_gate.plan",
    version: "0.1",
    goal: "define a local budget gate before any mainnet deploy, setup, funding, or wallet-send step resumes",
    default_env_file: envFile,
    default_policy_file: policyFile,
    ready_for_goal: false,
    sends_transactions: false,
    calls_rpc: false,
    writes_files: false,
    accepts_private_keys: false,
    key_material_printed: false,
    no_new_dependencies: true,
    template: policyTemplate(options.now || "2026-01-01T00:00:00.000Z"),
    commands: {
      pause_check: `npm run real:pause -- --env ${envFile}`,
      budget_check: `npm run real:budget -- --env ${envFile} --policy ${policyFile}`,
      readiness_plan: `npm run real:readiness:plan -- --env ${envFile}`,
    },
    notes: [
      "This does not estimate live Solana rent or fee markets; it validates operator-defined caps.",
      "A valid budget policy is not proof of payout and does not mark the goal complete.",
      "Wallet prompts and any mainnet transaction still require explicit operator action.",
    ],
  };
}

function check(options = {}) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const policyFile = path.resolve(options.policy || DEFAULT_POLICY);
  const pause = pauseCheck({ ...options, envFile });
  const result = {
    ok: true,
    kind: "tasc.production_budget_gate",
    version: "0.1",
    generated_at: new Date().toISOString(),
    goal: "make $10 in less than a minute",
    ready_for_goal: false,
    policy_file: rel(policyFile),
    policy_exists: fs.existsSync(policyFile),
    policy_validation: null,
    pause_checkpoint: {
      checkpoint_status: pause.checkpoint_status,
      safe_to_resume_no_spend_work: pause.safe_to_resume_no_spend_work,
      spendful_evidence_count: pause.spendful_evidence.length,
      blockers: pause.blockers,
    },
    spend_resume_budget_approved: false,
    safe_to_resume_spend_work: false,
    still_requires_wallet_confirmation: true,
    explicit_unpause_required_for_spend: true,
    blockers: [],
    sends_transactions: false,
    calls_rpc: false,
    writes_files: false,
    accepts_private_keys: false,
    key_material_printed: false,
    rpc_url_printed: false,
    full_rpc_url_persisted: false,
    no_new_dependencies: true,
  };

  if (!result.policy_exists) {
    result.blockers.push("budget policy file is required before spendful resume");
    return result;
  }

  try {
    result.policy_validation = validatePolicy(loadJson(policyFile), options);
    result.blockers.push(...result.policy_validation.blockers);
  } catch (error) {
    result.blockers.push(error.message);
  }

  if (!pause.safe_to_resume_no_spend_work) {
    result.blockers.push("pause checkpoint has blockers");
  }
  if (pause.spendful_evidence.length > 0) {
    result.blockers.push("canonical spend evidence exists; audit it before resuming");
  }

  result.spend_resume_budget_approved = Boolean(
    result.policy_validation
      && result.policy_validation.ok
      && pause.safe_to_resume_no_spend_work
      && pause.spendful_evidence.length === 0,
  );
  result.safe_to_resume_spend_work = result.spend_resume_budget_approved;
  return result;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function selfTestArtifactPaths(dir) {
  const names = {
    deployHandoff: "missing-deploy.json",
    signedIntent: "missing-intent.json",
    buyerTokenSetup: "missing-buyer-ata.json",
    workerTokenSetup: "missing-worker-ata.json",
    fundTransaction: "missing-fund.json",
    claimTransaction: "missing-claim.json",
    attestTransaction: "missing-attest.json",
    releaseTransaction: "missing-release.json",
    capture: "missing-capture.json",
    payout: "missing-payout.json",
    packet: "missing-packet.json",
  };
  return Object.fromEntries(Object.entries(names).map(([key, file]) => [key, path.join(dir, file)]));
}

async function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasc-production-budget-gate-"));
  const envFile = path.join(dir, ".env.solana-mainnet.local");
  const policy = path.join(dir, "budget-policy.json");
  const artifactPaths = selfTestArtifactPaths(dir);
  const now = "2026-01-01T00:00:00.000Z";

  try {
    const planResult = plan({ envFile, policy, now });
    assert(planResult.sends_transactions === false, "plan must not send transactions");
    assert(planResult.calls_rpc === false, "plan must not call RPC");
    assert(planResult.writes_files === false, "plan must not write files");

    const missing = check({ envFile, policy, now, ...artifactPaths });
    assert(missing.spend_resume_budget_approved === false, "missing policy should not approve spend");
    assert(missing.blockers.some((item) => item.includes("budget policy file")), "missing policy blocker expected");

    writeJson(policy, {
      ...policyTemplate(now),
      allow: {
        mainnet_program_deploy: false,
        buyer_worker_usdc_ata_setup: false,
        fund_10_usdc_task: true,
        claim_attest_release_wallet_sends: true,
      },
    });
    const valid = check({ envFile, policy, now, ...artifactPaths });
    assert(valid.spend_resume_budget_approved === true, "valid policy should approve budget gate");
    assert(valid.safe_to_resume_spend_work === true, "valid policy should be safe to resume spend work");

    writeJson(policy, {
      ...policyTemplate(now),
      expires_at: "2025-12-31T00:00:00.000Z",
      allow: { fund_10_usdc_task: true },
    });
    const expired = check({ envFile, policy, now, ...artifactPaths });
    assert(expired.spend_resume_budget_approved === false, "expired policy should not approve spend");
    assert(expired.blockers.some((item) => item.includes("expired")), "expired blocker expected");

    writeJson(policy, {
      ...policyTemplate(now),
      max_total_usd: "9.99",
      max_usdc_principal: "9.99",
      max_sol_fees_usd: "0.00",
      max_rpc_credits_usd: "0.00",
      allow: { fund_10_usdc_task: true },
    });
    const underfunded = check({ envFile, policy, now, ...artifactPaths });
    assert(underfunded.spend_resume_budget_approved === false, "under-budget policy should not approve spend");
    assert(underfunded.blockers.some((item) => item.includes("10.00")), "under-budget blocker expected");

    writeJson(policy, {
      ...policyTemplate(now),
      operator_private_key: "do-not-store",
      allow: { fund_10_usdc_task: true },
    });
    const privatePolicy = check({ envFile, policy, now, ...artifactPaths });
    assert(privatePolicy.spend_resume_budget_approved === false, "private-like policy should not approve spend");
    assert(privatePolicy.blockers.some((item) => item.includes("private-key-like")), "private-like blocker expected");

    return {
      ok: true,
      self_test: true,
      plan_safe: true,
      missing_policy_blocked: missing.spend_resume_budget_approved === false,
      valid_policy_approved: valid.spend_resume_budget_approved === true,
      expired_policy_blocked: expired.spend_resume_budget_approved === false,
      under_budget_blocked: underfunded.spend_resume_budget_approved === false,
      private_policy_rejected: privatePolicy.spend_resume_budget_approved === false,
      sends_transactions: false,
      calls_rpc: false,
      writes_files: false,
      accepts_private_keys: false,
      no_new_dependencies: true,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    process.stdout.write(`${JSON.stringify(await selfTest(), null, 2)}\n`);
    return;
  }
  if (options.command === "plan") {
    process.stdout.write(`${JSON.stringify(plan(options), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(check(options), null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`production-budget-gate: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  check,
  plan,
  policyTemplate,
  selfTest,
  validatePolicy,
};
