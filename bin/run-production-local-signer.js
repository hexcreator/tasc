#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { canonicalize } = require("./tasclang");
const { attachSignature } = require("./build-production-intent");
const { validateArtifact: validateFundArtifact } = require("./build-production-fund-transaction");
const { validateArtifact: validateLifecycleArtifact } = require("./build-production-lifecycle-transaction");
const { validateArtifact: validateTokenAccountArtifact } = require("./build-production-token-account-setup");
const {
  assertBase58Address,
  base58Decode,
  base58Encode,
  encodeSignedTransaction,
  keypairFromNodeCrypto,
  pollSignature,
  rpcCall,
  signSolanaMessage,
} = require("./run-solana-devnet");
const {
  DEFAULT_ENV_FILE,
  PRODUCTION_ENV,
  withProductionEnv,
} = require("./production-env");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_INTENT = ".tascverifier/production-intent/production-intent.intent.json";
const DEFAULT_SIGNED_INTENT = ".tascverifier/production-intent/production-intent.signature.json";
const ALLOW_SIGN_ENV = "GLOBAL_TASC_ALLOW_PRODUCTION_LOCAL_SIGN";
const ALLOW_SEND_ENV = "GLOBAL_TASC_ALLOW_PRODUCTION_LOCAL_SEND";

