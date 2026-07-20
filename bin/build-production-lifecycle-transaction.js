#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  assertBase58Address,
  base58Decode,
  base58Encode,
  encodeShortVectorLength,
} = require("./run-solana-devnet");
const {
  buildLifecycleInstruction,
  signerRoleForAction,
} = require("./run-solana-lifecycle");
const { compileLegacyMessage } = require("./run-solana-fund");
const {
  createSolanaIntent,
  fixtureKeypair,
  signSolanaIntent,
  verifySignedSolanaIntent,
} = require("./tascsolana");
const { fundAddresses } = require("./run-solana-fund");
const { TOKEN_PROGRAM_ID } = require("./tascsolana-spl");
const {
  DEFAULT_ENV_FILE,
  PRODUCTION_ENV,
  envMetadata,
  withProductionEnv,
} = require("./production-env");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_SIGNED_INTENT = ".tascverifier/production-intent/production-intent.signature.json";
const DEFAULT_OUT_DIR = ".tascverifier";
const DEFAULT_CLUSTER = "solana-mainnet-beta";
const DEFAULT_AMOUNT_BASE_UNITS = "10000000";
const DEFAULT_DECIMALS = 6;
const DEFAULT_COMMITMENT = "confirmed";
const CLOCK_SYSVAR_ID = "SysvarC1ock11111111111111111111111111111111";
const ACTIONS = new Set(["claim", "attest", "release", "timeout-refund"]);
const TEST_RPC_HOST_RE = /(devnet|testnet|localhost|127\.0\.0\.1|0\.0\.0\.0|(^|\.)example\.(com|net|org|invalid)$)/i;

