#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validate: validateTimedPayout } = require("./validate-timed-payout-proof");
const { verifySignedSolanaIntent } = require("./tascsolana");
const { validateProductionPayout } = require("./validate-real-money-readiness");
const { assertBase58Address, base58Decode, base58Encode } = require("./run-solana-devnet");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = ".tascverifier/production-run-packet.json";
const DEFAULT_TASK_FILE = "examples/summarize_url.tasc";
const DEFAULT_INTENT_DIR = ".tascverifier/production-intent";
const DEFAULT_PRODUCTION_PAYOUT = ".tascverifier/production-payout-evidence.json";
const DEFAULT_CLUSTER = "solana-mainnet-beta";
const DEFAULT_AMOUNT_BASE_UNITS = "10000000";
const DEFAULT_TARGET_MS = 60_000;
const DEFAULT_INPUT = "url=https://docs.cdp.coinbase.com/x402/welcome";

function usage() {
  console.error([
    "Usage:",
    "  node bin/build-production-run-packet.js plan [options]",
    "  node bin/build-production-run-packet.js build [options]",
    "  node bin/build-production-run-packet.js validate <packet.json>",
    "  node bin/build-production-run-packet.js --self-test",
    "",
    "Options:",
    "  --out <file>                              output packet file; default .tascverifier/production-run-packet.json",
    "  --task-file <file>                        task file; default examples/summarize_url.tasc",
    "  --input name=value                        task input; repeatable",
    "  --timed-proof <proof-summary.json>        devnet timed proof from earn:devnet",
    "  --intent-dir <dir>                        production intent artifact dir",
    "  --signed-intent <file>                    signed production intent file",
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
    packetFile: "",
    out: DEFAULT_OUT,
    taskFile: DEFAULT_TASK_FILE,
    inputs: {},
    timedProof: "",
    intentDir: DEFAULT_INTENT_DIR,
    signedIntent: "",
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
    if (arg === "--out") options.out = requireValue(args, ++i, arg);
    else if (arg === "--task-file") options.taskFile = requireValue(args, ++i, arg);
    else if (arg === "--input") {
      const [name, ...valueParts] = String(requireValue(args, ++i, arg)).split("=");
      assert(name && valueParts.length > 0, "--input must use name=value");
      options.inputs[name] = valueParts.join("=");
    } else if (arg === "--timed-proof") options.timedProof = requireValue(args, ++i, arg);
    else if (arg === "--intent-dir") options.intentDir = requireValue(args, ++i, arg);
    else if (arg === "--signed-intent") options.signedIntent = requireValue(args, ++i, arg);
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

function validateProductionPayoutFile(file) {
  return validateProductionPayout(loadJson(file));
}

function commandValue(value, placeholder) {
  return value || placeholder;
}

function buildIntentCommand(config) {
  const inputs = Object.entries(config.inputs)
    .map(([name, value]) => ` --input ${name}=${value}`)
    .join("");
  return [
    `npm run real:intent:build -- ${config.task_file}`,
    ` --buyer ${commandValue(config.buyer, "<buyer-wallet>")}`,
    ` --verifier ${commandValue(config.verifier, "<verifier-wallet>")}`,
    ` --program-id ${commandValue(config.program_id, "<program-id>")}`,
    ` --token-mint ${commandValue(config.token_mint, "<mainnet-usdc-mint>")}`,
    inputs,
  ].join("");
}

function buildPreflightCommand(config) {
  return [
    "npm run real:preflight --",
    " --production-rpc-url <mainnet-rpc-url>",
    ` --expected-genesis-hash ${commandValue(config.expected_genesis_hash, "<mainnet-genesis-hash>")}`,
    ` --program-id ${commandValue(config.program_id, "<program-id>")}`,
    ` --usdc-mint ${commandValue(config.token_mint, "<mainnet-usdc-mint>")}`,
    ` --buyer ${commandValue(config.buyer, "<buyer-wallet>")}`,
    ` --worker ${commandValue(config.worker, "<worker-wallet>")}`,
    ` --verifier ${commandValue(config.verifier, "<verifier-wallet>")}`,
    ` --buyer-usdc-token-account ${commandValue(config.buyer_usdc_token_account, "<buyer-usdc-account>")}`,
    ` --worker-usdc-token-account ${commandValue(config.worker_usdc_token_account, "<worker-usdc-account>")}`,
  ].join("");
}

function buildFundCommand(config, artifacts) {
  return [
    "npm run real:fund:build --",
    ` --signed-intent ${artifacts.intent.signed_intent_file}`,
    ` --buyer-usdc-token-account ${commandValue(config.buyer_usdc_token_account, "<buyer-usdc-account>")}`,
    " --production-rpc-url <mainnet-rpc-url>",
  ].join("");
}

function buildPayoutCommand(config) {
  return [
    "npm run real:payout:build --",
    ` --token-mint ${commandValue(config.token_mint, "<mainnet-usdc-mint>")}`,
    ` --task-account ${commandValue(config.task_account, "<task-account>")}`,
    ` --vault-token-account ${commandValue(config.vault_token_account, "<vault-token-account>")}`,
    ` --destination-token-account ${commandValue(config.worker_usdc_token_account, "<worker-usdc-account>")}`,
    " --fund-signature <fund-sig>",
    " --claim-signature <claim-sig>",
    " --attest-signature <attest-sig>",
    " --release-signature <release-sig>",
    " --claim-to-release-ms <ms>",
    " --claim-to-completed-index-ms <ms>",
    " --production-rpc-url <mainnet-rpc-url>",
  ].join("");
}

function buildReadinessCommand(config) {
  return [
    "npm run real:readiness --",
    ` --timed-proof ${commandValue(config.timed_proof_file, "examples/solana-devnet/proofs/<run-id>/proof-summary.json")}`,
    ` --production-payout ${config.production_payout_file}`,
    " --production-rpc-url <mainnet-rpc-url>",
    ` --expected-genesis-hash ${commandValue(config.expected_genesis_hash, "<mainnet-genesis-hash>")}`,
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
      phase: "build-mainnet-buyer-intent",
      command: buildIntentCommand(config),
      output: artifacts.intent.unsigned_intent_file,
      required_for_goal: true,
      sends_transactions: false,
    },
    {
      step: 3,
      phase: "wallet-sign-intent-payload",
      manual_action: `Sign ${artifacts.intent.signing_payload_file} with the buyer wallet and keep the base58 Ed25519 signature.`,
      required_for_goal: true,
      sends_transactions: false,
    },
    {
      step: 4,
      phase: "attach-and-verify-intent-signature",
      command: `npm run real:intent:attach-signature -- --intent ${artifacts.intent.unsigned_intent_file} --signature <base58-wallet-signature>`,
      output: artifacts.intent.signed_intent_file,
      required_for_goal: true,
      sends_transactions: false,
    },
    {
      step: 5,
      phase: "mainnet-preflight",
      command: buildPreflightCommand(config),
      required_for_goal: true,
      sends_transactions: false,
      calls_rpc: true,
      rpc_url_redacted: true,
    },
    {
      step: 6,
      phase: "build-mainnet-fund-transaction",
      command: buildFundCommand(config, artifacts),
      output: ".tascverifier/production-fund-transaction.json",
      required_for_goal: true,
      sends_transactions: false,
      calls_rpc: true,
      rpc_url_redacted: true,
    },
    {
      step: 7,
      phase: "wallet-send-mainnet-fund-transaction",
      manual_action: "Submit .tascverifier/production-fund-transaction.json with the buyer wallet; capture the returned fund signature, task account, and vault token account.",
      required_for_goal: true,
      sends_transactions: true,
      network: DEFAULT_CLUSTER,
    },
    {
      step: 8,
      phase: "worker-claim",
      manual_action: "Start the payout timer when the worker claim transaction is submitted; capture the confirmed claim signature.",
      required_for_goal: true,
      sends_transactions: true,
      network: DEFAULT_CLUSTER,
    },
    {
      step: 9,
      phase: "verifier-attest",
      manual_action: "Verifier attests pass with the worker result hash; capture the confirmed attest signature.",
      required_for_goal: true,
      sends_transactions: true,
      network: DEFAULT_CLUSTER,
    },
    {
      step: 10,
      phase: "release-to-worker",
      manual_action: "Release the passed task to the worker USDC token account; capture the release signature and confirmation timestamp.",
      required_for_goal: true,
      sends_transactions: true,
      network: DEFAULT_CLUSTER,
    },
    {
      step: 11,
      phase: "build-production-payout-evidence",
      command: buildPayoutCommand(config),
      output: artifacts.production_payout.file,
      required_for_goal: true,
      sends_transactions: false,
      calls_rpc: true,
      rpc_url_redacted: true,
    },
    {
      step: 12,
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
  const rpcHost = rpcHostOnly(options.productionRpcUrl, missing);
  const config = {
    task_file: options.taskFile || DEFAULT_TASK_FILE,
    inputs: defaultInputs(options.inputs || {}),
    timed_proof_file: options.timedProof ? rel(options.timedProof) : "",
    production_payout_file: rel(options.productionPayout || DEFAULT_PRODUCTION_PAYOUT),
    expected_genesis_hash: options.expectedGenesisHash || "",
    program_id: optionalAddress(options.programId, "program_id", missing),
    token_mint: optionalAddress(options.tokenMint, "token_mint", missing),
    buyer: optionalAddress(options.buyer, "buyer", missing),
    worker: optionalAddress(options.worker, "worker", missing),
    verifier: optionalAddress(options.verifier, "verifier", missing),
    buyer_usdc_token_account: optionalAddress(options.buyerUsdcTokenAccount, "buyer_usdc_token_account", missing),
    worker_usdc_token_account: optionalAddress(options.workerUsdcTokenAccount, "worker_usdc_token_account", missing),
    task_account: options.taskAccount ? optionalAddress(options.taskAccount, "task_account", missing) : "",
    vault_token_account: options.vaultTokenAccount ? optionalAddress(options.vaultTokenAccount, "vault_token_account", missing) : "",
  };
  if (!config.expected_genesis_hash) missing.push("expected mainnet genesis hash is required");
  if (!fs.existsSync(config.task_file)) missing.push(`task file not found: ${config.task_file}`);

  const paths = intentPaths(options.intentDir || DEFAULT_INTENT_DIR);
  const signedIntentFile = path.resolve(options.signedIntent || paths.signedIntent);
  const artifacts = {
    timed_proof: options.timedProof
      ? fileStatus(options.timedProof, validateTimedProofFile)
      : {
        file: "",
        exists: false,
        valid: false,
        details: null,
      },
    intent: {
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
    },
    production_payout: fileStatus(options.productionPayout || DEFAULT_PRODUCTION_PAYOUT, validateProductionPayoutFile),
  };
  if (!artifacts.timed_proof.valid) missing.push("valid timed devnet payout proof is required");
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
      production_rpc_url_set: Boolean(options.productionRpcUrl),
      production_rpc_url_persisted: false,
      task_account_known: Boolean(config.task_account),
      vault_token_account_known: Boolean(config.vault_token_account),
    },
    artifacts,
    operator_sequence: commandSequence(config, artifacts),
    live_evidence_to_capture: [
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
    "build-mainnet-buyer-intent",
    "mainnet-preflight",
    "build-mainnet-fund-transaction",
    "build-production-payout-evidence",
    "validate-real-money-readiness",
  ].forEach((phase) => {
    assert(phases.includes(phase), `operator_sequence missing ${phase}`);
  });
  const packetText = JSON.stringify(packet);
  assert(!packetText.includes("credential="), "packet must not persist RPC query strings");
  assert(!packetText.includes("/sensitive/rpc"), "packet must not persist full RPC paths");
  assert(packetText.includes("npm run real:intent:build"), "packet must include intent command");
  assert(packetText.includes("npm run real:preflight"), "packet must include preflight command");
  assert(packetText.includes("npm run real:payout:build"), "packet must include payout command");
  assert(packetText.includes("npm run real:readiness"), "packet must include readiness command");
  return {
    ok: true,
    kind: "tasc.production_run.packet.validation",
    version: "0.1",
    ready_to_attempt_mainnet: packet.ready_to_attempt_mainnet,
    ready_for_readiness_check: packet.ready_for_readiness_check,
    ready_for_goal: packet.ready_for_goal,
    command_steps: packet.operator_sequence.length,
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

function sampleProductionPayout(file, tokenMint, taskAccount, vaultTokenAccount, destinationTokenAccount) {
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
      mint: tokenMint,
      production_asset: true,
    },
    amount: {
      display: "10 USDC",
      base_units: DEFAULT_AMOUNT_BASE_UNITS,
    },
    settlement: {
      completed_status: "Released",
      action: "release",
      task_account: taskAccount,
      vault_token_account: vaultTokenAccount,
      destination_role: "worker",
      destination_token_account: destinationTokenAccount,
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
  const signed = await sampleSignedIntent(signedIntent, {
    taskFile: DEFAULT_TASK_FILE,
    verifier,
    programId,
    tokenMint,
  });
  const productionPayout = path.join(dir, "production-payout-evidence.json");
  sampleProductionPayout(productionPayout, tokenMint, taskAccount, vaultTokenAccount, workerUsdc);

  const options = {
    out: path.join(dir, "packet.json"),
    taskFile: DEFAULT_TASK_FILE,
    timedProof,
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
