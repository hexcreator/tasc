#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { keypairForRole, mergedEnv, base58Encode } = require("./run-solana-devnet");
const { SYSTEM_PROGRAM_ID, sendSpl } = require("./run-solana-fund");
const { createSolanaIntent, signSolanaIntent } = require("./tascsolana");
const splSetup = require("./run-solana-spl-setup");
const lifecycle = require("./run-solana-lifecycle");
const lifecycleScan = require("./scan-solana-lifecycle-live");
const fundingScan = require("./scan-solana-live");
const settlementScan = require("./scan-solana-settlement-live");
const { admit } = require("./tascindex");
const {
  buildSettlementPlan,
  sendWorkerToken,
} = require("./run-solana-spl-settlement");

const DEFAULT_ENV_FILE = ".env.solana-devnet.local";
const DEFAULT_PROOF_ROOT = "examples/solana-devnet/proofs";
const DEFAULT_PROGRAM_KEYPAIR = "build/solana/global_tasc_solana_program-keypair.json";
const DEFAULT_DEVNET_PROGRAM_ID = "FAqKhKke5pZr4TK6kXq9aKR98hWFy19SMQG9eGfXQrRM";
const DEFAULT_SUBMISSION = "examples/submissions/summarize_url.pass.md";
const DEFAULT_LEDGER = "examples/ledger.json";
const DEFAULT_INPUTS = { url: "https://docs.cdp.coinbase.com/x402/welcome" };
const ALLOW_ENV = "GLOBAL_TASC_ALLOW_SOLANA_DEVNET_PROOF";
const FAIL_RESULT_HASH = `0x${"11".repeat(32)}`;
const SUBGUARDS = {
  GLOBAL_TASC_ALLOW_SOLANA_SPL_SETUP: "1",
  GLOBAL_TASC_ALLOW_SOLANA_SPL_FUND: "1",
  GLOBAL_TASC_ALLOW_SOLANA_CLAIM: "1",
  GLOBAL_TASC_ALLOW_SOLANA_ATTEST: "1",
  GLOBAL_TASC_ALLOW_SOLANA_WORKER_TOKEN_SETUP: "1",
  GLOBAL_TASC_ALLOW_SOLANA_RELEASE: "1",
  GLOBAL_TASC_ALLOW_SOLANA_REFUND: "1",
  GLOBAL_TASC_ALLOW_SOLANA_TIMEOUT_REFUND: "1",
};

