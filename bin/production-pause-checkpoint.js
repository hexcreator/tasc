#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { validateHandoff: validateProductionDeployHandoff } = require("./build-production-deploy-handoff");
const { validateArtifact: validateProductionTokenAccountSetup } = require("./build-production-token-account-setup");
const { validateArtifact: validateProductionFundTransaction } = require("./build-production-fund-transaction");
const { validateArtifact: validateProductionLifecycleTransaction } = require("./build-production-lifecycle-transaction");
const { validateCapture } = require("./record-production-run-capture");
const { validatePacket: validateProductionRunPacket } = require("./build-production-run-packet");
const { validateProductionPayout } = require("./validate-real-money-readiness");
const { verifySignedSolanaIntent } = require("./tascsolana");
const { base58Encode } = require("./run-solana-devnet");
const {
  DEFAULT_ENV_FILE,
  PRODUCTION_ENV,
  envMetadata,
  loadEnvFile,
} = require("./production-env");

const ROOT = path.resolve(__dirname, "..");
const PRIVATE_KEY_RE = /(PRIVATE_KEY|SECRET_KEY|KEYPAIR|MNEMONIC|SEED_PHRASE)/i;
const DEFAULT_PATHS = {
  deployHandoff: ".tascverifier/production-deploy-handoff.json",
  signedIntent: ".tascverifier/production-intent/production-intent.signature.json",
  buyerTokenSetup: ".tascverifier/production-token-account-setup-buyer.json",
  workerTokenSetup: ".tascverifier/production-token-account-setup-worker.json",
  fundTransaction: ".tascverifier/production-fund-transaction.json",
  claimTransaction: ".tascverifier/production-lifecycle-claim.json",
  attestTransaction: ".tascverifier/production-lifecycle-attest.json",
  releaseTransaction: ".tascverifier/production-lifecycle-release.json",
  capture: ".tascverifier/production-run-capture.json",
  payout: ".tascverifier/production-payout-evidence.json",
  packet: ".tascverifier/production-run-packet.json",
};