function usage() {
  console.error([
    "Usage:",
    "  node bin/run-production-local-signer.js plan [options]",
    "  node bin/run-production-local-signer.js sign-intent --intent <intent.json> --keypair <role.json> [--out <signed.json>]",
    "  node bin/run-production-local-signer.js send-transaction --transaction <artifact.json> --keypair <role.json> [--env <file>] [--production-rpc-url <url>]",
    "  node bin/run-production-local-signer.js --self-test",
    "",
    "Guards:",
    `  ${ALLOW_SIGN_ENV}=1 is required for sign-intent`,
    `  ${ALLOW_SEND_ENV}=1 is required for send-transaction`,
    "",
    "This helper reads an explicit local Solana keypair file, verifies the derived public address,",
    "prints no key material, and adds no dependencies.",
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
    intent: DEFAULT_INTENT,
    out: "",
    transaction: "",
    keypair: "",
    productionRpcUrl: "",
    selfTest: false,
  };
  const args = [...argv];
  if (args[0] === "--self-test") {
    options.selfTest = true;
    return options;
  }
  if (["plan", "sign-intent", "send-transaction"].includes(args[0])) options.command = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = requireValue(args, ++i, arg);
    else if (arg === "--intent") options.intent = requireValue(args, ++i, arg);
    else if (arg === "--out") options.out = requireValue(args, ++i, arg);
    else if (arg === "--transaction") options.transaction = requireValue(args, ++i, arg);
    else if (arg === "--keypair") options.keypair = requireValue(args, ++i, arg);
    else if (arg === "--production-rpc-url") options.productionRpcUrl = requireValue(args, ++i, arg);
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
  return path.relative(ROOT, path.resolve(file));
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function requireGuard(name, action) {
  assert(process.env[name] === "1", `${name}=1 is required before ${action}`);
}

function keypairPermissions(file) {
  const stat = fs.statSync(file);
  return {
    private_to_owner: (stat.mode & 0o077) === 0,
    mode_octal: `0${(stat.mode & 0o777).toString(8)}`,
  };
}

function loadKeypair(file) {
  assert(file, "--keypair is required");
  const resolved = path.resolve(file);
  assert(fs.existsSync(resolved), `keypair file not found: ${file}`);
  const permissions = keypairPermissions(resolved);
  assert(permissions.private_to_owner, "keypair file must not be group/world readable");
  const parsed = loadJson(resolved);
  assert(Array.isArray(parsed) && parsed.length === 64, "keypair file must contain a 64-byte Solana keypair array");
  for (const [index, byte] of parsed.entries()) {
    assert(Number.isInteger(byte) && byte >= 0 && byte <= 255, `keypair byte ${index} must be 0..255`);
  }
  const bytes = Buffer.from(parsed);
  return {
    file: rel(resolved),
    seed: bytes.subarray(0, 32),
    publicKey: bytes.subarray(32, 64),
    address: base58Encode(bytes.subarray(32, 64)),
    permissions,
  };
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function assertSha256(value, bytes, label) {
  if (!value) return;
  assert(value === `sha256:${sha256Hex(bytes)}`, `${label} sha256 mismatch`);
}

function assertSolanaSignature(value, label) {
  const text = String(value || "");
  assert(/^[1-9A-HJ-NP-Za-km-z]{40,100}$/.test(text), `${label} must look like a Solana signature`);
  assert(base58Decode(text).length === 64, `${label} must decode to a 64-byte signature`);
  return text;
}

function phaseForArtifact(artifact) {
  if (artifact.kind === "tasc.production_token_account_setup_transaction") return `setup-${artifact.role}-usdc-ata`;
  if (artifact.kind === "tasc.production_fund_transaction") return "fund";
  if (artifact.kind === "tasc.production_lifecycle_transaction") return artifact.action;
  throw new Error("transaction artifact kind is not supported");
}

function validateTransactionArtifact(artifact) {
  if (artifact.kind === "tasc.production_token_account_setup_transaction") validateTokenAccountArtifact(artifact);
  else if (artifact.kind === "tasc.production_fund_transaction") validateFundArtifact(artifact);
  else if (artifact.kind === "tasc.production_lifecycle_transaction") validateLifecycleArtifact(artifact);
  else throw new Error("transaction artifact must be a production token-account, fund, or lifecycle artifact");
  return artifact;
}

function validateWalletPayload(artifact, keypair) {
  const payload = artifact.wallet_payload || {};
  assert(payload.format === "tasc.solana_wallet_transaction.v0", "wallet payload format mismatch");
  assert(payload.signer === keypair.address, "local keypair address does not match wallet payload signer");
  assert(payload.placeholder_signatures === 1, "wallet payload must contain one placeholder signature");
  assertBase58Address(payload.signer, "wallet payload signer");
  const messageBytes = Buffer.from(payload.message_bytes || []);
  const unsignedBytes = Buffer.from(payload.unsigned_transaction_bytes || []);
  assert(messageBytes.length > 0, "wallet payload message bytes are required");
  assert(unsignedBytes.length === messageBytes.length + 65, "unsigned transaction byte length mismatch");
  assert(payload.message_base64 === messageBytes.toString("base64"), "message base64 mismatch");
  assert(payload.unsigned_transaction_base64 === unsignedBytes.toString("base64"), "unsigned transaction base64 mismatch");
  assertSha256(payload.message_sha256, messageBytes, "message");
  assertSha256(payload.unsigned_transaction_sha256, unsignedBytes, "unsigned transaction");
  return { payload, messageBytes };
}

function captureCommand(phase, transactionFile, signature, timestamps = {}) {
  if (String(phase).startsWith("setup-")) return "npm run real:preflight -- --env .env.solana-mainnet.local";
  if (phase === "timeout-refund") return "npm run real:preflight -- --env .env.solana-mainnet.local";
  const parts = [
    "npm run real:capture:record --",
    `--transaction ${transactionFile}`,
    `--signature ${signature}`,
  ];
  if (phase === "claim") parts.push(`--claim-started-at ${timestamps.sendStartedAt}`);
  if (phase === "release") {
    parts.push(`--release-confirmed-at ${timestamps.confirmedAt}`);
    parts.push(`--completed-indexed-at ${timestamps.confirmedAt}`);
  }
  return parts.join(" ");
}

function plan(options = {}) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  return {
    ok: true,
    kind: "tasc.production_local_signer.plan",
    version: "0.1",
    default_env_file: envFile,
    default_intent: DEFAULT_INTENT,
    default_signed_intent: DEFAULT_SIGNED_INTENT,
    commands: {
      sign_intent: `${ALLOW_SIGN_ENV}=1 npm run real:local:sign-intent -- --intent ${DEFAULT_INTENT} --keypair <buyer.json> --out ${DEFAULT_SIGNED_INTENT}`,
      send_transaction: `${ALLOW_SEND_ENV}=1 npm run real:local:send -- --env ${envFile} --transaction <artifact.json> --keypair <role.json>`,
    },
    safety: {
      explicit_keypair_file_required: true,
      verifies_keypair_matches_signer: true,
      keypair_file_must_be_owner_private: true,
      key_material_printed: false,
      no_new_dependencies: true,
    },
  };
}

function signIntent(options = {}) {
  requireGuard(ALLOW_SIGN_ENV, "signing a production intent locally");
  const keypair = loadKeypair(options.keypair);
  const intentFile = path.resolve(options.intent || DEFAULT_INTENT);
  const intent = loadJson(intentFile);
  assert(intent.kind === "tasc.intent.solana", "intent kind must be tasc.intent.solana");
  assert(intent.message && intent.message.buyer === keypair.address, "local keypair address does not match intent buyer");
  assert(intent.message.cluster === "solana-mainnet-beta", "intent cluster must be solana-mainnet-beta");
  const intentForSignature = { ...intent };
  delete intentForSignature.signing;
  delete intentForSignature.network_type;
  const payload = canonicalize(intentForSignature);
  if (intent.signing && intent.signing.payload_sha256) {
    assert(intent.signing.payload_sha256 === `sha256:${sha256Hex(Buffer.from(payload, "utf8"))}`, "intent signing payload hash mismatch");
  }
  const signature = base58Encode(signSolanaMessage(Buffer.from(payload, "utf8"), keypair.seed));
  assertSolanaSignature(signature, "intent signature");
  const out = path.resolve(options.out || path.join(path.dirname(intentFile), "production-intent.signature.json"));
  const attached = attachSignature({
    intentFile,
    signature,
    out,
  });
  return {
    ...attached,
    signer: keypair.address,
    keypair_file: keypair.file,
    keypair_permissions: keypair.permissions,
    key_material_printed: false,
    accepts_keypair_file: true,
    no_new_dependencies: true,
  };
}

async function sendTransaction(options = {}) {
  requireGuard(ALLOW_SEND_ENV, "sending a production transaction locally");
  options = withProductionEnv(options, { productionRpcUrl: PRODUCTION_ENV.rpcUrl });
  assert(options.productionRpcUrl, "production RPC URL is required from --production-rpc-url or env");
  const rpcHost = new URL(options.productionRpcUrl).host;
  const keypair = loadKeypair(options.keypair);
  assert(options.transaction, "--transaction is required");
  const transactionFile = path.resolve(options.transaction);
  const artifact = validateTransactionArtifact(loadJson(transactionFile));
  const phase = phaseForArtifact(artifact);
  const { messageBytes } = validateWalletPayload(artifact, keypair);
  const sendStartedAt = new Date().toISOString();
  const signature = signSolanaMessage(messageBytes, keypair.seed);
  const encoded = encodeSignedTransaction(messageBytes, signature);
  const txSignature = assertSolanaSignature(await rpcCall(options.productionRpcUrl, "sendTransaction", [
    encoded,
    {
      encoding: "base64",
      preflightCommitment: "confirmed",
      maxRetries: 5,
    },
  ]), "transaction signature");
  const status = await pollSignature(options.productionRpcUrl, txSignature);
  const confirmedAt = new Date().toISOString();
  return {
    ok: true,
    kind: "tasc.production_local_signer.send_result",
    version: "0.1",
    transaction_file: rel(transactionFile),
    phase,
    signer: keypair.address,
    signer_role: artifact.wallet_payload.signer_role,
    signature: txSignature,
    confirmation_status: status ? status.confirmationStatus : "pending",
    send_started_at: sendStartedAt,
    confirmed_at: status ? confirmedAt : "",
    capture_command: status ? captureCommand(phase, rel(transactionFile), txSignature, {
      sendStartedAt,
      confirmedAt,
    }) : "",
    rpc_host: rpcHost,
    rpc_url_printed: false,
    full_rpc_url_persisted: false,
    sends_transactions: true,
    accepts_keypair_file: true,
    key_material_printed: false,
    no_new_dependencies: true,
  };
}

function sampleAddress(byte) {
  return base58Encode(Buffer.alloc(32, byte));
}

async function selfTest() {
  const dir = fs.mkdtempSync(path.join(ROOT, ".tascverifier", "production-local-signer-"));
  const buyer = keypairFromNodeCrypto();
  const buyerKeypairFile = path.join(dir, "buyer.json");
  writeJson(buyerKeypairFile, buyer.keypair);
  fs.chmodSync(buyerKeypairFile, 0o600);
  const signedIntentFile = path.join(dir, "production-intent.signature.json");
  const { build } = require("./build-production-intent");
  build({
    taskFile: path.join(ROOT, "examples/summarize_url.tasc"),
    outDir: dir,
    buyer: buyer.address,
    verifier: sampleAddress(7),
    programId: sampleAddress(8),
    tokenMint: sampleAddress(9),
    inputs: { url: "https://docs.cdp.coinbase.com/x402/welcome" },
    now: "1800000000",
    nonce: "101",
    decimals: 6,
  });
  const previous = process.env[ALLOW_SIGN_ENV];
  process.env[ALLOW_SIGN_ENV] = "1";
  const signed = signIntent({
    intent: path.join(dir, "production-intent.intent.json"),
    keypair: buyerKeypairFile,
    out: signedIntentFile,
  });
  if (previous === undefined) delete process.env[ALLOW_SIGN_ENV];
  else process.env[ALLOW_SIGN_ENV] = previous;
  assert(signed.signature_verified === true, "signed intent should verify");

  const artifact = {
    kind: "tasc.production_lifecycle_transaction",
    version: "0.1",
    action: "claim",
    cluster: "solana-mainnet-beta",
    network_type: "mainnet",
    amount: { display: "10 USDC", base_units: "10000000" },
    token: { symbol: "USDC", mint: sampleAddress(9), decimals: 6, production_asset: true },
    program_id: sampleAddress(8),
    task_account: sampleAddress(10),
    buyer: buyer.address,
    verifier: sampleAddress(7),
    intent_signer: buyer.address,
    signer: buyer.address,
    signer_role: "worker",
    recent_blockhash: sampleAddress(11),
    instruction: {
      name: "claim",
      program_instruction: "claim",
      data_hex: "0x01",
      clock_sysvar: "SysvarC1ock11111111111111111111111111111111",
      accounts: [],
    },
    account_keys: [],
    wallet_payload: null,
    source: {
      sends_transactions: false,
      accepts_private_keys: false,
      key_material_printed: false,
      rpc_url_printed: false,
      full_rpc_url_persisted: false,
    },
  };
  const messageBytes = Buffer.from([1, 2, 3, 4, 5]);
  const unsignedTransaction = Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 0), messageBytes]);
  artifact.wallet_payload = {
    format: "tasc.solana_wallet_transaction.v0",
    signer: buyer.address,
    signer_role: "worker",
    recent_blockhash: artifact.recent_blockhash,
    message_bytes: Array.from(messageBytes),
    message_base64: messageBytes.toString("base64"),
    message_sha256: `sha256:${sha256Hex(messageBytes)}`,
    unsigned_transaction_bytes: Array.from(unsignedTransaction),
    unsigned_transaction_base64: unsignedTransaction.toString("base64"),
    unsigned_transaction_base64url: unsignedTransaction.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""),
    unsigned_transaction_sha256: `sha256:${sha256Hex(unsignedTransaction)}`,
    placeholder_signatures: 1,
  };
  const payload = validateWalletPayload(artifact, loadKeypair(buyerKeypairFile));
  assert(payload.messageBytes.length === messageBytes.length, "wallet payload should validate");
  const encoded = encodeSignedTransaction(payload.messageBytes, signSolanaMessage(payload.messageBytes, buyer.keypair.slice(0, 32)));
  assert(typeof encoded === "string" && encoded.length > 0, "signed transaction should encode");

  return {
    ok: true,
    self_test: true,
    plan_safe: plan().safety.no_new_dependencies === true,
    sign_intent: true,
    validate_wallet_payload: true,
    sign_transaction_message: true,
    key_material_printed: false,
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
  if (options.command === "sign-intent") {
    process.stdout.write(`${JSON.stringify(signIntent(options), null, 2)}\n`);
    return;
  }
  if (options.command === "send-transaction") {
    process.stdout.write(`${JSON.stringify(await sendTransaction(options), null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`run-production-local-signer: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  captureCommand,
  loadKeypair,
  plan,
  selfTest,
  sendTransaction,
  signIntent,
  validateWalletPayload,
};