function usage() {
  console.error([
    "Usage:",
    "  node bin/prove-solana-devnet.js plan [--env file] [--out-dir dir] [--run-id id] [--program-id address]",
    "  node bin/prove-solana-devnet.js run [--env file] [--out-dir dir] [--run-id id] [--program-id address]",
    "",
    `run is live devnet only and refuses to send without ${ALLOW_ENV}=1.`,
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseOptions(rest) {
  const options = {
    envFile: DEFAULT_ENV_FILE,
    outDir: null,
    runId: null,
    programId: null,
    mintAmount: "30000000",
    liveDeadline: "10m",
    timeoutDeadline: "60s",
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--env") options.envFile = rest[++i];
    else if (arg === "--out-dir") options.outDir = rest[++i];
    else if (arg === "--run-id") options.runId = rest[++i];
    else if (arg === "--program-id") options.programId = rest[++i];
    else if (arg === "--mint-amount") options.mintAmount = rest[++i];
    else if (arg === "--live-deadline") options.liveDeadline = rest[++i];
    else if (arg === "--timeout-deadline") options.timeoutDeadline = rest[++i];
    else usage();
  }
  return options;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function defaultRunId() {
  return `proof_${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
}

function safeName(value) {
  const raw = String(value || defaultRunId()).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const collapsed = raw.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const prefixed = /^[a-z_]/.test(collapsed) ? collapsed : `proof_${collapsed}`;
  return prefixed || defaultRunId();
}

function outputDir(options = {}) {
  const runId = safeName(options.runId || defaultRunId());
  return {
    runId,
    dir: options.outDir || path.join(DEFAULT_PROOF_ROOT, runId),
  };
}

function taskSource(name, deadline) {
  return [
    `tasc ${name} {`,
    "  version \"0.1\"",
    "  reward 10 USDC",
    `  deadline ${deadline}`,
    "",
    "  input url string",
    "  output markdown string",
    "",
    "  verify {",
    "    min_words 120",
    "    contains_citation input.url",
    "    no_duplicate worker",
    "  }",
    "",
    "  payout {",
    "    pass -> worker",
    "    timeout -> buyer",
    "    dispute -> reviewers(3)",
    "  }",
    "}",
    "",
  ].join("\n");
}

function addressFromKeypairFile(file) {
  if (!fs.existsSync(file)) return null;
  const parsed = loadJson(file);
  assert(Array.isArray(parsed) && parsed.length === 64, `${file} must be a 64-byte Solana keypair`);
  return base58Encode(Buffer.from(parsed.slice(32)));
}

function resolveProgramId(options = {}, env = {}) {
  return options.programId
    || env.GLOBAL_TASC_SOLANA_PROGRAM_ID
    || addressFromKeypairFile(DEFAULT_PROGRAM_KEYPAIR)
    || DEFAULT_DEVNET_PROGRAM_ID;
}

function verifierAddress(env) {
  if (env.GLOBAL_TASC_SOLANA_VERIFIER_ADDRESS) return env.GLOBAL_TASC_SOLANA_VERIFIER_ADDRESS;
  return keypairForRole(env, "verifier").address;
}

function proofPaths(options = {}) {
  const resolved = outputDir(options);
  const runId = resolved.runId;
  const branch = (name) => `${runId}_${name}`;
  const file = (name) => path.join(resolved.dir, `${name}.json`);
  const taskFile = (name) => path.join(resolved.dir, `${name}.tasc`);
  return {
    runId,
    dir: resolved.dir,
    names: {
      setup: branch("setup"),
      release: branch("release_job"),
      refund: branch("refund_job"),
      timeout: branch("timeout_job"),
    },
    file,
    taskFile,
  };
}

function plan(options = {}) {
  const paths = proofPaths(options);
  return {
    ok: true,
    mode: "plan",
    sends_transactions: false,
    guard_for_live_run: `${ALLOW_ENV}=1`,
    no_new_dependencies: true,
    env_file: path.resolve(options.envFile || DEFAULT_ENV_FILE),
    output_dir: paths.dir,
    output_dir_gitignored: paths.dir.startsWith(DEFAULT_PROOF_ROOT),
    default_program_id: options.programId || DEFAULT_DEVNET_PROGRAM_ID,
    live_run_requires: [
      "local devnet buyer, worker, and verifier keypairs in .env.solana-devnet.local",
      "funded buyer and worker devnet SOL balances",
      `${ALLOW_ENV}=1`,
      "network access to the configured Solana devnet RPC",
    ],
    live_branches: [
      "release: setup SPL mint -> fund -> claim -> worker token -> attest pass -> release -> completed index",
      "failure refund: fund -> claim -> attest fail -> refund -> completed index",
      "timeout refund: sign an already-expired task -> fund -> timeout-refund -> completed index",
    ],
    generated_artifacts: [
      "fresh .tasc files with unique task hashes",
      "signed Solana intents",
      "SPL setup, fund, lifecycle, settlement, and index JSON evidence",
      "proof-summary.json",
    ],
    safety: {
      prints_key_material: false,
      prints_full_rpc_url: false,
      writes_under_gitignored_proof_dir_by_default: true,
      run_sets_only_existing_per_action_devnet_guards_after_top_level_guard: true,
    },
  };
}

function enableSubguards() {
  for (const [key, value] of Object.entries(SUBGUARDS)) {
    process.env[key] = value;
  }
}

function writeSignedTask(input) {
  const { env, name, deadline, now, outDir, programId, tokenMint } = input;
  const buyer = keypairForRole(env, "buyer");
  const taskFile = path.join(outDir, `${name}.tasc`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(taskFile, taskSource(name, deadline));
  const { intent } = createSolanaIntent(taskFile, {
    buyer: buyer.address,
    verifier: verifierAddress(env),
    programId,
    tokenMint,
    now,
    inputs: DEFAULT_INPUTS,
  });
  const signed = signSolanaIntent(intent, buyer);
  const intentFile = path.join(outDir, `${name}.intent.json`);
  const signatureFile = path.join(outDir, `${name}.signature.json`);
  writeJson(intentFile, intent);
  writeJson(signatureFile, signed);
  return {
    task_file: taskFile,
    intent_file: intentFile,
    signature_file: signatureFile,
    task_hash: intent.message.task_hash,
    deadline_unix: intent.message.deadline_unix,
  };
}

async function fundAndIndex(input) {
  const { envFile, paths, signed, setup, label } = input;
  const fundFile = paths.file(`${label}.fund-spl.live`);
  const taskAccountFile = paths.file(`${label}.task-account.live`);
  const fundingFile = paths.file(`${label}.funding.live`);
  const claimableIndexFile = paths.file(`${label}.claimable.index`);
  const fund = await sendSpl({
    envFile,
    signedFile: signed.signature_file,
    splSetupFile: setup.file,
    out: fundFile,
  });
  await fundingScan.scan({
    envFile,
    signedFile: signed.signature_file,
    accountOut: taskAccountFile,
    out: fundingFile,
    signature: fund.signature,
    instructionIndex: fund.fund_instruction_index,
    custodyAccount: fund.vault_token_account,
    custodyInstructionIndex: fund.transfer_instruction_index,
    custodyDecimals: setup.token_decimals,
  });
  const claimable = admit(signed.signature_file, fundingFile, claimableIndexFile);
  return {
    fund_file: fundFile,
    task_account_file: taskAccountFile,
    funding_file: fundingFile,
    claimable_index_file: claimableIndexFile,
    task_account: fund.task_account,
    vault_token_account: fund.vault_token_account,
    fund_signature: fund.signature,
    claimable_status: claimable.entry.status,
  };
}

async function scanLifecycle(envFile, signedFile, out) {
  await lifecycleScan.scan({ envFile, signedFile, out });
  return loadJson(out).decoded;
}

function writeSettlementPlan(file, action, options) {
  const settlementPlan = buildSettlementPlan(action, options);
  writeJson(file, settlementPlan);
  return settlementPlan;
}

async function completeSettlement(input) {
  const { envFile, paths, signed, txFile, label } = input;
  const settlementFile = paths.file(`${label}.settlement.live`);
  const completedIndexFile = paths.file(`${label}.completed.index`);
  await settlementScan.scan({
    envFile,
    signedFile: signed.signature_file,
    txFile,
    out: settlementFile,
  });
  const completed = admit(signed.signature_file, settlementFile, completedIndexFile);
  const settlement = loadJson(settlementFile);
  return {
    settlement_file: settlementFile,
    completed_index_file: completedIndexFile,
    completed_status: completed.entry.completed_status,
    action: settlement.action,
    vault_balance_after: settlement.vault_balance_after,
    destination_balance_after: settlement.destination_balance_after,
  };
}

async function runReleaseBranch(input) {
  const { envFile, paths, setup, signed } = input;
  const label = "release";
  const funded = await fundAndIndex({ envFile, paths, signed, setup, label });
  const claimFile = paths.file(`${label}.claim.live`);
  const claimedAccountFile = paths.file(`${label}.claimed-account.live`);
  const workerTokenFile = paths.file(`${label}.worker-token.live`);
  const attestFile = paths.file(`${label}.attest-pass.live`);
  const passedAccountFile = paths.file(`${label}.passed-account.live`);
  const releasePlanFile = paths.file(`${label}.release-plan.live`);
  const releaseFile = paths.file(`${label}.release.live`);

  const claim = await lifecycle.sendAction("claim", {
    envFile,
    signedFile: signed.signature_file,
    out: claimFile,
  });
  await scanLifecycle(envFile, signed.signature_file, claimedAccountFile);
  const workerToken = await sendWorkerToken({
    envFile,
    signedFile: signed.signature_file,
    taskAccountFile: claimedAccountFile,
    out: workerTokenFile,
  });
  const attest = await lifecycle.sendAction("attest", {
    envFile,
    signedFile: signed.signature_file,
    verdict: "pass",
    submission: DEFAULT_SUBMISSION,
    ledger: DEFAULT_LEDGER,
    inputs: DEFAULT_INPUTS,
    out: attestFile,
  });
  await scanLifecycle(envFile, signed.signature_file, passedAccountFile);
  const releasePlan = writeSettlementPlan(releasePlanFile, "release", {
    signedFile: signed.signature_file,
    taskAccountFile: passedAccountFile,
    fundingFile: funded.funding_file,
    workerTokenFile,
  });
  const release = await lifecycle.sendAction("release", {
    envFile,
    signedFile: signed.signature_file,
    taskAccount: funded.task_account,
    destinationTokenAccount: releasePlan.destination_token_account,
    out: releaseFile,
  });
  const settlement = await completeSettlement({
    envFile,
    paths,
    signed,
    txFile: releaseFile,
    label,
  });
  return {
    ...funded,
    claim_file: claimFile,
    claimed_account_file: claimedAccountFile,
    worker_token_file: workerTokenFile,
    attest_file: attestFile,
    passed_account_file: passedAccountFile,
    release_plan_file: releasePlanFile,
    release_file: releaseFile,
    claim_signature: claim.signature,
    attest_signature: attest.signature,
    worker_token_signature: workerToken.signature || null,
    release_signature: release.signature,
    ...settlement,
  };
}

async function runRefundBranch(input) {
  const { envFile, paths, setup, signed } = input;
  const label = "refund";
  const funded = await fundAndIndex({ envFile, paths, signed, setup, label });
  const claimFile = paths.file(`${label}.claim.live`);
  const claimedAccountFile = paths.file(`${label}.claimed-account.live`);
  const attestFile = paths.file(`${label}.attest-fail.live`);
  const failedAccountFile = paths.file(`${label}.failed-account.live`);
  const refundPlanFile = paths.file(`${label}.refund-plan.live`);
  const refundFile = paths.file(`${label}.refund.live`);

  const claim = await lifecycle.sendAction("claim", {
    envFile,
    signedFile: signed.signature_file,
    out: claimFile,
  });
  await scanLifecycle(envFile, signed.signature_file, claimedAccountFile);
  const attest = await lifecycle.sendAction("attest", {
    envFile,
    signedFile: signed.signature_file,
    verdict: "fail",
    resultHash: FAIL_RESULT_HASH,
    out: attestFile,
  });
  await scanLifecycle(envFile, signed.signature_file, failedAccountFile);
  const refundPlan = writeSettlementPlan(refundPlanFile, "refund", {
    signedFile: signed.signature_file,
    taskAccountFile: failedAccountFile,
    fundingFile: funded.funding_file,
  });
  const refund = await lifecycle.sendAction("refund", {
    envFile,
    signedFile: signed.signature_file,
    taskAccount: funded.task_account,
    destinationTokenAccount: refundPlan.destination_token_account,
    out: refundFile,
  });
  const settlement = await completeSettlement({
    envFile,
    paths,
    signed,
    txFile: refundFile,
    label,
  });
  return {
    ...funded,
    claim_file: claimFile,
    claimed_account_file: claimedAccountFile,
    attest_file: attestFile,
    failed_account_file: failedAccountFile,
    refund_plan_file: refundPlanFile,
    refund_file: refundFile,
    claim_signature: claim.signature,
    attest_signature: attest.signature,
    refund_signature: refund.signature,
    ...settlement,
  };
}

async function runTimeoutBranch(input) {
  const { envFile, paths, setup, signed } = input;
  const label = "timeout";
  const funded = await fundAndIndex({ envFile, paths, signed, setup, label });
  const timeoutPlanFile = paths.file(`${label}.timeout-refund-plan.live`);
  const timeoutRefundFile = paths.file(`${label}.timeout-refund.live`);
  const timeoutAccountFile = paths.file(`${label}.refunded-account.live`);

  const timeoutPlan = writeSettlementPlan(timeoutPlanFile, "timeout-refund", {
    signedFile: signed.signature_file,
    taskAccountFile: funded.task_account_file,
    fundingFile: funded.funding_file,
  });
  const timeoutRefund = await lifecycle.sendAction("timeout-refund", {
    envFile,
    signedFile: signed.signature_file,
    taskAccount: funded.task_account,
    destinationTokenAccount: timeoutPlan.destination_token_account,
    out: timeoutRefundFile,
  });
  await scanLifecycle(envFile, signed.signature_file, timeoutAccountFile);
  const settlement = await completeSettlement({
    envFile,
    paths,
    signed,
    txFile: timeoutRefundFile,
    label,
  });
  return {
    ...funded,
    timeout_refund_plan_file: timeoutPlanFile,
    timeout_refund_file: timeoutRefundFile,
    refunded_account_file: timeoutAccountFile,
    timeout_refund_signature: timeoutRefund.signature,
    ...settlement,
  };
}

async function run(options = {}) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const env = mergedEnv(envFile);
  assert(env[ALLOW_ENV] === "1", `refusing live proof without ${ALLOW_ENV}=1`);
  enableSubguards();

  const paths = proofPaths(options);
  fs.mkdirSync(paths.dir, { recursive: true });
  const programId = resolveProgramId(options, env);
  const now = Math.floor(Date.now() / 1000);

  const setupSigned = writeSignedTask({
    env,
    name: paths.names.setup,
    deadline: options.liveDeadline || "10m",
    now,
    outDir: paths.dir,
    programId,
    tokenMint: SYSTEM_PROGRAM_ID,
  });
  const setupFile = paths.file("setup.live");
  const setup = await splSetup.send({
    envFile,
    signedFile: setupSigned.signature_file,
    out: setupFile,
    mintAmount: options.mintAmount || "30000000",
  });
  setup.file = setupFile;

  const releaseSigned = writeSignedTask({
    env,
    name: paths.names.release,
    deadline: options.liveDeadline || "10m",
    now,
    outDir: paths.dir,
    programId,
    tokenMint: setup.mint,
  });
  const refundSigned = writeSignedTask({
    env,
    name: paths.names.refund,
    deadline: options.liveDeadline || "10m",
    now,
    outDir: paths.dir,
    programId,
    tokenMint: setup.mint,
  });
  const timeoutSigned = writeSignedTask({
    env,
    name: paths.names.timeout,
    deadline: options.timeoutDeadline || "60s",
    now: now - 120,
    outDir: paths.dir,
    programId,
    tokenMint: setup.mint,
  });

  const branches = {
    release: await runReleaseBranch({ envFile, paths, setup, signed: releaseSigned }),
    refund: await runRefundBranch({ envFile, paths, setup, signed: refundSigned }),
    timeout: await runTimeoutBranch({ envFile, paths, setup, signed: timeoutSigned }),
  };

  const summary = {
    ok: true,
    kind: "tasc.solana-devnet.proof",
    version: "0.1",
    mode: "run",
    run_id: paths.runId,
    created_at: new Date().toISOString(),
    env_file: path.resolve(envFile),
    output_dir: paths.dir,
    sends_transactions: true,
    no_new_dependencies: true,
    key_material_printed: false,
    rpc_host: setup.rpc_host,
    rpc_url_printed: false,
    program_id: programId,
    token_mint: setup.mint,
    minted_amount: setup.mint_amount,
    setup: {
      task: setupSigned,
      file: setupFile,
      signature: setup.signature,
      buyer_token_account: setup.buyer_token_account,
      vault_token_account: setup.vault_token_account,
    },
    tasks: {
      release: releaseSigned,
      refund: refundSigned,
      timeout: timeoutSigned,
    },
    branches,
  };
  writeJson(paths.file("proof-summary"), summary);
  return summary;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(plan(options), null, 2)}\n`);
    return;
  }
  if (command === "run") {
    process.stdout.write(`${JSON.stringify(await run(options), null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`prove-solana-devnet: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  ALLOW_ENV,
  DEFAULT_DEVNET_PROGRAM_ID,
  plan,
  run,
};
