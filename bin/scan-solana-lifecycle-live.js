#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  DEFAULT_RPC_URL,
  mergedEnv,
  rpcCall,
} = require("./run-solana-devnet");
const { fundAddresses } = require("./run-solana-fund");
const { verifySignedSolanaIntent } = require("./tascsolana");
const {
  compareAccountToSignedIntent,
  decodeTaskAccount,
} = require("./tascsolana-program");

const DEFAULT_ENV_FILE = ".env.solana-devnet.local";
const DEFAULT_SIGNED_INTENT = "examples/solana-devnet/summarize_url_spl.signature.json";
const DEFAULT_OUT = "examples/solana-devnet/summarize_url_spl.lifecycle-account.live.json";

function usage() {
  console.error([
    "Usage:",
    "  node bin/scan-solana-lifecycle-live.js plan [signed-solana-intent.json] [--env file] [--out file]",
    "  node bin/scan-solana-lifecycle-live.js scan [signed-solana-intent.json] [--env file] [--out file]",
    "",
    "scan is read-only: it fetches and decodes the current task-account lifecycle state.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function parseOptions(rest) {
  const options = {
    envFile: DEFAULT_ENV_FILE,
    signedFile: DEFAULT_SIGNED_INTENT,
    out: DEFAULT_OUT,
  };
  const args = [...rest];
  if (args[0] && !args[0].startsWith("--")) options.signedFile = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = args[++i];
    else if (arg === "--out") options.out = args[++i];
    else usage();
  }
  return options;
}

function loadSignedIntent(file) {
  const signed = loadJson(file);
  const signatureCheck = verifySignedSolanaIntent(signed);
  assert(signatureCheck.ok, "signed Solana intent signature is invalid");
  return signed;
}

function plan(options = {}) {
  const signed = loadSignedIntent(options.signedFile || DEFAULT_SIGNED_INTENT);
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE, {});
  const message = signed.intent.message;
  const addresses = fundAddresses(message);
  return {
    ok: true,
    mode: "plan",
    signed_intent: options.signedFile || DEFAULT_SIGNED_INTENT,
    env_file: path.resolve(options.envFile || DEFAULT_ENV_FILE),
    rpc_host: new URL(env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL).host,
    rpc_url_printed: false,
    sends_transactions: false,
    writes_files: false,
    cluster: message.cluster,
    program_id: message.program_id,
    task_account: addresses.task_account,
    out: options.out || DEFAULT_OUT,
  };
}

async function scan(options = {}) {
  const signed = loadSignedIntent(options.signedFile || DEFAULT_SIGNED_INTENT);
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE);
  const rpcUrl = env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL;
  const message = signed.intent.message;
  const addresses = fundAddresses(message);
  const result = await rpcCall(rpcUrl, "getAccountInfo", [
    addresses.task_account,
    {
      commitment: "confirmed",
      encoding: "base64",
    },
  ]);
  assert(result.value, `task account ${addresses.task_account} not found`);
  assert(Array.isArray(result.value.data), "getAccountInfo data must be [base64, encoding]");
  assert(result.value.data[1] === "base64", "getAccountInfo data encoding must be base64");

  const account = {
    kind: "tasc.solana.lifecycle_account.live",
    version: "0.1",
    signed_intent: options.signedFile || DEFAULT_SIGNED_INTENT,
    cluster: message.cluster,
    pubkey: addresses.task_account,
    owner: result.value.owner,
    executable: Boolean(result.value.executable),
    lamports: String(result.value.lamports),
    rent_epoch: String(result.value.rentEpoch ?? "0"),
    data_base64: result.value.data[0],
    context: {
      slot: String(result.context?.slot ?? "0"),
      api_version: result.context?.apiVersion || null,
    },
  };
  account.decoded = decodeTaskAccount(account.data_base64, {
    programId: account.owner,
    taskPda: account.pubkey,
  });
  account.intent_match_checks = compareAccountToSignedIntent(signed, account.decoded);
  if (options.out) writeJson(options.out, account);

  return {
    ok: true,
    mode: "scan",
    signed_intent: options.signedFile || DEFAULT_SIGNED_INTENT,
    rpc_host: new URL(rpcUrl).host,
    rpc_url_printed: false,
    sends_transactions: false,
    out: options.out || null,
    account: {
      pubkey: account.pubkey,
      owner: account.owner,
      status: account.decoded.status,
      worker: account.decoded.worker,
      verifier: account.decoded.verifier,
      result_hash: account.decoded.result_hash,
      slot: account.context.slot,
    },
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(plan(options), null, 2)}\n`);
    return;
  }
  if (command === "scan") {
    process.stdout.write(`${JSON.stringify(await scan(options), null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`scan-solana-lifecycle-live: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  plan,
  scan,
};
