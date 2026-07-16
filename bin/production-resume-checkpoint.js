#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { check: pauseCheck } = require("./production-pause-checkpoint");
const { check: budgetCheck, policyTemplate } = require("./production-budget-gate");
const { REQUIRED_ENV, validateProductionEnv } = require("./validate-production-env");
const { DEFAULT_ENV_FILE } = require("./production-env");
const { base58Encode } = require("./run-solana-devnet");

const DEFAULT_POLICY = ".tascverifier/production-budget-policy.json";
const VERSION = "0.1";

function usage() {
  console.error([
    "Usage:",
    "  node bin/production-resume-checkpoint.js plan [options]",
    "  node bin/production-resume-checkpoint.js check [options]",
    "  node bin/production-resume-checkpoint.js --self-test",
    "",
    "Options:",
    "  --env <file>                              production env file; default .env.solana-mainnet.local",
    "  --policy <file>                           ignored budget policy file; default .tascverifier/production-budget-policy.json",
    "  --now <iso>                               budget validation timestamp; default now",
    "  --allow-test-rpc-host                     allow test-looking RPC hosts for self-tests only",
    "",
    "This checkpoint is read-only. It never accepts private keys, never calls RPC, never writes files, and never sends transactions.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requireValue(args, index, label) {
  const value = args[index] || "";
  if (!value) throw new Error(`${label} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {
    command: "check",
    envFile: DEFAULT_ENV_FILE,
    policy: DEFAULT_POLICY,
    now: "",
    allowTestRpcHost: false,
    selfTest: false,
  };
  const args = [...argv];
  if (["plan", "check"].includes(args[0])) options.command = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = requireValue(args, ++i, arg);
    else if (arg === "--policy") options.policy = requireValue(args, ++i, arg);
    else if (arg === "--now") options.now = requireValue(args, ++i, arg);
    else if (arg === "--allow-test-rpc-host") options.allowTestRpcHost = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  return options;
}

function commandPlan(envFile, policyFile) {
  return {
    no_spend_now: [
      `npm run real:pause -- --env ${envFile}`,
      `npm run real:budget -- --env ${envFile} --policy ${policyFile}`,
      `npm run real:env:validate -- --env ${envFile}`,
      `npm run real:packet:plan -- --env ${envFile}`,
      `npm run real:readiness:plan -- --env ${envFile}`,
    ],
    create_or_refresh_local_inputs: [
      `npm run real:env:init -- --env ${envFile}`,
      `npm run real:budget:plan -- --env ${envFile} --policy ${policyFile}`,
    ],
    spendful_after_explicit_unpause: [
      `npm run real:deploy:build -- --env ${envFile}`,
      `npm run real:token-account:build -- --env ${envFile}`,
      `npm run real:fund:build -- --env ${envFile}`,
      "npm run real:submitter:serve",
      `npm run real:lifecycle:build -- --env ${envFile}`,
      `npm run real:capture:record -- --transaction <artifact> --signature <sig>`,
      `npm run real:capture:payout -- --env ${envFile}`,
      `npm run real:packet:build -- --env ${envFile}`,
      `npm run real:readiness -- --env ${envFile}`,
    ],
  };
}

function spendfulPhases() {
  return [
    {
      phase: "mainnet-program-deploy",
      command: "npm run real:deploy:build, then deploy the reviewed artifact with a wallet/CLI",
      budget_action: "mainnet_program_deploy",
      cost_exposure: "SOL transaction fee and possible deploy/rent cost",
    },
    {
      phase: "buyer-worker-usdc-ata-setup",
      command: "npm run real:token-account:build, then submit missing ATA setup transactions",
      budget_action: "buyer_worker_usdc_ata_setup",
      cost_exposure: "SOL rent/fees if associated token accounts are missing",
    },
    {
      phase: "fund-10-usdc-task",
      command: "npm run real:fund:build, then submit through npm run real:submitter:serve",
      budget_action: "fund_10_usdc_task",
      cost_exposure: "10 USDC principal plus SOL fees/rent",
    },
    {
      phase: "claim-attest-release-wallet-sends",
      command: "npm run real:lifecycle:build, then submit claim, attest, and release wallet sends",
      budget_action: "claim_attest_release_wallet_sends",
      cost_exposure: "SOL fees for worker/verifier role wallets",
    },
  ].map((phase) => ({ ...phase, explicit_unpause_required: true }));
}

function plan(options = {}) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const policyFile = options.policy || DEFAULT_POLICY;
  return {
    ok: true,
    kind: "tasc.production_resume_checkpoint.plan",
    version: VERSION,
    goal: "restart the real-money path from a no-spend pause checkpoint without accidentally sending mainnet transactions",
    final_success_rule: "Only complete the goal after real:readiness returns ready_for_goal true with non-example mainnet evidence and live RPC verification for a 10 USDC payout under 60 seconds.",
    default_env_file: envFile,
    default_policy_file: policyFile,
    ready_for_goal: false,
    safe_to_resume_spend_work: false,
    explicit_unpause_required_for_spend: true,
    sends_transactions: false,
    calls_rpc: false,
    writes_files: false,
    accepts_private_keys: false,
    key_material_printed: false,
    no_new_dependencies: true,
    budget_policy_template: policyTemplate(options.now || "2026-01-01T00:00:00.000Z"),
    commands: commandPlan(envFile, policyFile),
    spendful_phases_after_unpause: spendfulPhases(),
  };
}

function summarizeBlockers(section, blockers) {
  return blockers.map((blocker) => `${section}: ${blocker}`);
}

function check(options = {}, processEnv = process.env) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const policyFile = options.policy || DEFAULT_POLICY;
  const pause = pauseCheck({ ...options, envFile });
  const budget = budgetCheck({ ...options, envFile, policy: policyFile, now: options.now });
  const env = validateProductionEnv({
    envFile,
    command: "validate",
    allowTestRpcHost: options.allowTestRpcHost === true,
  }, processEnv);
  const blockers = [
    ...summarizeBlockers("pause", pause.blockers || []),
    ...summarizeBlockers("budget", budget.blockers || []),
    ...summarizeBlockers("env", env.blockers || []),
  ];
  const safeToResumeSpendWork = Boolean(
    pause.safe_to_resume_no_spend_work
      && budget.safe_to_resume_spend_work
      && env.ready_for_preflight,
  );

  return {
    ok: true,
    kind: "tasc.production_resume_checkpoint",
    version: VERSION,
    generated_at: new Date().toISOString(),
    goal: "make $10 in less than a minute",
    ready_for_goal: false,
    checkpoint_status: safeToResumeSpendWork ? "ready_for_explicit_unpause" : "paused_or_missing_resume_inputs",
    paused: !safeToResumeSpendWork,
    safe_to_resume_no_spend_work: Boolean(pause.safe_to_resume_no_spend_work),
    safe_to_resume_spend_work: safeToResumeSpendWork,
    explicit_unpause_required_for_spend: true,
    completion_rule: "Do not mark complete until live mainnet readiness proves a real 10 USDC payout under 60 seconds.",
    env: {
      env_file: env.env_file,
      env_file_exists: env.env_file_exists,
      ready_for_preflight: env.ready_for_preflight,
      required_env_set: env.required_env.filter((item) => item.set).map((item) => item.key),
      required_env_missing: env.required_env.filter((item) => !item.set).map((item) => item.key),
      rpc_host: env.rpc_host,
      rpc_url_printed: false,
      full_rpc_url_persisted: false,
    },
    pause_checkpoint: {
      checkpoint_status: pause.checkpoint_status,
      safe_to_resume_no_spend_work: pause.safe_to_resume_no_spend_work,
      spendful_evidence_count: pause.spendful_evidence.length,
      blockers: pause.blockers,
    },
    budget_gate: {
      policy_file: budget.policy_file,
      policy_exists: budget.policy_exists,
      spend_resume_budget_approved: budget.spend_resume_budget_approved,
      safe_to_resume_spend_work: budget.safe_to_resume_spend_work,
      allowed_actions: budget.policy_validation ? budget.policy_validation.allowed_actions : [],
      blockers: budget.blockers,
    },
    blockers,
    next_commands: commandPlan(envFile, policyFile),
    spendful_phases_after_unpause: spendfulPhases(),
    sends_transactions: false,
    calls_rpc: false,
    writes_files: false,
    accepts_private_keys: false,
    key_material_printed: false,
    rpc_url_printed: false,
    full_rpc_url_persisted: false,
    no_new_dependencies: true,
  };
}

function writeEnvFile(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sampleAddress(byte) {
  return base58Encode(Buffer.alloc(32, byte));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasc-production-resume-"));
  const envFile = path.join(dir, ".env.solana-mainnet.local");
  const policy = path.join(dir, "budget-policy.json");
  const artifactPaths = selfTestArtifactPaths(dir);
  const now = "2026-01-01T00:00:00.000Z";
  try {
    const planResult = plan({ envFile, policy, now });
    assert(planResult.sends_transactions === false, "plan must not send transactions");
    assert(planResult.calls_rpc === false, "plan must not call RPC");
    assert(planResult.writes_files === false, "plan must not write files");

    const missing = check({ envFile, policy, now, ...artifactPaths }, {});
    assert(missing.safe_to_resume_spend_work === false, "missing inputs must block spend resume");
    assert(missing.blockers.some((item) => item.includes("budget policy file")), "missing policy blocker expected");
    assert(missing.blockers.some((item) => item.includes(REQUIRED_ENV.rpcUrl)), "missing env blocker expected");

    writeEnvFile(envFile, {
      [REQUIRED_ENV.rpcUrl]: "https://mainnet.solana-rpc.invalid/rpc?token=secret",
      [REQUIRED_ENV.expectedGenesisHash]: sampleAddress(1),
      [REQUIRED_ENV.programId]: sampleAddress(2),
      [REQUIRED_ENV.usdcMint]: sampleAddress(3),
      [REQUIRED_ENV.buyer]: sampleAddress(4),
      [REQUIRED_ENV.worker]: sampleAddress(5),
      [REQUIRED_ENV.verifier]: sampleAddress(6),
      [REQUIRED_ENV.buyerUsdc]: sampleAddress(7),
      [REQUIRED_ENV.workerUsdc]: sampleAddress(8),
    });
    writeJson(policy, {
      ...policyTemplate(now),
      allow: {
        mainnet_program_deploy: true,
        buyer_worker_usdc_ata_setup: true,
        fund_10_usdc_task: true,
        claim_attest_release_wallet_sends: true,
      },
    });
    const ready = check({ envFile, policy, now, ...artifactPaths }, {});
    assert(ready.safe_to_resume_spend_work === true, "valid env and policy should clear resume gate");
    assert(ready.explicit_unpause_required_for_spend === true, "operator unpause must still be required");
    assert(JSON.stringify(ready).includes("secret") === false, "resume checkpoint must not print RPC credentials");

    writeJson(policy, {
      ...policyTemplate(now),
      expires_at: "2025-12-31T00:00:00.000Z",
      allow: { fund_10_usdc_task: true },
    });
    const expired = check({ envFile, policy, now, ...artifactPaths }, {});
    assert(expired.safe_to_resume_spend_work === false, "expired budget policy must block spend resume");
    assert(expired.blockers.some((item) => item.includes("expired")), "expired budget blocker expected");

    writeEnvFile(envFile, {
      [REQUIRED_ENV.rpcUrl]: "https://api.devnet.solana.com",
      [REQUIRED_ENV.expectedGenesisHash]: sampleAddress(1),
      [REQUIRED_ENV.programId]: sampleAddress(2),
      [REQUIRED_ENV.usdcMint]: sampleAddress(3),
      [REQUIRED_ENV.buyer]: sampleAddress(4),
      [REQUIRED_ENV.worker]: sampleAddress(5),
      [REQUIRED_ENV.verifier]: sampleAddress(6),
      [REQUIRED_ENV.buyerUsdc]: sampleAddress(7),
      [REQUIRED_ENV.workerUsdc]: sampleAddress(8),
    });
    const devnet = check({ envFile, policy, now, ...artifactPaths }, {});
    assert(devnet.safe_to_resume_spend_work === false, "devnet-looking RPC must block spend resume");
    assert(devnet.blockers.some((item) => item.includes("devnet")), "devnet blocker expected");

    return {
      ok: true,
      self_test: true,
      plan_safe: true,
      missing_inputs_blocked: missing.safe_to_resume_spend_work === false,
      valid_inputs_clear_resume_gate: ready.safe_to_resume_spend_work === true,
      explicit_unpause_still_required: ready.explicit_unpause_required_for_spend === true,
      expired_budget_blocked: expired.safe_to_resume_spend_work === false,
      devnet_rpc_blocked: devnet.safe_to_resume_spend_work === false,
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
    console.error(`production-resume-checkpoint: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  check,
  plan,
  selfTest,
};
