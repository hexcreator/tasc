#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validate: validateTimedPayout } = require("./validate-timed-payout-proof");
const { verifySignedSolanaIntent } = require("./tascsolana");
const { validateHandoff: validateProductionDeployHandoff } = require("./build-production-deploy-handoff");
const { validateProductionPayout } = require("./validate-real-money-readiness");
const { assertBase58Address, base58Decode, base58Encode } = require("./run-solana-devnet");
const {
  DEFAULT_ENV_FILE,
  PRODUCTION_ENV,
  loadEnvFile,
} = require("./production-env");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = ".tascverifier/production-run-packet.json";
const DEFAULT_TASK_FILE = "examples/summarize_url.tasc";
const DEFAULT_INTENT_DIR = ".tascverifier/production-intent";
const DEFAULT_PRODUCTION_DEPLOY = ".tascverifier/production-deploy-handoff.json";
const DEFAULT_PRODUCTION_PAYOUT = ".tascverifier/production-payout-evidence.json";
const DEFAULT_PRODUCTION_CAPTURE = ".tascverifier/production-run-capture.json";
const DEFAULT_CLUSTER = "solana-mainnet-beta";
const DEFAULT_AMOUNT_BASE_UNITS = "10000000";
const DEFAULT_TARGET_MS = 60_000;
const DEFAULT_INPUT = "url=https://docs.cdp.coinbase.com/x402/welcome";
const PRODUCTION_SUBMITTER_PAGE = "web/production-run.html";