function usage() {
  console.error([
    "Usage:",
    "  node bin/build-production-lifecycle-transaction.js plan [options]",
    "  node bin/build-production-lifecycle-transaction.js build [options]",
    "  node bin/build-production-lifecycle-transaction.js validate <artifact.json>",
    "  node bin/build-production-lifecycle-transaction.js --self-test",
    "",
    "Build options:",
    "  --env <file>                              production env file; default .env.solana-mainnet.local",
    "  --action claim|attest|release|timeout-refund",
    "  --signed-intent <file>                    signed production intent; default .tascverifier/production-intent/production-intent.signature.json",
    "  --task-account <address>                  mainnet task account",
    "  --signer <address>                        wallet signer for this action",
    "  --result-hash <0x...>                     required for attest",
    "  --verdict pass|fail                       attest verdict; default pass",
    "  --destination-token-account <address>     required for release",
    "  --production-rpc-url <url>                optional read-only mainnet RPC for latest blockhash",
    "  --recent-blockhash <hash>                 required without --production-rpc-url",
    "  --min-confirmation <status>               processed, confirmed, or finalized; default confirmed",
    "  --out <file>                              output artifact; default .tascverifier/production-lifecycle-<action>.json",
    "",
    "This builder creates unsigned wallet transactions only. It never accepts private keys and never sends transactions.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    command: "plan",
    artifactFile: "",
    envFile: DEFAULT_ENV_FILE,
    action: "",
    signedIntent: DEFAULT_SIGNED_INTENT,
    taskAccount: "",
    signer: "",
    resultHash: "",
    verdict: "pass",
    destinationTokenAccount: "",
    productionRpcUrl: "",
    recentBlockhash: "",
    minConfirmation: DEFAULT_COMMITMENT,
    out: "",
    selfTest: false,
  };
  const args = [...argv];
  if (["plan", "build", "validate"].includes(args[0])) options.command = args.shift();
  if (options.command === "validate" && args[0] && !args[0].startsWith("--")) options.artifactFile = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = requireValue(args, ++i, arg);
    else if (arg === "--action") options.action = requireValue(args, ++i, arg);
    else if (arg === "--signed-intent") options.signedIntent = requireValue(args, ++i, arg);
    else if (arg === "--task-account") options.taskAccount = requireValue(args, ++i, arg);
    else if (arg === "--signer") options.signer = requireValue(args, ++i, arg);
    else if (arg === "--result-hash") options.resultHash = requireValue(args, ++i, arg);
    else if (arg === "--verdict") options.verdict = requireValue(args, ++i, arg);
    else if (arg === "--destination-token-account") options.destinationTokenAccount = requireValue(args, ++i, arg);
    else if (arg === "--production-rpc-url") options.productionRpcUrl = requireValue(args, ++i, arg);
    else if (arg === "--recent-blockhash") options.recentBlockhash = requireValue(args, ++i, arg);
    else if (arg === "--min-confirmation") options.minConfirmation = requireValue(args, ++i, arg);
    else if (arg === "--out") options.out = requireValue(args, ++i, arg);
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  return options;
}

function optionsWithEnv(options = {}) {
  const action = String(options.action || "").toLowerCase().replace(/[_\s]+/g, "-");
  const mapping = {
    productionRpcUrl: PRODUCTION_ENV.rpcUrl,
  };
  if (action === "claim" || action === "release") mapping.signer = PRODUCTION_ENV.worker;
  if (action === "attest") mapping.signer = PRODUCTION_ENV.verifier;
  if (action === "timeout-refund") mapping.signer = PRODUCTION_ENV.buyer;
  if (action === "release") mapping.destinationTokenAccount = PRODUCTION_ENV.workerUsdc;
  if (action === "timeout-refund") mapping.destinationTokenAccount = PRODUCTION_ENV.buyerUsdc;
  return withProductionEnv(options, mapping);
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
  return path.relative(ROOT, path.resolve(file));
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizeAction(action) {
  const normalized = String(action || "").toLowerCase().replace(/[_\s]+/g, "-");
  assert(ACTIONS.has(normalized), "action must be claim, attest, release, or timeout-refund");
  return normalized;
}

function assertSolanaAddress(value, label) {
  assertBase58Address(value, label);
  assert(base58Decode(value).length === 32, `${label} must decode to 32 bytes`);
  return value;
}

function assertBlockhash(value) {
  assertBase58Address(value, "recent_blockhash");
  assert(base58Decode(value).length === 32, "recent_blockhash must decode to 32 bytes");
  return value;
}

function assertBytes32(value, label) {
  const raw = String(value || "").toLowerCase();
  assert(/^0x[a-f0-9]{64}$/.test(raw), `${label} must be bytes32 hex`);
  return raw;
}

function assertConfirmation(value) {
  assert(["processed", "confirmed", "finalized"].includes(value), "min_confirmation must be processed, confirmed, or finalized");
  return value;
}

function assertHttpUrl(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} is required`);
  const url = new URL(value);
  assert(url.protocol === "http:" || url.protocol === "https:", `${label} must be http(s)`);
  return url;
}

function artifactPath(options) {
  if (options.out) return path.resolve(options.out);
  const action = options.action ? normalizeAction(options.action) : "action";
  return path.resolve(DEFAULT_OUT_DIR, `production-lifecycle-${action}.json`);
}

function encodeUnsignedTransaction(message) {
  return Buffer.concat([
    encodeShortVectorLength(1),
    Buffer.alloc(64, 0),
    Buffer.from(message),
  ]);
}

async function defaultRpcCall(rpcUrl, method, params) {
  assert(typeof fetch === "function", "global fetch is required for production RPC reads");
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "Solana RPC error");
  return payload.result;
}

function loadSignedProductionIntent(file) {
  const signed = loadJson(file);
  const verified = verifySignedSolanaIntent(signed);
  assert(verified.ok === true, "signed production intent signature is invalid");
  const message = signed.intent && signed.intent.message || {};
  assert(message.cluster === DEFAULT_CLUSTER, "signed intent must target solana-mainnet-beta");
  assert(message.amount === DEFAULT_AMOUNT_BASE_UNITS, "signed intent amount must be exactly 10000000");
  assert(signed.intent.chain_reward && signed.intent.chain_reward.decimals === DEFAULT_DECIMALS, "signed intent must use 6-decimal USDC");
  assert(verified.signer === message.buyer, "signed intent signer must be the buyer");
  return { signed, verified };
}

async function resolveBlockhash(options, rpcCall) {
  const commitment = assertConfirmation(options.minConfirmation || DEFAULT_COMMITMENT);
  const source = {
    calls_rpc: false,
    rpc_host: null,
    rpc_url_printed: false,
    full_rpc_url_persisted: false,
    min_confirmation: commitment,
  };
  if (options.productionRpcUrl) {
    const url = assertHttpUrl(options.productionRpcUrl, "production_rpc_url");
    if (!options.allowTestRpcHost && TEST_RPC_HOST_RE.test(url.host)) {
      throw new Error("production RPC host must not look like devnet/testnet/local/example");
    }
    const latest = await rpcCall(options.productionRpcUrl, "getLatestBlockhash", [{ commitment }]);
    source.calls_rpc = true;
    source.rpc_host = url.host;
    return {
      recentBlockhash: assertBlockhash(latest.value && latest.value.blockhash),
      source,
    };
  }
  return {
    recentBlockhash: assertBlockhash(options.recentBlockhash),
    source,
  };
}

function validateActionInputs(action, signed, options) {
  const message = signed.intent.message;
  const taskAccount = assertSolanaAddress(options.taskAccount, "task_account");
  const signer = assertSolanaAddress(options.signer, "signer");
  const role = signerRoleForAction(action);
  if (action === "attest") {
    assert(signer === message.verifier, "attest signer must match signed intent verifier");
    assertBytes32(options.resultHash, "result_hash");
    const verdict = String(options.verdict || "pass").toLowerCase();
    assert(verdict === "pass" || verdict === "fail", "verdict must be pass or fail");
  }
  if (action === "release" || action === "timeout-refund") {
    assertSolanaAddress(options.destinationTokenAccount, "destination_token_account");
  }
  return {
    taskAccount,
    signer,
    signerRole: role,
  };
}

async function buildArtifact(options = {}, rpcCall = defaultRpcCall) {
  options = optionsWithEnv(options);
  const action = normalizeAction(options.action);
  const { signed, verified } = loadSignedProductionIntent(options.signedIntent);
  const message = signed.intent.message;
  const validated = validateActionInputs(action, signed, options);
  const resolved = await resolveBlockhash(options, rpcCall);
  const lifecycle = buildLifecycleInstruction(action, signed, validated.signer, {
    taskAccount: validated.taskAccount,
    resultHash: options.resultHash,
    verdict: options.verdict || "pass",
    destinationTokenAccount: options.destinationTokenAccount,
    clockSysvar: CLOCK_SYSVAR_ID,
  });
  const compiled = compileLegacyMessage({
    payer: validated.signer,
    recentBlockhash: resolved.recentBlockhash,
    instructions: [
      {
        name: action,
        programId: lifecycle.program_id,
        accounts: lifecycle.accounts,
        data: lifecycle.data,
      },
    ],
  });
  const messageBytes = Buffer.from(compiled.message);
  const unsignedTransaction = encodeUnsignedTransaction(messageBytes);
  const afterSend = action === "release"
    ? ["build production payout evidence with fund/claim/attest/release signatures"]
    : action === "timeout-refund"
      ? ["rerun production preflight and build a fresh intent before another attempt"]
      : [`build and submit the next ${action === "claim" ? "attest" : "release"} transaction`];
  return {
    ok: true,
    kind: "tasc.production_lifecycle_transaction",
    version: "0.1",
    generated_at: new Date().toISOString(),
    action,
    signed_intent_file: rel(options.signedIntent),
    intent_hash: signed.intent_hash,
    intent_signer: verified.signer,
    cluster: DEFAULT_CLUSTER,
    network_type: "mainnet",
    amount: {
      display: "10 USDC",
      base_units: message.amount,
    },
    token: {
      symbol: "USDC",
      mint: message.token_mint,
      decimals: DEFAULT_DECIMALS,
      production_asset: true,
    },
    program_id: lifecycle.program_id,
    task_account: lifecycle.task_account,
    buyer: message.buyer,
    verifier: message.verifier,
    signer: lifecycle.signer,
    signer_role: lifecycle.signer_role,
    recent_blockhash: resolved.recentBlockhash,
    instruction: {
      name: lifecycle.action,
      program_instruction: lifecycle.program_instruction,
      data_hex: lifecycle.data_hex,
      verdict: lifecycle.verdict,
      result_hash: action === "attest" ? assertBytes32(options.resultHash, "result_hash") : null,
      clock_sysvar: lifecycle.clock_sysvar,
      accounts: lifecycle.accounts.map((account) => ({
        pubkey: account.pubkey,
        signer: account.signer,
        writable: account.writable,
      })),
    },
    settlement: lifecycle.settlement ? {
      destination_role: lifecycle.settlement.destination_role,
      vault_token_account: lifecycle.settlement.vault_token_account,
      token_mint: lifecycle.settlement.token_mint,
      destination_token_account: lifecycle.settlement.destination_token_account,
      vault_authority: lifecycle.settlement.vault_authority,
      vault_authority_bump: lifecycle.settlement.vault_authority_bump,
      token_program_id: lifecycle.settlement.token_program_id,
    } : null,
    account_keys: compiled.accountKeys.map((account) => ({
      pubkey: account.pubkey,
      signer: account.signer,
      writable: account.writable,
    })),
    wallet_payload: {
      format: "tasc.solana_wallet_transaction.v0",
      signer: lifecycle.signer,
      signer_role: lifecycle.signer_role,
      recent_blockhash: resolved.recentBlockhash,
      message_bytes: Array.from(messageBytes),
      message_base64: messageBytes.toString("base64"),
      message_sha256: `sha256:${sha256Hex(messageBytes)}`,
      unsigned_transaction_bytes: Array.from(unsignedTransaction),
      unsigned_transaction_base64: unsignedTransaction.toString("base64"),
      unsigned_transaction_base64url: base64Url(unsignedTransaction),
      unsigned_transaction_sha256: `sha256:${sha256Hex(unsignedTransaction)}`,
      placeholder_signatures: 1,
    },
    next: {
      submit_with_wallet: true,
      capture_signature_as: `${action}-signature`,
      after_send: afterSend,
    },
    source: {
      built_by: "bin/build-production-lifecycle-transaction.js",
      ...envMetadata(options.envFile, [
        PRODUCTION_ENV.rpcUrl,
        PRODUCTION_ENV.buyer,
        PRODUCTION_ENV.worker,
        PRODUCTION_ENV.verifier,
        PRODUCTION_ENV.buyerUsdc,
        PRODUCTION_ENV.workerUsdc,
      ]),
      sends_transactions: false,
      accepts_private_keys: false,
      key_material_printed: false,
      calls_rpc: resolved.source.calls_rpc,
      rpc_host: resolved.source.rpc_host,
      rpc_url_printed: false,
      full_rpc_url_persisted: false,
      min_confirmation: resolved.source.min_confirmation,
      no_new_dependencies: true,
    },
  };
}

function validateArtifact(artifact) {
  assert(artifact && typeof artifact === "object", "artifact must be a JSON object");
  assert(artifact.kind === "tasc.production_lifecycle_transaction", "artifact kind mismatch");
  assert(artifact.version === "0.1", "artifact version mismatch");
  const action = normalizeAction(artifact.action);
  assert(artifact.cluster === DEFAULT_CLUSTER, "artifact cluster must be solana-mainnet-beta");
  assert(artifact.network_type === "mainnet", "network_type must be mainnet");
  assert(artifact.amount && artifact.amount.base_units === DEFAULT_AMOUNT_BASE_UNITS, "artifact amount must be exactly 10000000");
  assert(artifact.token && artifact.token.decimals === DEFAULT_DECIMALS, "token decimals must be 6");
  assert(artifact.token.production_asset === true, "token must be marked as production asset");
  assertSolanaAddress(artifact.program_id, "program_id");
  assertSolanaAddress(artifact.task_account, "task_account");
  assertSolanaAddress(artifact.buyer, "buyer");
  assertSolanaAddress(artifact.verifier, "verifier");
  assertSolanaAddress(artifact.signer, "signer");
  assert(artifact.intent_signer === artifact.buyer, "intent signer must be buyer");
  assert(artifact.signer_role === signerRoleForAction(action), "signer role mismatch");
  assertBlockhash(artifact.recent_blockhash);
  const instruction = artifact.instruction || {};
  assert(instruction.name === action, "instruction action mismatch");
  if (action === "claim") {
    assert(instruction.program_instruction === "claim", "claim program instruction mismatch");
    assert(instruction.data_hex === "0x01", "claim data mismatch");
    assert(instruction.clock_sysvar === CLOCK_SYSVAR_ID, "claim must include Clock sysvar");
  }
  if (action === "attest") {
    assert(instruction.program_instruction === "attest", "attest program instruction mismatch");
    assert(/^0x02(00|01)[a-f0-9]{64}$/.test(instruction.data_hex), "attest data mismatch");
    assertBytes32(instruction.result_hash, "instruction.result_hash");
    assert(artifact.signer === artifact.verifier, "attest signer must match verifier");
  }
  if (action === "release") {
    assert(instruction.program_instruction === "release", "release program instruction mismatch");
    assert(instruction.data_hex === "0x03", "release data mismatch");
    assert(artifact.settlement, "release settlement is required");
    assert(artifact.settlement.destination_role === "worker", "release destination role must be worker");
    assertSolanaAddress(artifact.settlement.destination_token_account, "settlement.destination_token_account");
    assert(artifact.settlement.token_program_id === TOKEN_PROGRAM_ID, "release token program mismatch");
  }
  if (action === "timeout-refund") {
    assert(instruction.program_instruction === "refund", "timeout-refund program instruction mismatch");
    assert(instruction.data_hex === "0x04", "timeout-refund data mismatch");
    assert(instruction.clock_sysvar === CLOCK_SYSVAR_ID, "timeout-refund must include Clock sysvar");
    assert(artifact.signer === artifact.buyer, "timeout-refund signer must match buyer");
    assert(artifact.settlement, "timeout-refund settlement is required");
    assert(artifact.settlement.destination_role === "buyer", "timeout-refund destination role must be buyer");
    assertSolanaAddress(artifact.settlement.destination_token_account, "settlement.destination_token_account");
    assert(artifact.settlement.token_program_id === TOKEN_PROGRAM_ID, "timeout-refund token program mismatch");
  }
  const payload = artifact.wallet_payload || {};
  assert(payload.signer === artifact.signer, "wallet payload signer mismatch");
  assert(payload.signer_role === artifact.signer_role, "wallet payload signer role mismatch");
  assert(payload.recent_blockhash === artifact.recent_blockhash, "wallet payload blockhash mismatch");
  assert(Array.isArray(payload.message_bytes) && payload.message_bytes.length > 0, "wallet payload message bytes required");
  assert(Array.isArray(payload.unsigned_transaction_bytes) && payload.unsigned_transaction_bytes.length === payload.message_bytes.length + 65, "unsigned transaction bytes size mismatch");
  const message = Buffer.from(payload.message_bytes);
  const unsigned = Buffer.from(payload.unsigned_transaction_bytes);
  assert(payload.message_base64 === message.toString("base64"), "message base64 mismatch");
  assert(payload.unsigned_transaction_base64 === unsigned.toString("base64"), "unsigned transaction base64 mismatch");
  assert(payload.message_sha256 === `sha256:${sha256Hex(message)}`, "message sha256 mismatch");
  assert(payload.unsigned_transaction_sha256 === `sha256:${sha256Hex(unsigned)}`, "unsigned transaction sha256 mismatch");
  assert(artifact.source && artifact.source.sends_transactions === false, "builder must not send transactions");
  assert(artifact.source.accepts_private_keys === false, "builder must not accept private keys");
  assert(artifact.source.key_material_printed === false, "builder must not print key material");
  assert(artifact.source.rpc_url_printed === false, "builder must not print full RPC URL");
  assert(artifact.source.full_rpc_url_persisted === false, "builder must not persist full RPC URL");
  const text = JSON.stringify(artifact);
  assert(!text.includes("credential="), "artifact must not persist RPC query strings");
  assert(!text.includes("/sensitive/rpc"), "artifact must not persist full RPC paths");
  return {
    ok: true,
    kind: "tasc.production_lifecycle_transaction.validation",
    version: "0.1",
    action,
    wallet_payload_valid: true,
    sends_transactions: false,
    accepts_private_keys: false,
    no_new_dependencies: true,
  };
}

async function build(options, rpcCall = defaultRpcCall) {
  options = optionsWithEnv(options);
  const artifact = await buildArtifact(options, rpcCall);
  validateArtifact(artifact);
  const out = artifactPath(options);
  writeJson(out, artifact);
  return {
    ok: true,
    kind: "tasc.production_lifecycle_transaction.build_result",
    version: "0.1",
    action: artifact.action,
    artifact_file: rel(out),
    signer: artifact.signer,
    signer_role: artifact.signer_role,
    task_account: artifact.task_account,
    unsigned_transaction_sha256: artifact.wallet_payload.unsigned_transaction_sha256,
    sends_transactions: false,
    accepts_private_keys: false,
    key_material_printed: false,
    calls_rpc: artifact.source.calls_rpc,
    rpc_host: artifact.source.rpc_host,
    rpc_url_printed: false,
    full_rpc_url_persisted: false,
    no_new_dependencies: true,
  };
}

function plan(options = {}) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  return {
    ok: true,
    kind: "tasc.production_lifecycle_transaction.plan",
    version: "0.1",
    goal: "build unsigned mainnet wallet transactions for claim, attest, release, and timeout refund",
    default_signed_intent: options.signedIntent || DEFAULT_SIGNED_INTENT,
    default_env_file: envFile,
    default_output_pattern: ".tascverifier/production-lifecycle-<action>.json",
    cluster: DEFAULT_CLUSTER,
    network_type: "mainnet",
    sends_transactions: false,
    accepts_private_keys: false,
    key_material_printed: false,
    calls_rpc: false,
    writes_files: false,
    required_inputs: [
      "verified signed mainnet buyer intent",
      "task account from real:fund",
      "worker signer from --signer or env for claim and release",
      "verifier signer from --signer or env plus result hash for attest",
      "worker destination USDC token account from --destination-token-account or env for release",
      "buyer destination USDC token account from --destination-token-account or env for timeout-refund",
      "either --production-rpc-url/env RPC or --recent-blockhash",
    ],
    commands: {
      claim: `npm run real:lifecycle:build -- --env ${envFile} --action claim --signed-intent .tascverifier/production-intent/production-intent.signature.json --task-account <task-account>`,
      attest: `npm run real:lifecycle:build -- --env ${envFile} --action attest --signed-intent .tascverifier/production-intent/production-intent.signature.json --task-account <task-account> --verdict pass --result-hash <0x-result-hash>`,
      release: `npm run real:lifecycle:build -- --env ${envFile} --action release --signed-intent .tascverifier/production-intent/production-intent.signature.json --task-account <task-account>`,
      timeout_refund: `npm run real:lifecycle:build -- --env ${envFile} --action timeout-refund --signed-intent .tascverifier/production-intent/production-intent.signature.json --task-account <task-account>`,
      validate: "npm run real:lifecycle:validate -- .tascverifier/production-lifecycle-claim.json",
    },
    notes: [
      "The RPC path is read-only and only stores the RPC host, never the full URL.",
      "Each output is unsigned; submit it through the required role wallet and capture the returned signature.",
      "This covers the happy-path production sequence required by real:readiness: claim, attest pass, release, plus timeout refund recovery for expired funded tasks.",
    ],
  };
}

function sampleAddress(byte) {
  return base58Encode(Buffer.alloc(32, byte));
}

function signedIntentFixture(file, cluster = DEFAULT_CLUSTER) {
  const buyer = fixtureKeypair("buyer");
  const verifier = fixtureKeypair("verifier");
  const programId = sampleAddress(41);
  const tokenMint = sampleAddress(42);
  const { intent } = createSolanaIntent("examples/summarize_url.tasc", {
    buyer: buyer.address,
    verifier: verifier.address,
    programId,
    tokenMint,
    now: 1800000000,
    nonce: "5151",
    decimals: DEFAULT_DECIMALS,
    cluster,
    inputs: { url: "https://docs.cdp.coinbase.com/x402/welcome" },
  });
  const signed = signSolanaIntent(intent, buyer);
  writeJson(file, signed);
  return { signed, buyer, verifier, programId, tokenMint };
}

function mockRpcCall() {
  return async (_rpcUrl, method) => {
    if (method === "getLatestBlockhash") {
      return {
        value: {
          blockhash: sampleAddress(50),
          lastValidBlockHeight: 123456,
        },
      };
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
}

async function selfTest() {
  fs.mkdirSync(path.join(ROOT, ".tascverifier"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, ".tascverifier", "production-lifecycle-tx-"));
  const signedFile = path.join(dir, "production-intent.signature.json");
  const fixture = signedIntentFixture(signedFile);
  const taskAccount = fundAddresses(fixture.signed.intent.message).task_account;
  const worker = sampleAddress(43);
  const destination = sampleAddress(44);
  const buyerDestination = sampleAddress(45);
  const resultHash = `0x${"12".repeat(32)}`;
  const rpcUrl = "https://mainnet.example.com/sensitive/rpc?credential=do-not-store";
  const envFile = path.join(dir, ".env.solana-mainnet.local");
  fs.writeFileSync(envFile, [
    `${PRODUCTION_ENV.rpcUrl}=${rpcUrl}`,
    `${PRODUCTION_ENV.buyer}=${fixture.buyer.address}`,
    `${PRODUCTION_ENV.worker}=${worker}`,
    `${PRODUCTION_ENV.verifier}=${fixture.verifier.address}`,
    `${PRODUCTION_ENV.workerUsdc}=${destination}`,
    `${PRODUCTION_ENV.buyerUsdc}=${buyerDestination}`,
    "",
  ].join("\n"));
  const noRpcEnvFile = path.join(dir, "worker-only.env");
  fs.writeFileSync(noRpcEnvFile, [
    `${PRODUCTION_ENV.buyer}=${fixture.buyer.address}`,
    `${PRODUCTION_ENV.worker}=${worker}`,
    `${PRODUCTION_ENV.workerUsdc}=${destination}`,
    `${PRODUCTION_ENV.buyerUsdc}=${buyerDestination}`,
    "",
  ].join("\n"));
  const planResult = plan();
  assert(planResult.sends_transactions === false, "plan must not send transactions");
  assert(planResult.calls_rpc === false, "plan must not call RPC");
  assert(planResult.writes_files === false, "plan must not write files");

  const claim = await build({
    envFile,
    action: "claim",
    signedIntent: signedFile,
    taskAccount,
    signer: "",
    productionRpcUrl: "",
    out: path.join(dir, "production-lifecycle-claim.json"),
    allowTestRpcHost: true,
  }, mockRpcCall());
  assert(claim.ok === true, "claim build should succeed");
  const claimArtifact = loadJson(path.join(dir, "production-lifecycle-claim.json"));
  assert(claimArtifact.signer === worker, "claim should load signer from env");
  assert(claimArtifact.source.rpc_host === "mainnet.example.com", "claim should only store RPC host");
  validateArtifact(claimArtifact);

  const attest = await build({
    action: "attest",
    signedIntent: signedFile,
    taskAccount,
    signer: fixture.verifier.address,
    verdict: "pass",
    resultHash,
    recentBlockhash: sampleAddress(51),
    out: path.join(dir, "production-lifecycle-attest.json"),
    productionRpcUrl: rpcUrl,
    allowTestRpcHost: true,
  }, mockRpcCall());
  assert(attest.ok === true, "attest build should succeed");
  validateArtifact(loadJson(path.join(dir, "production-lifecycle-attest.json")));

  const release = await build({
    envFile: noRpcEnvFile,
    action: "release",
    signedIntent: signedFile,
    taskAccount,
    signer: "",
    destinationTokenAccount: "",
    recentBlockhash: sampleAddress(52),
    out: path.join(dir, "production-lifecycle-release.json"),
    allowTestRpcHost: true,
  }, mockRpcCall());
  assert(release.ok === true, "release build should succeed");
  const releaseArtifact = loadJson(path.join(dir, "production-lifecycle-release.json"));
  assert(releaseArtifact.settlement.destination_token_account === destination, "release destination mismatch");
  assert(releaseArtifact.signer === worker, "release should load signer from env");
  validateArtifact(releaseArtifact);

  const timeoutRefund = await build({
    envFile: noRpcEnvFile,
    action: "timeout-refund",
    signedIntent: signedFile,
    taskAccount,
    signer: "",
    destinationTokenAccount: "",
    recentBlockhash: sampleAddress(53),
    out: path.join(dir, "production-lifecycle-timeout-refund.json"),
    allowTestRpcHost: true,
  }, mockRpcCall());
  assert(timeoutRefund.ok === true, "timeout refund build should succeed");
  const timeoutRefundArtifact = loadJson(path.join(dir, "production-lifecycle-timeout-refund.json"));
  assert(timeoutRefundArtifact.signer === fixture.buyer.address, "timeout refund should load buyer signer from env");
  assert(timeoutRefundArtifact.settlement.destination_token_account === buyerDestination, "timeout refund destination mismatch");
  assert(timeoutRefundArtifact.instruction.clock_sysvar === CLOCK_SYSVAR_ID, "timeout refund should include Clock sysvar");
  validateArtifact(timeoutRefundArtifact);

  let rejectedDevnet = false;
  const devnetFile = path.join(dir, "devnet.signature.json");
  signedIntentFixture(devnetFile, "devnet");
  try {
    await buildArtifact({
      action: "claim",
      signedIntent: devnetFile,
      taskAccount,
      signer: worker,
      recentBlockhash: sampleAddress(54),
    });
  } catch {
    rejectedDevnet = true;
  }
  assert(rejectedDevnet, "devnet signed intents should be rejected");

  let rejectedBadAttestSigner = false;
  try {
    await buildArtifact({
      action: "attest",
      signedIntent: signedFile,
      taskAccount,
      signer: worker,
      verdict: "pass",
      resultHash,
      recentBlockhash: sampleAddress(55),
    });
  } catch {
    rejectedBadAttestSigner = true;
  }
  assert(rejectedBadAttestSigner, "attest signer must be verifier");

  let rejectedMissingReleaseDestination = false;
  const previousProcessRpc = process.env[PRODUCTION_ENV.rpcUrl];
  const previousProcessWorkerUsdc = process.env[PRODUCTION_ENV.workerUsdc];
  delete process.env[PRODUCTION_ENV.rpcUrl];
  delete process.env[PRODUCTION_ENV.workerUsdc];
  try {
    await buildArtifact({
      envFile: path.join(dir, "missing-release-destination.env"),
      action: "release",
      signedIntent: signedFile,
      taskAccount,
      signer: worker,
      recentBlockhash: sampleAddress(56),
    });
  } catch {
    rejectedMissingReleaseDestination = true;
  } finally {
    if (previousProcessRpc === undefined) delete process.env[PRODUCTION_ENV.rpcUrl];
    else process.env[PRODUCTION_ENV.rpcUrl] = previousProcessRpc;
    if (previousProcessWorkerUsdc === undefined) delete process.env[PRODUCTION_ENV.workerUsdc];
    else process.env[PRODUCTION_ENV.workerUsdc] = previousProcessWorkerUsdc;
  }
  assert(rejectedMissingReleaseDestination, "release destination should be required");

  const claimText = fs.readFileSync(path.join(dir, "production-lifecycle-claim.json"), "utf8");
  assert(!claimText.includes("do-not-store"), "artifact must not store RPC query credential");
  assert(!claimText.includes("/sensitive/rpc"), "artifact must not store full RPC path");

  return {
    ok: true,
    self_test: true,
    plan_safe: true,
    claim_build: true,
    attest_build: true,
    release_build: true,
    timeout_refund_build: true,
    rejected_devnet: rejectedDevnet,
    rejected_bad_attest_signer: rejectedBadAttestSigner,
    rejected_missing_release_destination: rejectedMissingReleaseDestination,
    sends_transactions: false,
    accepts_private_keys: false,
    rpc_url_persisted: false,
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
    process.stdout.write(`${JSON.stringify(await build(options), null, 2)}\n`);
    return;
  }
  if (options.command === "validate") {
    assert(options.artifactFile, "validate requires an artifact file");
    process.stdout.write(`${JSON.stringify(validateArtifact(loadJson(options.artifactFile)), null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`build-production-lifecycle-transaction: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  build,
  buildArtifact,
  plan,
  selfTest,
  validateArtifact,
};
