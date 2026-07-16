#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { canonicalize } = require("./tasclang");
const {
  createSolanaIntent,
  fixtureKeypair,
  signSolanaIntent,
  verifySignedSolanaIntent,
} = require("./tascsolana");
const { assertBase58Address, base58Decode, base58Encode } = require("./run-solana-devnet");
const {
  DEFAULT_ENV_FILE,
  PRODUCTION_ENV,
  envMetadata,
  withProductionEnv,
} = require("./production-env");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_TASK_FILE = "examples/summarize_url.tasc";
const DEFAULT_OUT_DIR = ".tascverifier/production-intent";
const DEFAULT_CLUSTER = "solana-mainnet-beta";
const DEFAULT_DECIMALS = 6;
const DEFAULT_INPUT = "url=https://docs.cdp.coinbase.com/x402/welcome";
const MAINNET_NETWORK_TYPE = "mainnet";

function usage() {
  console.error([
    "Usage:",
    "  node bin/build-production-intent.js plan [options]",
    "  node bin/build-production-intent.js build [task.tasc] [options]",
    "  node bin/build-production-intent.js attach-signature --intent <intent.json> --signature <base58> [--out <signed.json>]",
    "  node bin/build-production-intent.js --self-test",
    "",
    "Build options:",
    "  --env <file>                production env file; default .env.solana-mainnet.local",
    "  --out-dir <dir>             output directory; default .tascverifier/production-intent",
    "  --buyer <address>           mainnet buyer wallet address",
    "  --verifier <address>        mainnet verifier wallet address",
    "  --program-id <address>      deployed mainnet Global Tasc program id",
    "  --token-mint <address>      verified mainnet USDC mint",
    "  --input name=value          task input; repeatable",
    "  --now <unix>                generated_at_unix; default current time",
    "  --nonce <n>                 unique nonce; default current unix-ms timestamp",
    "  --decimals <n>              token decimals; default 6",
    "",
    "This tool never accepts private keys. Sign the canonical payload with a wallet, then attach the base58 signature.",
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
    taskFile: DEFAULT_TASK_FILE,
    outDir: DEFAULT_OUT_DIR,
    intentFile: "",
    signature: "",
    out: "",
    buyer: "",
    verifier: "",
    programId: "",
    tokenMint: "",
    inputs: {},
    now: "",
    nonce: "",
    decimals: DEFAULT_DECIMALS,
    selfTest: false,
  };
  const args = [...argv];
  if (["plan", "build", "attach-signature"].includes(args[0])) options.command = args.shift();
  if (options.command === "build" && args[0] && !args[0].startsWith("--")) options.taskFile = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = requireValue(args, ++i, arg);
    else if (arg === "--out-dir") options.outDir = requireValue(args, ++i, arg);
    else if (arg === "--intent") options.intentFile = requireValue(args, ++i, arg);
    else if (arg === "--signature") options.signature = requireValue(args, ++i, arg);
    else if (arg === "--out") options.out = requireValue(args, ++i, arg);
    else if (arg === "--buyer") options.buyer = requireValue(args, ++i, arg);
    else if (arg === "--verifier") options.verifier = requireValue(args, ++i, arg);
    else if (arg === "--program-id") options.programId = requireValue(args, ++i, arg);
    else if (arg === "--token-mint") options.tokenMint = requireValue(args, ++i, arg);
    else if (arg === "--input") {
      const [name, ...valueParts] = String(requireValue(args, ++i, arg)).split("=");
      assert(name && valueParts.length > 0, "--input must use name=value");
      options.inputs[name] = valueParts.join("=");
    } else if (arg === "--now") options.now = requireValue(args, ++i, arg);
    else if (arg === "--nonce") options.nonce = requireValue(args, ++i, arg);
    else if (arg === "--decimals") options.decimals = Number(requireValue(args, ++i, arg));
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

function optionsWithEnv(options = {}) {
  return withProductionEnv(options, {
    buyer: PRODUCTION_ENV.buyer,
    verifier: PRODUCTION_ENV.verifier,
    programId: PRODUCTION_ENV.programId,
    tokenMint: PRODUCTION_ENV.tokenMint,
  });
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function writeJson(file, value) {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertUint(value, label) {
  const raw = String(value ?? "");
  assert(/^\d+$/.test(raw), `${label} must be an integer string`);
  return raw;
}

function assertSolanaAddress(value, label) {
  assertBase58Address(value, label);
  assert(base58Decode(value).length === 32, `${label} must decode to 32 bytes`);
  return value;
}

function assertSignature(value, label) {
  const raw = String(value || "");
  assert(/^[1-9A-HJ-NP-Za-km-z]{40,100}$/.test(raw), `${label} must look like a Solana signature`);
  assert(base58Decode(raw).length === 64, `${label} must decode to a 64-byte Solana signature`);
  return raw;
}

function currentUnix() {
  return Math.floor(Date.now() / 1000);
}

function currentNonce() {
  return String(Date.now());
}

function defaultInputs(inputs) {
  if (Object.keys(inputs).length > 0) return inputs;
  const [name, ...valueParts] = DEFAULT_INPUT.split("=");
  return { [name]: valueParts.join("=") };
}

function buildUnsignedIntent(options = {}) {
  options = optionsWithEnv(options);
  assert(fs.existsSync(options.taskFile), `task file not found: ${options.taskFile}`);
  const buyer = assertSolanaAddress(options.buyer, "buyer");
  const verifier = assertSolanaAddress(options.verifier, "verifier");
  const programId = assertSolanaAddress(options.programId, "program_id");
  const tokenMint = assertSolanaAddress(options.tokenMint, "token_mint");
  assert(Number.isInteger(options.decimals) && options.decimals === DEFAULT_DECIMALS, "production USDC decimals must be 6");
  const now = options.now ? Number(assertUint(options.now, "now")) : currentUnix();
  const nonce = options.nonce ? assertUint(options.nonce, "nonce") : currentNonce();

  const { intent } = createSolanaIntent(options.taskFile, {
    buyer,
    verifier,
    programId,
    tokenMint,
    now,
    nonce,
    decimals: options.decimals,
    cluster: DEFAULT_CLUSTER,
    inputs: defaultInputs(options.inputs || {}),
  });

  assert(intent.message.cluster === DEFAULT_CLUSTER, "production Solana intent must target solana-mainnet-beta");
  assert(intent.chain_reward.amount === "10000000", "production MVP intent must be exactly 10 USDC base units");
  assert(intent.chain_reward.decimals === DEFAULT_DECIMALS, "production MVP intent must use 6-decimal USDC");

  const signingPayload = canonicalize(intent);
  return {
    intent: {
      ...intent,
      network_type: MAINNET_NETWORK_TYPE,
      signing: {
        scheme: "ed25519",
        payload_encoding: "utf8",
        payload_canonicalization: "tasc.canonical_json.v0",
        payload_sha256: `sha256:${sha256Hex(signingPayload)}`,
      },
    },
    signingPayload,
  };
}

function artifactPaths(outDir) {
  const dir = path.resolve(outDir || DEFAULT_OUT_DIR);
  return {
    dir,
    intent: path.join(dir, "production-intent.intent.json"),
    payload: path.join(dir, "production-intent.signing-payload.json"),
    payloadBase64: path.join(dir, "production-intent.signing-payload.base64.txt"),
    summary: path.join(dir, "production-intent.summary.json"),
    signed: path.join(dir, "production-intent.signature.json"),
  };
}

function build(options = {}) {
  options = optionsWithEnv(options);
  const { intent, signingPayload } = buildUnsignedIntent(options);
  const paths = artifactPaths(options.outDir);
  const payloadBytes = Buffer.from(signingPayload, "utf8");
  const summary = {
    ok: true,
    kind: "tasc.production_intent.build_result",
    version: "0.1",
    cluster: DEFAULT_CLUSTER,
    network_type: MAINNET_NETWORK_TYPE,
    task_file: options.taskFile,
    intent_file: path.relative(ROOT, paths.intent),
    signing_payload_file: path.relative(ROOT, paths.payload),
    signing_payload_base64_file: path.relative(ROOT, paths.payloadBase64),
    buyer: intent.message.buyer,
    verifier: intent.message.verifier,
    program_id: intent.message.program_id,
    token_mint: intent.message.token_mint,
    amount: intent.message.amount,
    deadline_unix: intent.message.deadline_unix,
    nonce: intent.message.nonce,
    signing_payload_sha256: intent.signing.payload_sha256,
    signing_payload_bytes: payloadBytes.length,
    source: {
      built_by: "bin/build-production-intent.js",
      ...envMetadata(options.envFile, [
        PRODUCTION_ENV.buyer,
        PRODUCTION_ENV.verifier,
        PRODUCTION_ENV.programId,
        PRODUCTION_ENV.tokenMint,
      ]),
    },
    sends_transactions: false,
    accepts_private_keys: false,
    key_material_printed: false,
    no_new_dependencies: true,
  };

  writeJson(paths.intent, intent);
  writeFile(paths.payload, signingPayload);
  writeFile(paths.payloadBase64, `${payloadBytes.toString("base64")}\n`);
  writeJson(paths.summary, summary);
  return summary;
}

function attachSignature(options = {}) {
  assert(options.intentFile, "--intent is required");
  assert(options.signature, "--signature is required");
  const intent = loadJson(options.intentFile);
  assert(intent.kind === "tasc.intent.solana", "intent kind must be tasc.intent.solana");
  assert(intent.message && intent.message.cluster === DEFAULT_CLUSTER, "signed production intent must target solana-mainnet-beta");
  const signing = intent.signing || {};
  const intentForSignature = { ...intent };
  delete intentForSignature.signing;
  delete intentForSignature.network_type;
  const payload = canonicalize(intentForSignature);
  if (signing.payload_sha256) {
    assert(signing.payload_sha256 === `sha256:${sha256Hex(payload)}`, "intent signing payload hash mismatch");
  }
  const signed = {
    kind: "tasc.intent.signature.solana",
    version: "0.1",
    intent_hash: intent.intent_hash,
    signer: intent.message.buyer,
    buyer: intent.message.buyer,
    signature: assertSignature(options.signature, "signature"),
    intent: intentForSignature,
  };
  const verified = verifySignedSolanaIntent(signed);
  assert(verified.ok === true, "attached signature does not verify against intent buyer");

  const out = path.resolve(options.out || path.join(path.dirname(options.intentFile), "production-intent.signature.json"));
  writeJson(out, signed);
  return {
    ok: true,
    kind: "tasc.production_intent.signature_result",
    version: "0.1",
    signed_intent_file: path.relative(ROOT, out),
    signer: verified.signer,
    intent_hash: signed.intent_hash,
    cluster: signed.intent.message.cluster,
    sends_transactions: false,
    accepts_private_keys: false,
    key_material_printed: false,
    signature_verified: true,
    no_new_dependencies: true,
  };
}

function plan(options = {}) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  return {
    ok: true,
    kind: "tasc.production_intent.plan",
    version: "0.1",
    goal: "create a mainnet buyer intent and exact wallet-signing payload without private keys",
    cluster: DEFAULT_CLUSTER,
    network_type: MAINNET_NETWORK_TYPE,
    default_env_file: envFile,
    default_out_dir: options.outDir || DEFAULT_OUT_DIR,
    sends_transactions: false,
    accepts_private_keys: false,
    key_material_printed: false,
    calls_rpc: false,
    writes_files: false,
    required_inputs: [
      "task file",
      "mainnet buyer wallet address",
      "mainnet verifier wallet address",
      "deployed mainnet Global Tasc program id",
      "verified mainnet USDC mint",
      "task input values",
      "unique nonce",
    ],
    commands: {
      build_unsigned_intent: `npm run real:intent:build -- examples/summarize_url.tasc --env ${envFile} --input url=<url>`,
      attach_wallet_signature: "npm run real:intent:attach-signature -- --intent .tascverifier/production-intent/production-intent.intent.json --signature <base58-wallet-signature>",
      next_preflight: `npm run real:preflight -- --env ${envFile}`,
    },
    notes: [
      "Sign the exact UTF-8 bytes in production-intent.signing-payload.json.",
      "Use production-intent.signing-payload.base64.txt when a signing tool accepts base64 message bytes.",
      "The attach-signature command verifies the Ed25519 signature against the buyer address before writing the signed intent.",
    ],
  };
}

function sampleAddress(byte) {
  return base58Encode(Buffer.alloc(32, byte));
}

async function selfTest() {
  fs.mkdirSync(path.join(ROOT, ".tascverifier"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, ".tascverifier", "production-intent-"));
  const buyer = fixtureKeypair("buyer");
  const envFile = path.join(dir, ".env.solana-mainnet.local");
  const options = {
    envFile,
    taskFile: DEFAULT_TASK_FILE,
    outDir: dir,
    buyer: buyer.address,
    verifier: sampleAddress(8),
    programId: sampleAddress(9),
    tokenMint: sampleAddress(10),
    inputs: { url: "https://docs.cdp.coinbase.com/x402/welcome" },
    now: "1800000000",
    nonce: "42",
    decimals: DEFAULT_DECIMALS,
  };
  fs.writeFileSync(envFile, [
    `${PRODUCTION_ENV.buyer}=${buyer.address}`,
    `${PRODUCTION_ENV.verifier}=${options.verifier}`,
    `${PRODUCTION_ENV.programId}=${options.programId}`,
    `${PRODUCTION_ENV.tokenMint}=${options.tokenMint}`,
    "",
  ].join("\n"));

  const planResult = plan();
  assert(planResult.sends_transactions === false, "plan must not send transactions");
  assert(planResult.accepts_private_keys === false, "plan must not accept private keys");
  assert(planResult.calls_rpc === false, "plan must not call RPC");

  const buildResult = build(options);
  assert(buildResult.ok === true, "build should succeed");
  const paths = artifactPaths(dir);
  assert(fs.existsSync(paths.intent), "intent file should exist");
  assert(fs.existsSync(paths.payload), "signing payload should exist");
  assert(fs.existsSync(paths.payloadBase64), "base64 payload should exist");
  const payloadFromFile = fs.readFileSync(paths.payload, "utf8");
  assert(!payloadFromFile.endsWith("\n"), "signing payload file must not have a trailing newline");
  assert(`sha256:${sha256Hex(payloadFromFile)}` === buildResult.signing_payload_sha256, "signing payload file hash mismatch");

  const envOutDir = path.join(dir, "env");
  const envBuild = build({
    ...options,
    outDir: envOutDir,
    buyer: "",
    verifier: "",
    programId: "",
    tokenMint: "",
  });
  assert(envBuild.buyer === buyer.address, "env build should load buyer");
  assert(envBuild.verifier === options.verifier, "env build should load verifier");
  assert(envBuild.program_id === options.programId, "env build should load program id");
  assert(envBuild.token_mint === options.tokenMint, "env build should load token mint");
  assert(envBuild.source.env_file_exists === true, "env build should report env file");

  const unsignedIntent = loadJson(paths.intent);
  const intentForSigning = { ...unsignedIntent };
  delete intentForSigning.signing;
  delete intentForSigning.network_type;
  const signedByFixture = signSolanaIntent(intentForSigning, buyer);
  const attached = attachSignature({
    intentFile: paths.intent,
    signature: signedByFixture.signature,
    out: paths.signed,
  });
  assert(attached.signature_verified === true, "attached signature should verify");

  let rejectedBadSignature = false;
  try {
    attachSignature({
      intentFile: paths.intent,
      signature: base58Encode(Buffer.alloc(64, 1)),
      out: path.join(dir, "bad.signature.json"),
    });
  } catch {
    rejectedBadSignature = true;
  }
  assert(rejectedBadSignature, "bad signature should be rejected");

  return {
    ok: true,
    self_test: true,
    build_unsigned_intent: true,
    build_unsigned_intent_from_env: true,
    attach_signature: true,
    rejected_bad_signature: rejectedBadSignature,
    no_private_keys_required: true,
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
  if (options.command === "attach-signature") {
    process.stdout.write(`${JSON.stringify(attachSignature(options), null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`build-production-intent: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  attachSignature,
  build,
  buildUnsignedIntent,
  plan,
  selfTest,
};