function usage() {
  console.error([
    "Usage:",
    "  node bin/build-production-run-packet.js plan [options]",
    "  node bin/build-production-run-packet.js build [options]",
    "  node bin/build-production-run-packet.js validate <packet.json>",
    "  node bin/build-production-run-packet.js --self-test",
    "",
    "Options:",
    "  --env <file>                              production env file; default .env.solana-mainnet.local",
    "  --out <file>                              output packet file; default .tascverifier/production-run-packet.json",
    "  --task-file <file>                        task file; default examples/summarize_url.tasc",
    "  --input name=value                        task input; repeatable",
    "  --timed-proof <proof-summary.json>        devnet timed proof from earn:devnet",
    "  --production-deploy <file>                production deploy handoff file",
    "  --intent-dir <dir>                        production intent artifact dir",
    "  --signed-intent <file>                    signed production intent file",
    "  --production-capture <file>               production run capture file",
    "  --production-payout <file>                production payout evidence file",
    "  --production-rpc-url <url>                mainnet RPC URL; host only is persisted",
    "  --expected-genesis-hash <hash>            expected mainnet genesis hash",
    "  --program-id <address>                    deployed mainnet Global Tasc program id",
    "  --token-mint <address>                    verified mainnet USDC mint",
    "  --buyer <address>                         buyer wallet",
    "  --worker <address>                        worker wallet",
    "  --verifier <address>                      verifier wallet",
    "  --buyer-usdc-token-account <address>      buyer USDC source token account",
    "  --worker-usdc-token-account <address>     worker USDC destination token account",
    "  --task-account <address>                  expected production task account, once funded",
    "  --vault-token-account <address>           expected production vault token account, once funded",
    "  --now <iso>                               generated_at timestamp; default now",
    "  --run-id <id>                             stable packet id; default generated",
    "",
    "This packet builder never accepts private keys, never calls RPC, and never sends transactions.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    command: "plan",
    envFile: DEFAULT_ENV_FILE,
    packetFile: "",
    out: DEFAULT_OUT,
    taskFile: DEFAULT_TASK_FILE,
    inputs: {},
    timedProof: "",
    productionDeploy: DEFAULT_PRODUCTION_DEPLOY,
    intentDir: DEFAULT_INTENT_DIR,
    signedIntent: "",
    productionCapture: DEFAULT_PRODUCTION_CAPTURE,
    productionPayout: DEFAULT_PRODUCTION_PAYOUT,
    productionRpcUrl: "",
    expectedGenesisHash: "",
    programId: "",
    tokenMint: "",
    buyer: "",
    worker: "",
    verifier: "",
    buyerUsdcTokenAccount: "",
    workerUsdcTokenAccount: "",
    taskAccount: "",
    vaultTokenAccount: "",
    now: "",
    runId: "",
    selfTest: false,
  };
  const args = [...argv];
  if (["plan", "build", "validate"].includes(args[0])) options.command = args.shift();
  if (options.command === "validate" && args[0] && !args[0].startsWith("--")) options.packetFile = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = requireValue(args, ++i, arg);
    else if (arg === "--out") options.out = requireValue(args, ++i, arg);
    else if (arg === "--task-file") options.taskFile = requireValue(args, ++i, arg);
    else if (arg === "--input") {
      const [name, ...valueParts] = String(requireValue(args, ++i, arg)).split("=");
      assert(name && valueParts.length > 0, "--input must use name=value");
      options.inputs[name] = valueParts.join("=");
    } else if (arg === "--timed-proof") options.timedProof = requireValue(args, ++i, arg);
    else if (arg === "--production-deploy") options.productionDeploy = requireValue(args, ++i, arg);
    else if (arg === "--intent-dir") options.intentDir = requireValue(args, ++i, arg);
    else if (arg === "--signed-intent") options.signedIntent = requireValue(args, ++i, arg);
    else if (arg === "--production-capture") options.productionCapture = requireValue(args, ++i, arg);
    else if (arg === "--production-payout") options.productionPayout = requireValue(args, ++i, arg);
    else if (arg === "--production-rpc-url") options.productionRpcUrl = requireValue(args, ++i, arg);
    else if (arg === "--expected-genesis-hash") options.expectedGenesisHash = requireValue(args, ++i, arg);
    else if (arg === "--program-id") options.programId = requireValue(args, ++i, arg);
    else if (arg === "--token-mint") options.tokenMint = requireValue(args, ++i, arg);
    else if (arg === "--buyer") options.buyer = requireValue(args, ++i, arg);
    else if (arg === "--worker") options.worker = requireValue(args, ++i, arg);
    else if (arg === "--verifier") options.verifier = requireValue(args, ++i, arg);
    else if (arg === "--buyer-usdc-token-account") options.buyerUsdcTokenAccount = requireValue(args, ++i, arg);
    else if (arg === "--worker-usdc-token-account") options.workerUsdcTokenAccount = requireValue(args, ++i, arg);
    else if (arg === "--task-account") options.taskAccount = requireValue(args, ++i, arg);
    else if (arg === "--vault-token-account") options.vaultTokenAccount = requireValue(args, ++i, arg);
    else if (arg === "--now") options.now = requireValue(args, ++i, arg);
    else if (arg === "--run-id") options.runId = requireValue(args, ++i, arg);
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

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function rel(file) {
  if (!file) return "";
  const resolved = path.resolve(file);
  return path.relative(ROOT, resolved);
}

function hashShort(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function generatedRunId(options) {
  if (options.runId) return options.runId;
  const basis = [
    options.taskFile,
    options.buyer,
    options.worker,
    options.verifier,
    options.programId,
    options.tokenMint,
    options.now || new Date().toISOString(),
  ].join("|");
  return `production_${hashShort(basis)}`;
}

function defaultInputs(inputs) {
  if (Object.keys(inputs).length > 0) return inputs;
  const [name, ...valueParts] = DEFAULT_INPUT.split("=");
  return { [name]: valueParts.join("=") };
}

function assertIso(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} is required`);
  assert(Number.isFinite(Date.parse(value)), `${label} must be an ISO timestamp`);
  return value;
}

function assertSolanaAddress(value, label) {
  assertBase58Address(value, label);
  const decoded = base58Decode(value);
  assert(decoded.length === 32, `${label} must decode to 32 bytes`);
  return value;
}

function optionalAddress(value, label, missing) {
  if (!value) {
    missing.push(`${label} is required`);
    return "";
  }
  try {
    return assertSolanaAddress(value, label);
  } catch (error) {
    missing.push(error.message);
    return "";
  }
}

function rpcHostOnly(rpcUrl, missing) {
  if (!rpcUrl) {
    missing.push("mainnet RPC URL is required for preflight/readiness");
    return null;
  }
  try {
    const url = new URL(rpcUrl);
    assert(url.protocol === "http:" || url.protocol === "https:", "production_rpc_url must be http(s)");
    return url.host;
  } catch (error) {
    missing.push(error.message);
    return null;
  }
}

function intentPaths(intentDir) {
  const dir = path.resolve(intentDir || DEFAULT_INTENT_DIR);
  return {
    dir,
    unsignedIntent: path.join(dir, "production-intent.intent.json"),
    signingPayload: path.join(dir, "production-intent.signing-payload.json"),
    signingPayloadBase64: path.join(dir, "production-intent.signing-payload.base64.txt"),
    signedIntent: path.join(dir, "production-intent.signature.json"),
  };
}

function fileStatus(file, validator) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    return {
      file: rel(resolved),
      exists: false,
      valid: false,
      details: null,
    };
  }
  try {
    const details = validator ? validator(resolved) : null;
    return {
      file: rel(resolved),
      exists: true,
      valid: true,
      details,
    };
  } catch (error) {
    return {
      file: rel(resolved),
      exists: true,
      valid: false,
      error: error.message,
      details: null,
    };
  }
}

function validateSignedIntentFile(file, expected) {
  const signed = loadJson(file);
  const verified = verifySignedSolanaIntent(signed);
  assert(verified.ok === true, "signed production intent signature is invalid");
  const message = signed.intent && signed.intent.message || {};
  assert(message.cluster === DEFAULT_CLUSTER, "signed intent must target solana-mainnet-beta");
  assert(message.amount === DEFAULT_AMOUNT_BASE_UNITS, "signed intent amount must be exactly 10000000");
  if (expected.buyer) assert(message.buyer === expected.buyer, "signed intent buyer mismatch");
  if (expected.verifier) assert(message.verifier === expected.verifier, "signed intent verifier mismatch");
  if (expected.programId) assert(message.program_id === expected.programId, "signed intent program_id mismatch");
  if (expected.tokenMint) assert(message.token_mint === expected.tokenMint, "signed intent token_mint mismatch");
  return {
    signer: verified.signer,
    intent_hash: signed.intent_hash,
    buyer: message.buyer,
    verifier: message.verifier,
    program_id: message.program_id,
    token_mint: message.token_mint,
    amount: message.amount,
    deadline_unix: message.deadline_unix,
    nonce: message.nonce,
  };
}

function validateTimedProofFile(file) {
  const result = validateTimedPayout(file);
  return {
    proof_summary: result.proof_summary,
    claim_to_release_ms: result.timing.claim_to_release_ms,
    claim_to_completed_index_ms: result.timing.claim_to_completed_index_ms,
    under_60s_to_release_confirmation: result.timing.under_60s_to_release_confirmation,
    under_60s_to_completed_index: result.timing.under_60s_to_completed_index,
  };
}

function validateProductionDeployFile(file, expected = {}) {
  const details = validateProductionDeployHandoff(loadJson(file));
  if (expected.programId) assert(details.program_id === expected.programId, "production deploy handoff program_id mismatch");
  return details;
}

function validateProductionPayoutFile(file) {
  return validateProductionPayout(loadJson(file));
}

function commandValue(value, placeholder) {
  return value || placeholder;
}

function envFlag(config) {
  return ` --env ${config.env_file || DEFAULT_ENV_FILE}`;
}

function buildIntentCommand(config) {
  const inputs = Object.entries(config.inputs)
    .map(([name, value]) => ` --input ${name}=${value}`)
    .join("");
  return [
    `npm run real:intent:build -- ${config.task_file}`,
    envFlag(config),
    inputs,
  ].join("");
}

function buildDeployHandoffCommand(config) {
  return [
    "npm run real:deploy:build --",
    envFlag(config),
  ].join("");
}

function buildPreflightCommand(config) {
  return [
    "npm run real:preflight --",
    envFlag(config),
  ].join("");
}

function buildFundCommand(config, artifacts) {
  return [
    "npm run real:fund:build --",
    envFlag(config),
    ` --signed-intent ${artifacts.intent.signed_intent_file}`,
  ].join("");
}

function buildLifecycleClaimCommand(config, artifacts) {
  return [
    "npm run real:lifecycle:build --",
    envFlag(config),
    " --action claim",
    ` --signed-intent ${artifacts.intent.signed_intent_file}`,
    ` --task-account ${commandValue(config.task_account, "<task-account>")}`,
  ].join("");
}

function buildLifecycleAttestCommand(config, artifacts) {
  return [
    "npm run real:lifecycle:build --",
    envFlag(config),
    " --action attest",
    ` --signed-intent ${artifacts.intent.signed_intent_file}`,
    ` --task-account ${commandValue(config.task_account, "<task-account>")}`,
    " --verdict pass",
    " --result-hash <0x-result-hash>",
  ].join("");
}

function buildLifecycleReleaseCommand(config, artifacts) {
  return [
    "npm run real:lifecycle:build --",
    envFlag(config),
    " --action release",
    ` --signed-intent ${artifacts.intent.signed_intent_file}`,
    ` --task-account ${commandValue(config.task_account, "<task-account>")}`,
  ].join("");
}

function buildPayoutCommand(config) {
  return [
    "npm run real:capture:payout --",
    envFlag(config),
    ` --capture ${config.production_capture_file}`,
    ` --out ${config.production_payout_file}`,
  ].join("");
}

function buildCaptureInitCommand(config) {
  return [
    "npm run real:capture:init --",
    envFlag(config),
    ` --capture ${config.production_capture_file}`,
    ` --signed-intent ${commandValue(config.signed_intent_file, ".tascverifier/production-intent/production-intent.signature.json")}`,
  ].join("");
}

function buildCaptureFundCommand(config) {
  return [
    "npm run real:capture:record --",
    ` --capture ${config.production_capture_file}`,
    " --transaction .tascverifier/production-fund-transaction.json",
    " --signature <fund-sig>",
  ].join("");
}

function buildCaptureClaimCommand(config) {
  return [
    "npm run real:capture:record --",
    ` --capture ${config.production_capture_file}`,
    " --transaction .tascverifier/production-lifecycle-claim.json",
    " --signature <claim-sig>",
    " --claim-started-at <iso-claim-started>",
  ].join("");
}

function buildCaptureAttestCommand(config) {
  return [
    "npm run real:capture:record --",
    ` --capture ${config.production_capture_file}`,
    " --transaction .tascverifier/production-lifecycle-attest.json",
    " --signature <attest-sig>",
  ].join("");
}

function buildCaptureReleaseCommand(config) {
  return [
    "npm run real:capture:record --",
    ` --capture ${config.production_capture_file}`,
    " --transaction .tascverifier/production-lifecycle-release.json",
    " --signature <release-sig>",
    " --release-confirmed-at <iso-release-confirmed>",
    " --completed-indexed-at <iso-completed-indexed>",
  ].join("");
}

function walletSubmitterHandoff(phase, artifactFile, role, signer, captureCommand, timing) {
  return {
    page: PRODUCTION_SUBMITTER_PAGE,
    phase,
    artifact: artifactFile,
    required_wallet_role: role,
    required_signer: commandValue(signer, `<${role}-wallet>`),
    rpc_url_input: "<mainnet-rpc-url>",
    guarded_send_checkbox: "Enable production wallet sends",
    accepts_private_keys: false,
    full_rpc_url_persisted: false,
    capture_command_after_send: captureCommand,
    timing: timing || null,
    instructions: [
      `Open ${PRODUCTION_SUBMITTER_PAGE} from a local or hosted copy of web/.`,
      `Paste or select ${artifactFile}.`,
      `Connect the ${role} wallet and verify it matches the artifact signer.`,
      "Enter the mainnet RPC URL locally in the page.",
      "Enable production wallet sends only after reviewing the artifact summary.",
      "Submit the transaction and run the generated capture command.",
    ],
  };
}

function buildReadinessCommand(config) {
  return [
    "npm run real:readiness --",
    envFlag(config),
    ` --timed-proof ${commandValue(config.timed_proof_file, "examples/solana-devnet/proofs/<run-id>/proof-summary.json")}`,
    ` --production-payout ${config.production_payout_file}`,
  ].join("");
}

function commandSequence(config, artifacts) {
  return [
    {
      step: 1,
      phase: "prove-devnet-timing",
      command: "GLOBAL_TASC_ALLOW_SOLANA_DEVNET_PROOF=1 npm run earn:devnet",
      output: "examples/solana-devnet/proofs/<run-id>/proof-summary.json",
      required_for_goal: true,
      sends_transactions: true,
      network: "solana-devnet",
    },
    {
      step: 2,
      phase: "build-mainnet-program-deploy-handoff",
      command: buildDeployHandoffCommand(config),
      output: artifacts.production_deploy.file,
      required_for_goal: true,
      sends_transactions: false,
    },
    {
      step: 3,
      phase: "deploy-mainnet-program",
      manual_action: "Deploy the reviewed SBF artifact with the exact command from the production deploy handoff, then capture the deploy signature and executable program account.",
      required_for_goal: true,
      sends_transactions: true,
      network: DEFAULT_CLUSTER,
    },
    {
      step: 4,
      phase: "build-mainnet-buyer-intent",
      command: buildIntentCommand(config),
      output: artifacts.intent.unsigned_intent_file,
      required_for_goal: true,
      sends_transactions: false,
    },
    {
      step: 5,
      phase: "wallet-sign-intent-payload",
      manual_action: `Sign ${artifacts.intent.signing_payload_file} with the buyer wallet and keep the base58 Ed25519 signature.`,
      required_for_goal: true,
      sends_transactions: false,
    },
    {
      step: 6,
      phase: "attach-and-verify-intent-signature",
      command: `npm run real:intent:attach-signature -- --intent ${artifacts.intent.unsigned_intent_file} --signature <base58-wallet-signature>`,
      output: artifacts.intent.signed_intent_file,
      required_for_goal: true,
      sends_transactions: false,
    },
    {
      step: 7,
      phase: "init-production-run-capture",
      command: buildCaptureInitCommand(config),
      output: config.production_capture_file,
      required_for_goal: true,
      sends_transactions: false,
    },
    {
      step: 8,
      phase: "mainnet-preflight",
      command: buildPreflightCommand(config),
      required_for_goal: true,
      sends_transactions: false,
      calls_rpc: true,
      rpc_url_redacted: true,
    },
    {
      step: 9,
      phase: "build-mainnet-fund-transaction",
      command: buildFundCommand(config, artifacts),
      output: ".tascverifier/production-fund-transaction.json",
      required_for_goal: true,
      sends_transactions: false,
      calls_rpc: true,
      rpc_url_redacted: true,
    },
    {
      step: 10,
      phase: "wallet-send-mainnet-fund-transaction",
      manual_action: `Submit .tascverifier/production-fund-transaction.json through ${PRODUCTION_SUBMITTER_PAGE} with the buyer wallet; capture the returned fund signature, task account, and vault token account.`,
      wallet_submitter: walletSubmitterHandoff(
        "fund",
        ".tascverifier/production-fund-transaction.json",
        "buyer",
        config.buyer,
        buildCaptureFundCommand(config),
      ),
      required_for_goal: true,
      sends_transactions: true,
      network: DEFAULT_CLUSTER,
    },
    {
      step: 11,
      phase: "record-mainnet-fund-capture",
      command: buildCaptureFundCommand(config),
      output: config.production_capture_file,
      required_for_goal: true,
      sends_transactions: false,
    },
    {
      step: 12,
      phase: "build-worker-claim-transaction",
      command: buildLifecycleClaimCommand(config, artifacts),
      output: ".tascverifier/production-lifecycle-claim.json",
      required_for_goal: true,
      sends_transactions: false,
      calls_rpc: true,
      rpc_url_redacted: true,
    },
    {
      step: 13,
      phase: "wallet-send-worker-claim-transaction",
      manual_action: `Submit .tascverifier/production-lifecycle-claim.json through ${PRODUCTION_SUBMITTER_PAGE} with the worker wallet; start the payout timer at wallet submission and capture the confirmed claim signature.`,
      wallet_submitter: walletSubmitterHandoff(
        "claim",
        ".tascverifier/production-lifecycle-claim.json",
        "worker",
        config.worker,
        buildCaptureClaimCommand(config),
        {
          timer_starts_at: "wallet submission in production-run.html",
          capture_field: "--claim-started-at",
          target_ms: DEFAULT_TARGET_MS,
        },
      ),
      required_for_goal: true,
      sends_transactions: true,
      network: DEFAULT_CLUSTER,
    },
    {
      step: 14,
      phase: "record-worker-claim-capture",
      command: buildCaptureClaimCommand(config),
      output: config.production_capture_file,
      required_for_goal: true,
      sends_transactions: false,
    },
    {
      step: 15,
      phase: "build-verifier-attest-transaction",
      command: buildLifecycleAttestCommand(config, artifacts),
      output: ".tascverifier/production-lifecycle-attest.json",
      required_for_goal: true,
      sends_transactions: false,
      calls_rpc: true,
      rpc_url_redacted: true,
    },
    {
      step: 16,
      phase: "wallet-send-verifier-attest-transaction",
      manual_action: `Submit .tascverifier/production-lifecycle-attest.json through ${PRODUCTION_SUBMITTER_PAGE} with the verifier wallet after checking the result hash; capture the confirmed attest signature.`,
      wallet_submitter: walletSubmitterHandoff(
        "attest",
        ".tascverifier/production-lifecycle-attest.json",
        "verifier",
        config.verifier,
        buildCaptureAttestCommand(config),
      ),
      required_for_goal: true,
      sends_transactions: true,
      network: DEFAULT_CLUSTER,
    },
    {
      step: 17,
      phase: "record-verifier-attest-capture",
      command: buildCaptureAttestCommand(config),
      output: config.production_capture_file,
      required_for_goal: true,
      sends_transactions: false,
    },
    {
      step: 18,
      phase: "build-worker-release-transaction",
      command: buildLifecycleReleaseCommand(config, artifacts),
      output: ".tascverifier/production-lifecycle-release.json",
      required_for_goal: true,
      sends_transactions: false,
      calls_rpc: true,
      rpc_url_redacted: true,
    },
    {
      step: 19,
      phase: "wallet-send-worker-release-transaction",
      manual_action: `Submit .tascverifier/production-lifecycle-release.json through ${PRODUCTION_SUBMITTER_PAGE} with the worker wallet; capture the release signature and confirmation timestamp.`,
      wallet_submitter: walletSubmitterHandoff(
        "release",
        ".tascverifier/production-lifecycle-release.json",
        "worker",
        config.worker,
        buildCaptureReleaseCommand(config),
        {
          timer_ends_at: "release confirmation in production-run.html",
          capture_fields: ["--release-confirmed-at", "--completed-indexed-at"],
          target_ms: DEFAULT_TARGET_MS,
        },
      ),
      required_for_goal: true,
      sends_transactions: true,
      network: DEFAULT_CLUSTER,
    },
    {
      step: 20,
      phase: "record-worker-release-capture",
      command: buildCaptureReleaseCommand(config),
      output: config.production_capture_file,
      required_for_goal: true,
      sends_transactions: false,
    },
    {
      step: 21,
      phase: "build-production-payout-evidence",
      command: buildPayoutCommand(config),
      output: artifacts.production_payout.file,
      required_for_goal: true,
      sends_transactions: false,
      calls_rpc: true,
      rpc_url_redacted: true,
    },
    {
      step: 22,
      phase: "validate-real-money-readiness",
      command: buildReadinessCommand(config),
      required_for_goal: true,
      sends_transactions: false,
      calls_rpc: true,
      rpc_url_redacted: true,
      success_condition: "ready_for_goal must be true",
    },
  ];
}

function buildPacket(options = {}) {
  const missing = [];
  const generatedAt = assertIso(options.now || new Date().toISOString(), "generated_at");
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const fileEnv = loadEnvFile(envFile);
  const mergedEnv = { ...fileEnv, ...process.env };
  const envValue = (optionValue, key) => optionValue || mergedEnv[key] || "";
  const productionRpcUrl = envValue(options.productionRpcUrl, PRODUCTION_ENV.rpcUrl);
  const rpcHost = rpcHostOnly(productionRpcUrl, missing);
  const paths = intentPaths(options.intentDir || DEFAULT_INTENT_DIR);
  const signedIntentFile = path.resolve(options.signedIntent || paths.signedIntent);
  const config = {
    env_file: rel(envFile),
    env_file_exists: fs.existsSync(envFile),
    task_file: options.taskFile || DEFAULT_TASK_FILE,
    inputs: defaultInputs(options.inputs || {}),
    timed_proof_file: options.timedProof ? rel(options.timedProof) : "",
    production_deploy_file: rel(options.productionDeploy || DEFAULT_PRODUCTION_DEPLOY),
    production_capture_file: rel(options.productionCapture || DEFAULT_PRODUCTION_CAPTURE),
    production_payout_file: rel(options.productionPayout || DEFAULT_PRODUCTION_PAYOUT),
    signed_intent_file: rel(signedIntentFile),
    expected_genesis_hash: envValue(options.expectedGenesisHash, PRODUCTION_ENV.expectedGenesisHash),
    program_id: envValue(options.programId, PRODUCTION_ENV.programId)
      ? optionalAddress(envValue(options.programId, PRODUCTION_ENV.programId), "program_id", missing)
      : "",
    token_mint: optionalAddress(envValue(options.tokenMint, PRODUCTION_ENV.tokenMint), "token_mint", missing),
    buyer: optionalAddress(envValue(options.buyer, PRODUCTION_ENV.buyer), "buyer", missing),
    worker: optionalAddress(envValue(options.worker, PRODUCTION_ENV.worker), "worker", missing),
    verifier: optionalAddress(envValue(options.verifier, PRODUCTION_ENV.verifier), "verifier", missing),
    buyer_usdc_token_account: optionalAddress(envValue(options.buyerUsdcTokenAccount, PRODUCTION_ENV.buyerUsdc), "buyer_usdc_token_account", missing),
    worker_usdc_token_account: optionalAddress(envValue(options.workerUsdcTokenAccount, PRODUCTION_ENV.workerUsdc), "worker_usdc_token_account", missing),
    task_account: options.taskAccount ? optionalAddress(options.taskAccount, "task_account", missing) : "",
    vault_token_account: options.vaultTokenAccount ? optionalAddress(options.vaultTokenAccount, "vault_token_account", missing) : "",
  };
  if (!config.expected_genesis_hash) missing.push("expected mainnet genesis hash is required");
  if (!fs.existsSync(config.task_file)) missing.push(`task file not found: ${config.task_file}`);

  const artifacts = {
    timed_proof: options.timedProof
      ? fileStatus(options.timedProof, validateTimedProofFile)
      : {
        file: "",
        exists: false,
        valid: false,
        details: null,
      },
    production_deploy: fileStatus(options.productionDeploy || DEFAULT_PRODUCTION_DEPLOY, (file) => validateProductionDeployFile(file, {
      programId: config.program_id,
    })),
  };
  if (!config.program_id && artifacts.production_deploy.valid && artifacts.production_deploy.details.program_id) {
    config.program_id = artifacts.production_deploy.details.program_id;
  }
  if (!config.program_id) missing.push("program_id is required");
  artifacts.intent = {
    dir: rel(paths.dir),
    unsigned_intent_file: rel(paths.unsignedIntent),
    signing_payload_file: rel(paths.signingPayload),
    signing_payload_base64_file: rel(paths.signingPayloadBase64),
    signed_intent_file: rel(signedIntentFile),
    unsigned_intent_exists: fs.existsSync(paths.unsignedIntent),
    signing_payload_exists: fs.existsSync(paths.signingPayload),
    signed_intent: fileStatus(signedIntentFile, (file) => validateSignedIntentFile(file, {
      buyer: config.buyer,
      verifier: config.verifier,
      programId: config.program_id,
      tokenMint: config.token_mint,
    })),
  };
  artifacts.production_payout = fileStatus(options.productionPayout || DEFAULT_PRODUCTION_PAYOUT, validateProductionPayoutFile);
  if (!artifacts.timed_proof.valid) missing.push("valid timed devnet payout proof is required");
  if (!artifacts.production_deploy.valid) missing.push("valid production deploy handoff is required before mainnet funding");
  if (!artifacts.intent.signed_intent.valid) missing.push("valid signed production intent is required");
  const attemptBlockers = [...new Set(missing)];
  if (!artifacts.production_payout.valid) missing.push("valid production payout evidence is required before the final readiness check");

  const packet = {
    ok: true,
    kind: "tasc.production_run.packet",
    version: "0.1",
    generated_at: generatedAt,
    run_id: generatedRunId({ ...options, now: generatedAt }),
    goal: "make $10 in less than a minute",
    target: {
      chain: "solana",
      cluster: DEFAULT_CLUSTER,
      network_type: "mainnet",
      token_symbol: "USDC",
      token_decimals: 6,
      amount_display: "10 USDC",
      amount_base_units: DEFAULT_AMOUNT_BASE_UNITS,
      target_ms: DEFAULT_TARGET_MS,
    },
    safety: {
      sends_transactions: false,
      accepts_private_keys: false,
      key_material_printed: false,
      calls_rpc: false,
      writes_files: true,
      rpc_url_printed: false,
      full_rpc_url_persisted: false,
      no_new_dependencies: true,
    },
    configured: {
      ...config,
      production_rpc_host: rpcHost,
      production_rpc_url_set: Boolean(productionRpcUrl),
      production_rpc_url_persisted: false,
      task_account_known: Boolean(config.task_account),
      vault_token_account_known: Boolean(config.vault_token_account),
      env_keys_loaded: Object.values(PRODUCTION_ENV).filter((key) => Boolean(fileEnv[key] || process.env[key])),
    },
    artifacts,
    operator_sequence: commandSequence(config, artifacts),
    live_evidence_to_capture: [
      "mainnet program deploy transaction signature or preflight proof that the same program id is already executable",
      "fund transaction signature",
      "claim transaction signature",
      "attest transaction signature",
      "release transaction signature",
      "claim started/submitted timestamp",
      "release confirmed timestamp",
      "completed index publication timestamp",
      "post-release vault token balance of 0",
      "post-release worker destination USDC balance >= 10000000 base units",
    ],
    acceptance_gate: {
      command: buildReadinessCommand(config),
      required_result: "ready_for_goal === true",
      current_packet_marks_goal_complete: false,
    },
    ready_to_attempt_mainnet: attemptBlockers.length === 0,
    ready_for_readiness_check: missing.length === 0,
    ready_for_goal: false,
    attempt_blockers: attemptBlockers,
    missing: [...new Set(missing)],
  };
  return packet;
}

function validatePacket(packet) {
  assert(packet && typeof packet === "object", "packet must be a JSON object");
  assert(packet.kind === "tasc.production_run.packet", "packet kind mismatch");
  assert(packet.version === "0.1", "packet version mismatch");
  assertIso(packet.generated_at, "generated_at");
  assert(packet.goal === "make $10 in less than a minute", "goal mismatch");
  assert(packet.target && packet.target.cluster === DEFAULT_CLUSTER, "target cluster mismatch");
  assert(packet.target.amount_base_units === DEFAULT_AMOUNT_BASE_UNITS, "target amount must be exactly 10000000");
  assert(packet.target.target_ms === DEFAULT_TARGET_MS, "target_ms must be 60000");
  assert(packet.safety && packet.safety.sends_transactions === false, "packet builder must not send transactions");
  assert(packet.safety.accepts_private_keys === false, "packet builder must not accept private keys");
  assert(packet.safety.key_material_printed === false, "packet builder must not print key material");
  assert(packet.safety.calls_rpc === false, "packet builder must not call RPC");
  assert(packet.safety.full_rpc_url_persisted === false, "packet must not persist full RPC URL");
  assert(packet.configured.production_rpc_url_persisted === false, "configured block must not persist full RPC URL");
  assert(typeof packet.ready_for_readiness_check === "boolean", "ready_for_readiness_check must be boolean");
  assert(packet.ready_for_goal === false, "run packet alone must not mark the goal complete");
  assert(Array.isArray(packet.operator_sequence), "operator_sequence must be an array");
  const phases = packet.operator_sequence.map((step) => step.phase);
  [
    "build-mainnet-program-deploy-handoff",
    "deploy-mainnet-program",
    "build-mainnet-buyer-intent",
    "init-production-run-capture",
    "mainnet-preflight",
    "build-mainnet-fund-transaction",
    "record-mainnet-fund-capture",
    "build-worker-claim-transaction",
    "record-worker-claim-capture",
    "build-verifier-attest-transaction",
    "record-verifier-attest-capture",
    "build-worker-release-transaction",
    "record-worker-release-capture",
    "build-production-payout-evidence",
    "validate-real-money-readiness",
  ].forEach((phase) => {
    assert(phases.includes(phase), `operator_sequence missing ${phase}`);
  });
  const packetText = JSON.stringify(packet);
  assert(!packetText.includes("credential="), "packet must not persist RPC query strings");
  assert(!packetText.includes("/sensitive/rpc"), "packet must not persist full RPC paths");
  assert(packetText.includes("npm run real:deploy:build"), "packet must include deploy handoff command");
  assert(packetText.includes("npm run real:intent:build"), "packet must include intent command");
  assert(packetText.includes("npm run real:preflight"), "packet must include preflight command");
  assert(packetText.includes("npm run real:lifecycle:build"), "packet must include lifecycle transaction command");
  assert(packetText.includes("npm run real:capture:"), "packet must include capture commands");
  assert(packetText.includes("--transaction .tascverifier/production-"), "packet must include artifact-aware capture commands");
  assert(packetText.includes("npm run real:capture:payout"), "packet must include payout command");
  assert(packetText.includes("npm run real:readiness"), "packet must include readiness command");
  [
    ["wallet-send-mainnet-fund-transaction", "fund", ".tascverifier/production-fund-transaction.json", "buyer"],
    ["wallet-send-worker-claim-transaction", "claim", ".tascverifier/production-lifecycle-claim.json", "worker"],
    ["wallet-send-verifier-attest-transaction", "attest", ".tascverifier/production-lifecycle-attest.json", "verifier"],
    ["wallet-send-worker-release-transaction", "release", ".tascverifier/production-lifecycle-release.json", "worker"],
  ].forEach(([phaseName, phase, artifact, role]) => {
    const step = packet.operator_sequence.find((entry) => entry.phase === phaseName);
    assert(step && step.wallet_submitter, `${phaseName} must include production wallet submitter handoff`);
    assert(step.wallet_submitter.page === PRODUCTION_SUBMITTER_PAGE, `${phaseName} submitter page mismatch`);
    assert(step.wallet_submitter.phase === phase, `${phaseName} submitter phase mismatch`);
    assert(step.wallet_submitter.artifact === artifact, `${phaseName} submitter artifact mismatch`);
    assert(step.wallet_submitter.required_wallet_role === role, `${phaseName} submitter role mismatch`);
    assert(step.wallet_submitter.accepts_private_keys === false, `${phaseName} submitter must not accept private keys`);
    assert(step.wallet_submitter.full_rpc_url_persisted === false, `${phaseName} submitter must not persist full RPC URL`);
    assert(step.wallet_submitter.capture_command_after_send.includes(`--transaction ${artifact}`), `${phaseName} capture command must reference artifact`);
    assert(step.wallet_submitter.capture_command_after_send.includes("npm run real:capture:record"), `${phaseName} capture command missing recorder`);
    assert(Array.isArray(step.wallet_submitter.instructions) && step.wallet_submitter.instructions.length >= 5, `${phaseName} submitter instructions missing`);
  });
  return {
    ok: true,
    kind: "tasc.production_run.packet.validation",
    version: "0.1",
    ready_to_attempt_mainnet: packet.ready_to_attempt_mainnet,
    ready_for_readiness_check: packet.ready_for_readiness_check,
    ready_for_goal: packet.ready_for_goal,
    command_steps: packet.operator_sequence.length,
    wallet_submitter_handoffs: 4,
    no_new_dependencies: true,
  };
}

function plan(options = {}) {
  const packet = buildPacket(options);
  return {
    ...packet,
    kind: "tasc.production_run.plan",
    mode: "plan",
    safety: {
      ...packet.safety,
      writes_files: false,
    },
    default_output: options.out || DEFAULT_OUT,
    artifacts: {
      ...packet.artifacts,
      packet_file: rel(options.out || DEFAULT_OUT),
    },
  };
}

function build(options = {}) {
  const packet = buildPacket(options);
  validatePacket(packet);
  const out = path.resolve(options.out || DEFAULT_OUT);
  writeJson(out, packet);
  return {
    ok: true,
    kind: "tasc.production_run.build_result",
    version: "0.1",
    packet_file: rel(out),
    ready_to_attempt_mainnet: packet.ready_to_attempt_mainnet,
    ready_for_readiness_check: packet.ready_for_readiness_check,
    ready_for_goal: packet.ready_for_goal,
    missing: packet.missing,
    sends_transactions: false,
    accepts_private_keys: false,
    key_material_printed: false,
    calls_rpc: false,
    rpc_url_printed: false,
    full_rpc_url_persisted: false,
    no_new_dependencies: true,
  };
}

function sampleAddress(byte) {
  return base58Encode(Buffer.alloc(32, byte));
}

function sampleSignature(byte) {
  return base58Encode(Buffer.alloc(64, byte));
}

function sampleTimedProof(dir) {
  const evidence = {
    claimable_index_file: path.join(dir, "release.claimable.index.json"),
    completed_index_file: path.join(dir, "release.completed.index.json"),
    settlement_file: path.join(dir, "release.settlement.live.json"),
    release_file: path.join(dir, "release.release.live.json"),
  };
  for (const file of Object.values(evidence)) writeJson(file, { ok: true });
  const summary = {
    ok: true,
    kind: "tasc.solana-devnet.proof",
    no_new_dependencies: true,
    key_material_printed: false,
    rpc_url_printed: false,
    run_id: "production_run_packet_self_test",
    timed_payout: {
      ok: true,
      branch: "release",
      task_hash: "0x7a65571d274b9d680d14bb05e2a5c736e7f2a2edb7fe0cc235f0fcdc7f81e465",
      task_account: sampleAddress(20),
      claim_signature: sampleSignature(21),
      attest_signature: sampleSignature(22),
      release_signature: sampleSignature(23),
      payout: {
        display_reward: "10 USDC",
        amount: DEFAULT_AMOUNT_BASE_UNITS,
        token_mint: sampleAddress(24),
        destination_role: "worker",
        completed_status: "Released",
        settlement_action: "release",
        vault_balance_after: "0",
        destination_balance_after: DEFAULT_AMOUNT_BASE_UNITS,
      },
      timing: {
        target_ms: DEFAULT_TARGET_MS,
        live_deadline: "60s",
        claim_to_release_ms: 4669,
        claim_to_completed_index_ms: 4751,
        under_60s_to_release_confirmation: true,
        under_60s_to_completed_index: true,
      },
      evidence,
    },
  };
  const summaryFile = path.join(dir, "proof-summary.json");
  writeJson(summaryFile, summary);
  return summaryFile;
}

function sampleProductionPayout(file, input) {
  writeJson(file, {
    kind: "tasc.production_payout.evidence",
    version: "0.1",
    generated_at: "2026-01-01T00:00:00.000Z",
    example_only: false,
    real_money: true,
    network: {
      chain: "solana",
      cluster: DEFAULT_CLUSTER,
      network_type: "mainnet",
    },
    token: {
      symbol: "USDC",
      decimals: 6,
      mint: input.tokenMint,
      production_asset: true,
    },
    amount: {
      display: "10 USDC",
      base_units: DEFAULT_AMOUNT_BASE_UNITS,
    },
    settlement: {
      program_id: input.programId,
      completed_status: "Released",
      action: "release",
      task_hash: input.taskHash,
      task_account: input.taskAccount,
      buyer: input.buyer,
      worker: input.worker,
      verifier: input.verifier,
      deadline_unix: input.deadlineUnix,
      nonce: input.nonce,
      result_hash: input.resultHash,
      vault_token_account: input.vaultTokenAccount,
      destination_role: "worker",
      destination_token_account: input.destinationTokenAccount,
      vault_balance_after: "0",
      destination_balance_after: DEFAULT_AMOUNT_BASE_UNITS,
    },
    timing: {
      target_ms: DEFAULT_TARGET_MS,
      claim_to_release_ms: 4669,
      claim_to_completed_index_ms: 4751,
      under_60s_to_release_confirmation: true,
      under_60s_to_completed_index: true,
    },
    signatures: {
      fund: sampleSignature(25),
      claim: sampleSignature(26),
      attest: sampleSignature(27),
      release: sampleSignature(28),
    },
    source: {
      built_by: "bin/build-production-payout-evidence.js",
      sends_transactions: false,
      accepts_private_keys: false,
      key_material_printed: false,
      rpc_url_printed: false,
      calls_rpc: false,
      rpc_host: null,
      min_confirmation_for_balance_reads: "finalized",
    },
  });
}

function sampleProductionDeploy(file, programId) {
  writeJson(file, {
    ok: true,
    kind: "tasc.production_deploy.handoff",
    version: "0.1",
    generated_at: "2026-01-01T00:00:00.000Z",
    cluster: DEFAULT_CLUSTER,
    network_type: "mainnet",
    program: {
      id: programId,
      artifact: {
        file: "build/solana/global_tasc_solana_program.so",
        bytes: 17888,
        sha256: "11".repeat(32),
        manifest_file: "build/solana-tasc.sbf.json",
        manifest_sha256: "22".repeat(32),
        manifest_artifact_sha256: "11".repeat(32),
        manifest_matches_artifact: true,
        entrypoint_symbol: {
          checked: true,
          ok: true,
        },
      },
      program_keypair_file: "build/solana/global_tasc_solana_program-keypair.json",
      program_keypair_permissions: {
        mode_octal: "600",
        private_to_owner: true,
      },
      program_keypair_bytes_printed: false,
      program_keypair_material_persisted_in_handoff: false,
    },
    deploy: {
      deployer: "<mainnet-deployer-wallet>",
      command: "solana program deploy build/solana/global_tasc_solana_program.so --program-id build/solana/global_tasc_solana_program-keypair.json --keypair <mainnet-deployer-keypair> --url <mainnet-rpc-url> --output json",
      expected_genesis_hash: "mainnet-self-test-genesis",
      production_rpc_host: "mainnet.example.com",
      production_rpc_url_set: true,
      production_rpc_url_persisted: false,
      capture: [
        "mainnet deploy transaction signature",
        "deployed executable program account",
      ],
      next_preflight_command: "npm run real:preflight -- --env .env.solana-mainnet.local",
    },
    source: {
      built_by: "bin/build-production-deploy-handoff.js",
      sends_transactions: false,
      calls_rpc: false,
      writes_files: true,
      accepts_deployer_private_keys: false,
      reads_program_keypair_file: true,
      key_material_printed: false,
      rpc_url_printed: false,
      full_rpc_url_persisted: false,
      no_new_dependencies: true,
    },
  });
}

async function sampleSignedIntent(file, input) {
  const {
    buildUnsignedIntent,
    attachSignature,
  } = require("./build-production-intent");
  const {
    fixtureKeypair,
    signSolanaIntent,
  } = require("./tascsolana");
  const buyer = fixtureKeypair("buyer");
  const built = buildUnsignedIntent({
    taskFile: input.taskFile,
    buyer: buyer.address,
    verifier: input.verifier,
    programId: input.programId,
    tokenMint: input.tokenMint,
    inputs: { url: "https://docs.cdp.coinbase.com/x402/welcome" },
    now: "1800000000",
    nonce: "9001",
    decimals: 6,
  });
  const unsignedFile = path.join(path.dirname(file), "production-intent.intent.json");
  writeJson(unsignedFile, built.intent);
  const intentForSigning = { ...built.intent };
  delete intentForSigning.signing;
  delete intentForSigning.network_type;
  const signedByFixture = signSolanaIntent(intentForSigning, buyer);
  attachSignature({
    intentFile: unsignedFile,
    signature: signedByFixture.signature,
    out: file,
  });
  return {
    buyer: buyer.address,
    taskHash: built.intent.message.task_hash,
    deadlineUnix: String(built.intent.message.deadline_unix),
    nonce: String(built.intent.message.nonce),
    unsignedFile,
  };
}

async function selfTest() {
  fs.mkdirSync(path.join(ROOT, ".tascverifier"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, ".tascverifier", "production-run-packet-"));
  const intentDir = path.join(dir, "intent");
  const signedIntent = path.join(intentDir, "production-intent.signature.json");
  const timedProof = sampleTimedProof(dir);
  const tokenMint = sampleAddress(30);
  const programId = sampleAddress(31);
  const verifier = sampleAddress(32);
  const worker = sampleAddress(33);
  const buyerUsdc = sampleAddress(34);
  const workerUsdc = sampleAddress(35);
  const taskAccount = sampleAddress(36);
  const vaultTokenAccount = sampleAddress(37);
  const resultHash = `0x${"38".repeat(32)}`;
  const signed = await sampleSignedIntent(signedIntent, {
    taskFile: DEFAULT_TASK_FILE,
    verifier,
    programId,
    tokenMint,
  });
  const productionDeploy = path.join(dir, "production-deploy-handoff.json");
  sampleProductionDeploy(productionDeploy, programId);
  const productionPayout = path.join(dir, "production-payout-evidence.json");
  sampleProductionPayout(productionPayout, {
    programId,
    tokenMint,
    taskHash: signed.taskHash,
    taskAccount,
    buyer: signed.buyer,
    worker,
    verifier,
    deadlineUnix: signed.deadlineUnix,
    nonce: signed.nonce,
    resultHash,
    vaultTokenAccount,
    destinationTokenAccount: workerUsdc,
  });

  const envFile = path.join(dir, ".env.solana-mainnet.local");
  const options = {
    out: path.join(dir, "packet.json"),
    envFile,
    taskFile: DEFAULT_TASK_FILE,
    timedProof,
    productionDeploy,
    intentDir,
    signedIntent,
    productionPayout,
    productionRpcUrl: "https://mainnet.example.com/sensitive/rpc?credential=do-not-store",
    expectedGenesisHash: "mainnet-self-test-genesis",
    programId,
    tokenMint,
    buyer: signed.buyer,
    worker,
    verifier,
    buyerUsdcTokenAccount: buyerUsdc,
    workerUsdcTokenAccount: workerUsdc,
    taskAccount,
    vaultTokenAccount,
    now: "2026-01-01T00:00:00.000Z",
    runId: "production_run_packet_self_test",
  };
  fs.writeFileSync(envFile, [
    `${PRODUCTION_ENV.rpcUrl}=https://mainnet.example.com/sensitive/rpc?credential=do-not-store`,
    `${PRODUCTION_ENV.expectedGenesisHash}=mainnet-self-test-genesis`,
    `${PRODUCTION_ENV.programId}=${programId}`,
    `${PRODUCTION_ENV.tokenMint}=${tokenMint}`,
    `${PRODUCTION_ENV.buyer}=${signed.buyer}`,
    `${PRODUCTION_ENV.worker}=${worker}`,
    `${PRODUCTION_ENV.verifier}=${verifier}`,
    `${PRODUCTION_ENV.buyerUsdc}=${buyerUsdc}`,
    `${PRODUCTION_ENV.workerUsdc}=${workerUsdc}`,
    "",
  ].join("\n"));

  const planResult = plan(options);
  assert(planResult.safety.sends_transactions === false, "plan must not send transactions");
  assert(planResult.safety.writes_files === false, "plan must not write files");
  assert(planResult.safety.calls_rpc === false, "plan must not call RPC");
  assert(planResult.configured.production_rpc_host === "mainnet.example.com", "plan should keep only RPC host");

  const buildResult = build(options);
  assert(buildResult.ok === true, "build should succeed");
  assert(buildResult.ready_to_attempt_mainnet === true, "complete packet should be ready to attempt");
  assert(buildResult.ready_for_readiness_check === true, "complete packet should be ready for readiness check");
  assert(buildResult.ready_for_goal === false, "packet must not mark final goal complete");
  const packetText = fs.readFileSync(options.out, "utf8");
  assert(!packetText.includes("do-not-store"), "packet must not store RPC query credential");
  assert(!packetText.includes("/sensitive/rpc"), "packet must not store full RPC path");
  const packet = loadJson(options.out);
  const validation = validatePacket(packet);
  assert(validation.ok === true, "packet validation should pass");
  const commandText = packet.operator_sequence.map((entry) => entry.command || "").join("\n");
  assert(commandText.includes(`--env ${path.relative(ROOT, envFile)}`), "packet commands should use env file");
  assert(!commandText.includes("--production-rpc-url <mainnet-rpc-url>"), "packet commands should not require explicit RPC URL");
  assert(!commandText.includes("--buyer <buyer-wallet>"), "packet commands should not require explicit env-backed buyer");
  assert(packet.acceptance_gate.command.includes(`--env ${path.relative(ROOT, envFile)}`), "acceptance gate should use env file");

  const envPacket = buildPacket({
    ...options,
    out: path.join(dir, "packet-from-env.json"),
    envFile,
    productionRpcUrl: "",
    expectedGenesisHash: "",
    programId: "",
    tokenMint: "",
    buyer: "",
    worker: "",
    verifier: "",
    buyerUsdcTokenAccount: "",
    workerUsdcTokenAccount: "",
  });
  assert(envPacket.ready_to_attempt_mainnet === true, "env-backed packet should be ready to attempt");
  assert(envPacket.configured.env_file_exists === true, "env-backed packet should report env file");
  assert(envPacket.configured.production_rpc_host === "mainnet.example.com", "env-backed packet should keep only RPC host");
  const envPacketText = JSON.stringify(envPacket);
  assert(!envPacketText.includes("do-not-store"), "env-backed packet must not store RPC query credential");
  assert(!envPacketText.includes("/sensitive/rpc"), "env-backed packet must not store full RPC path");

  const incomplete = buildPacket({
    ...options,
    signedIntent: path.join(dir, "missing.signature.json"),
  });
  assert(incomplete.ready_to_attempt_mainnet === false, "missing signed intent should block attempt readiness");
  assert(incomplete.ready_for_readiness_check === false, "missing signed intent should block readiness check");
  assert(incomplete.missing.includes("valid signed production intent is required"), "missing signed intent blocker should be explicit");

  return {
    ok: true,
    self_test: true,
    plan_no_send_no_write: true,
    build_packet: true,
    validate_packet: true,
    wallet_submitter_handoffs: true,
    env_file_config: true,
    ready_to_attempt_when_complete: buildResult.ready_to_attempt_mainnet,
    ready_for_readiness_check: buildResult.ready_for_readiness_check,
    ready_for_goal: buildResult.ready_for_goal,
    rpc_url_persisted: false,
    rejected_missing_signed_intent: true,
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
  if (options.command === "build") {
    process.stdout.write(`${JSON.stringify(build(options), null, 2)}\n`);
    return;
  }
  if (options.command === "validate") {
    assert(options.packetFile, "validate requires a packet file");
    process.stdout.write(`${JSON.stringify(validatePacket(loadJson(options.packetFile)), null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`build-production-run-packet: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  build,
  buildPacket,
  plan,
  selfTest,
  validatePacket,
};
