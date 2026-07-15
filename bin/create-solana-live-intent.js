#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  DEFAULT_RPC_URL,
  base58Encode,
  keypairForRole,
  mergedEnv,
} = require("./run-solana-devnet");
const {
  createSolanaIntent,
  signSolanaIntent,
} = require("./tascsolana");
const { SYSTEM_PROGRAM_ID } = require("./run-solana-fund");

const DEFAULT_ENV_FILE = ".env.solana-devnet.local";
const DEFAULT_TASK_FILE = "examples/summarize_url.tasc";
const DEFAULT_OUT_DIR = "examples/solana-devnet";
const DEFAULT_PROGRAM_KEYPAIR = "build/solana/global_tasc_solana_program-keypair.json";
const DEFAULT_NOW = 1800000000;

function usage() {
  console.error([
    "Usage:",
    "  node bin/create-solana-live-intent.js [task.tasc] [--env file] [--out-dir dir] [--program-id address] [--token-mint address] [--now unix]",
    "",
    "Creates public signed intent files from local devnet keys. It never prints key material.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseOptions(rest) {
  const options = {
    taskFile: DEFAULT_TASK_FILE,
    envFile: DEFAULT_ENV_FILE,
    outDir: DEFAULT_OUT_DIR,
    programId: null,
    tokenMint: null,
    now: DEFAULT_NOW,
  };
  const args = [...rest];
  if (args[0] && !args[0].startsWith("--")) options.taskFile = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = args[++i];
    else if (arg === "--out-dir") options.outDir = args[++i];
    else if (arg === "--program-id") options.programId = args[++i];
    else if (arg === "--token-mint") options.tokenMint = args[++i];
    else if (arg === "--now") options.now = Number(args[++i]);
    else usage();
  }
  return options;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function addressFromKeypairFile(file) {
  if (!fs.existsSync(file)) return null;
  const parsed = loadJson(file);
  assert(Array.isArray(parsed) && parsed.length === 64, `${file} must be a 64-byte keypair`);
  return base58Encode(Buffer.from(parsed.slice(32)));
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const env = mergedEnv(options.envFile, {});
  const buyer = keypairForRole(env, "buyer");
  const verifier = env.GLOBAL_TASC_SOLANA_VERIFIER_ADDRESS || keypairForRole(env, "verifier").address;
  const programId = options.programId || addressFromKeypairFile(DEFAULT_PROGRAM_KEYPAIR);
  assert(programId, `missing program id; build ${DEFAULT_PROGRAM_KEYPAIR} or pass --program-id`);
  const tokenMint = options.tokenMint || env.GLOBAL_TASC_SOLANA_TOKEN_MINT_ADDRESS || SYSTEM_PROGRAM_ID;
  const placeholderTokenMint = tokenMint === SYSTEM_PROGRAM_ID && !options.tokenMint && !env.GLOBAL_TASC_SOLANA_TOKEN_MINT_ADDRESS;

  const { intent } = createSolanaIntent(options.taskFile, {
    buyer: buyer.address,
    verifier,
    programId,
    tokenMint,
    now: options.now,
  });
  const signed = signSolanaIntent(intent, buyer);
  const safeName = path.basename(options.taskFile).replace(/\.tasc$/, "");
  const intentFile = path.join(options.outDir, `${safeName}.intent.json`);
  const signatureFile = path.join(options.outDir, `${safeName}.signature.json`);
  writeJson(intentFile, intent);
  writeJson(signatureFile, signed);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    env_file: path.resolve(options.envFile),
    task_file: options.taskFile,
    intent_file: intentFile,
    signature_file: signatureFile,
    cluster: intent.message.cluster,
    rpc_host: new URL(env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL).host,
    program_id: programId,
    buyer: buyer.address,
    verifier,
    token_mint: tokenMint,
    placeholder_token_mint: placeholderTokenMint,
    key_material_printed: false,
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`create-solana-live-intent: ${error.message}`);
    process.exit(1);
  }
}