function usage() {
  console.error([
    "Usage:",
    "  node bin/production-pause-checkpoint.js plan [options]",
    "  node bin/production-pause-checkpoint.js check [options]",
    "  node bin/production-pause-checkpoint.js --self-test",
    "",
    "Options:",
    "  --env <file>                              production env file; default .env.solana-mainnet.local",
    "  --deploy-handoff <file>                   production deploy handoff path",
    "  --signed-intent <file>                    signed production intent path",
    "  --buyer-token-setup <file>                buyer USDC ATA setup artifact path",
    "  --worker-token-setup <file>               worker USDC ATA setup artifact path",
    "  --fund-transaction <file>                 production fund transaction artifact path",
    "  --claim-transaction <file>                production claim transaction artifact path",
    "  --attest-transaction <file>               production attest transaction artifact path",
    "  --release-transaction <file>              production release transaction artifact path",
    "  --capture <file>                          production run capture path",
    "  --payout <file>                           production payout evidence path",
    "  --packet <file>                           production run packet path",
    "",
    "This checkpoint is read-only. It never accepts private keys, never calls RPC, never writes files, and never sends transactions.",
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
    ...DEFAULT_PATHS,
    selfTest: false,
  };
  const args = [...argv];
  if (["plan", "check"].includes(args[0])) options.command = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = requireValue(args, ++i, arg);
    else if (arg === "--deploy-handoff") options.deployHandoff = requireValue(args, ++i, arg);
    else if (arg === "--signed-intent") options.signedIntent = requireValue(args, ++i, arg);
    else if (arg === "--buyer-token-setup") options.buyerTokenSetup = requireValue(args, ++i, arg);
    else if (arg === "--worker-token-setup") options.workerTokenSetup = requireValue(args, ++i, arg);
    else if (arg === "--fund-transaction") options.fundTransaction = requireValue(args, ++i, arg);
    else if (arg === "--claim-transaction") options.claimTransaction = requireValue(args, ++i, arg);
    else if (arg === "--attest-transaction") options.attestTransaction = requireValue(args, ++i, arg);
    else if (arg === "--release-transaction") options.releaseTransaction = requireValue(args, ++i, arg);
    else if (arg === "--capture") options.capture = requireValue(args, ++i, arg);
    else if (arg === "--payout") options.payout = requireValue(args, ++i, arg);
    else if (arg === "--packet") options.packet = requireValue(args, ++i, arg);
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

function privateEnvKeys(envFile) {
  if (!fs.existsSync(envFile)) return [];
  return Object.keys(loadEnvFile(envFile)).filter((key) => PRIVATE_KEY_RE.test(key)).sort();
}

function signedIntentValidation(payload) {
  const verified = verifySignedSolanaIntent(payload);
  assert(verified.ok === true, "signed production intent signature is invalid");
  assert(payload.intent && payload.intent.message && payload.intent.message.cluster === "solana-mainnet-beta", "signed intent must target solana-mainnet-beta");
  assert(payload.intent.message.amount === "10000000", "signed intent amount must be exactly 10000000");
  return {
    ok: true,
    kind: "tasc.production_signed_intent.validation",
    signer: verified.signer,
  };
}

function artifactHasCaptureSignatures(payload) {
  const signatures = payload && payload.signatures || {};
  return ["fund", "claim", "attest", "release"].some((name) => Boolean(signatures[name]));
}

function artifactHasRealPayout(payload) {
  return Boolean(
    payload
      && payload.kind === "tasc.production_payout.evidence"
      && payload.real_money === true
      && payload.example_only !== true,
  );
}

function inspectArtifact(definition) {
  const file = path.resolve(definition.file);
  const status = {
    name: definition.name,
    file: rel(file),
    exists: fs.existsSync(file),
    kind: null,
    valid: false,
    spendful_evidence: false,
    error: null,
  };
  if (!status.exists) return status;
  try {
    const payload = loadJson(file);
    status.kind = payload.kind || null;
    if (definition.validate) definition.validate(payload);
    status.valid = true;
    if (definition.spendfulEvidence) status.spendful_evidence = Boolean(definition.spendfulEvidence(payload));
  } catch (error) {
    status.error = error.message;
  }
  return status;
}

function artifactDefinitions(options) {
  return [
    {
      name: "production_deploy_handoff",
      file: options.deployHandoff,
      validate: validateProductionDeployHandoff,
    },
    {
      name: "signed_production_intent",
      file: options.signedIntent,
      validate: signedIntentValidation,
    },
    {
      name: "buyer_usdc_ata_setup",
      file: options.buyerTokenSetup,
      validate: validateProductionTokenAccountSetup,
    },
    {
      name: "worker_usdc_ata_setup",
      file: options.workerTokenSetup,
      validate: validateProductionTokenAccountSetup,
    },
    {
      name: "production_fund_transaction",
      file: options.fundTransaction,
      validate: validateProductionFundTransaction,
    },
    {
      name: "production_claim_transaction",
      file: options.claimTransaction,
      validate: validateProductionLifecycleTransaction,
    },
    {
      name: "production_attest_transaction",
      file: options.attestTransaction,
      validate: validateProductionLifecycleTransaction,
    },
    {
      name: "production_release_transaction",
      file: options.releaseTransaction,
      validate: validateProductionLifecycleTransaction,
    },
    {
      name: "production_run_capture",
      file: options.capture,
      validate: (payload) => validateCapture(payload, { requireComplete: false }),
      spendfulEvidence: artifactHasCaptureSignatures,
    },
    {
      name: "production_payout_evidence",
      file: options.payout,
      validate: (payload) => validateProductionPayout(payload),
      spendfulEvidence: artifactHasRealPayout,
    },
    {
      name: "production_run_packet",
      file: options.packet,
      validate: validateProductionRunPacket,
      spendfulEvidence: (payload) => payload && payload.ready_for_goal === true,
    },
  ];
}

function remainingSpendfulActions() {
  return [
    {
      phase: "mainnet-program-deploy",
      cost_exposure: "SOL transaction fee and possible deploy/rent cost",
      approval_required: true,
    },
    {
      phase: "buyer-worker-usdc-ata-setup",
      cost_exposure: "SOL rent/fees if associated token accounts are missing",
      approval_required: true,
    },
    {
      phase: "fund-10-usdc-task",
      cost_exposure: "10 USDC principal plus SOL fees/rent",
      approval_required: true,
    },
    {
      phase: "claim-attest-release-wallet-sends",
      cost_exposure: "SOL fees for worker/verifier role wallets",
      approval_required: true,
    },
  ];
}

function plan(options = {}) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  return {
    ok: true,
    kind: "tasc.production_pause_checkpoint.plan",
    version: "0.1",
    goal: "pause the real-money path at a no-spend checkpoint while preserving the route to a verified 10 USDC under-60s payout",
    default_env_file: envFile,
    default_artifact_paths: { ...DEFAULT_PATHS },
    paused_goal_remains: "make $10 in less than a minute",
    ready_for_goal: false,
    sends_transactions: false,
    calls_rpc: false,
    writes_files: false,
    accepts_private_keys: false,
    key_material_printed: false,
    no_new_dependencies: true,
    no_spend_resume_commands: {
      pause_check: `npm run real:pause -- --env ${envFile}`,
      budget_check: `npm run real:budget -- --env ${envFile}`,
      env_validate: `npm run real:env:validate -- --env ${envFile}`,
      preflight_plan: `npm run real:preflight:plan -- --env ${envFile}`,
      packet_plan: `npm run real:packet:plan -- --env ${envFile}`,
      readiness_plan: `npm run real:readiness:plan -- --env ${envFile}`,
    },
    spendful_actions_require_explicit_unpause: remainingSpendfulActions(),
    completion_rule: "Do not call the goal complete until real:readiness returns ready_for_goal true with non-example mainnet evidence and live RPC verification.",
  };
}

function check(options = {}) {
  options = { ...DEFAULT_PATHS, ...options };
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const envKeys = [
    PRODUCTION_ENV.rpcUrl,
    PRODUCTION_ENV.expectedGenesisHash,
    PRODUCTION_ENV.programId,
    PRODUCTION_ENV.tokenMint,
    PRODUCTION_ENV.buyer,
    PRODUCTION_ENV.worker,
    PRODUCTION_ENV.verifier,
    PRODUCTION_ENV.buyerUsdc,
    PRODUCTION_ENV.workerUsdc,
  ];
  const artifacts = artifactDefinitions(options).map(inspectArtifact);
  const privateKeys = privateEnvKeys(envFile);
  const invalidArtifacts = artifacts.filter((artifact) => artifact.exists && !artifact.valid);
  const spendfulEvidence = artifacts.filter((artifact) => artifact.spendful_evidence);
  const blockers = [];
  if (privateKeys.length > 0) {
    blockers.push(`production env contains private-key-like entries: ${privateKeys.join(", ")}`);
  }
  if (invalidArtifacts.length > 0) {
    blockers.push(`canonical artifacts need review: ${invalidArtifacts.map((item) => item.name).join(", ")}`);
  }

  return {
    ok: true,
    kind: "tasc.production_pause_checkpoint",
    version: "0.1",
    generated_at: new Date().toISOString(),
    goal: "make $10 in less than a minute",
    paused: true,
    ready_for_goal: false,
    checkpoint_status: spendfulEvidence.length > 0 ? "spend_evidence_present_audit_before_resume" : "paused_before_mainnet_spend",
    safe_to_resume_no_spend_work: blockers.length === 0,
    safe_to_resume_spend_work: false,
    explicit_unpause_required_for_spend: true,
    env: {
      ...envMetadata(envFile, envKeys),
      private_key_like_entries: privateKeys,
      values_printed: false,
    },
    artifacts,
    spendful_evidence: spendfulEvidence.map((artifact) => ({
      name: artifact.name,
      file: artifact.file,
      kind: artifact.kind,
    })),
    blockers,
    no_spend_next_commands: [
      `npm run real:pause -- --env ${envFile}`,
      `npm run real:budget -- --env ${envFile}`,
      `npm run real:env:validate -- --env ${envFile}`,
      `npm run real:packet:plan -- --env ${envFile}`,
      `npm run real:readiness:plan -- --env ${envFile}`,
    ],
    spendful_actions_require_explicit_unpause: remainingSpendfulActions(),
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

function sampleSignature(byte) {
  return base58Encode(Buffer.alloc(64, byte));
}

function sampleCapture(signature = "") {
  return {
    kind: "tasc.production_run.capture",
    version: "0.1",
    generated_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    goal: "make $10 in less than a minute",
    network: {
      chain: "solana",
      cluster: "solana-mainnet-beta",
      network_type: "mainnet",
    },
    signed_intent: null,
    role_accounts: {
      worker: "",
      destination_token_account: "",
    },
    settlement_inputs: {
      result_hash: "",
      task_account: "",
      vault_token_account: "",
    },
    signatures: {
      fund: signature,
      claim: "",
      attest: "",
      release: "",
    },
    timing: {
      target_ms: 60000,
      claim_started_at: "",
      release_confirmed_at: "",
      completed_indexed_at: "",
      claim_to_release_ms: null,
      claim_to_completed_index_ms: null,
    },
    balances: {
      vault_balance_after: "",
      destination_balance_after: "",
    },
    source: {
      sends_transactions: false,
      accepts_private_keys: false,
      no_new_dependencies: true,
    },
  };
}

function selfTestOptions(dir) {
  const names = {
    deployHandoff: "missing-deploy.json",
    signedIntent: "missing-intent.json",
    buyerTokenSetup: "missing-buyer-ata.json",
    workerTokenSetup: "missing-worker-ata.json",
    fundTransaction: "missing-fund.json",
    claimTransaction: "missing-claim.json",
    attestTransaction: "missing-attest.json",
    releaseTransaction: "missing-release.json",
    capture: "capture.json",
    payout: "missing-payout.json",
    packet: "missing-packet.json",
  };
  return Object.fromEntries(Object.entries(names).map(([key, file]) => [key, path.join(dir, file)]));
}

async function selfTest() {
  fs.mkdirSync(path.join(ROOT, ".tascverifier"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, ".tascverifier", "production-pause-checkpoint-"));
  const envFile = path.join(dir, ".env.solana-mainnet.local");
  const options = {
    envFile,
    ...selfTestOptions(dir),
  };

  const planResult = plan({ envFile });
  assert(planResult.sends_transactions === false, "plan must not send transactions");
  assert(planResult.calls_rpc === false, "plan must not call RPC");
  assert(planResult.writes_files === false, "plan must not write files");

  fs.writeFileSync(options.capture, `${JSON.stringify(sampleCapture(), null, 2)}\n`);
  const paused = check(options);
  assert(paused.checkpoint_status === "paused_before_mainnet_spend", "empty capture should be pre-spend pause");
  assert(paused.safe_to_resume_no_spend_work === true, "empty capture should be safe for no-spend work");
  assert(paused.spendful_evidence.length === 0, "empty capture should not be spend evidence");
  assert(paused.sends_transactions === false, "check must not send transactions");
  assert(paused.calls_rpc === false, "check must not call RPC");
  assert(paused.writes_files === false, "check must not write files");

  fs.writeFileSync(options.capture, `${JSON.stringify(sampleCapture(sampleSignature(8)), null, 2)}\n`);
  const spent = check(options);
  assert(spent.checkpoint_status === "spend_evidence_present_audit_before_resume", "signature capture should be spend evidence");
  assert(spent.spendful_evidence.some((item) => item.name === "production_run_capture"), "capture spend evidence missing");

  fs.writeFileSync(envFile, "GLOBAL_TASC_SOLANA_MAINNET_BUYER_PRIVATE_KEY=do-not-store\n");
  const privateEnv = check(options);
  assert(privateEnv.safe_to_resume_no_spend_work === false, "private-key-like env should block no-spend resume");
  assert(privateEnv.blockers.some((item) => item.includes("PRIVATE_KEY")), "private-key-like env blocker missing");

  return {
    ok: true,
    self_test: true,
    plan_safe: true,
    paused_before_spend: paused.checkpoint_status === "paused_before_mainnet_spend",
    spend_evidence_detected: spent.spendful_evidence.length > 0,
    private_env_rejected: privateEnv.safe_to_resume_no_spend_work === false,
    sends_transactions: false,
    calls_rpc: false,
    writes_files: false,
    accepts_private_keys: false,
    no_new_dependencies: true,
  };
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
    console.error(`production-pause-checkpoint: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  check,
  plan,
  selfTest,
};
