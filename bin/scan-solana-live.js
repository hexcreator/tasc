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
  decodeTaskAccount,
  fundingEvidenceFromTaskAccount,
} = require("./tascsolana-program");
const {
  TOKEN_PROGRAM_ID,
  custodyEvidenceFromVault,
  decodedTokenAccountFromFixture,
} = require("./tascsolana-spl");

const DEFAULT_ENV_FILE = ".env.solana-devnet.local";
const DEFAULT_SIGNED_INTENT = "examples/solana-devnet/summarize_url.signature.json";
const DEFAULT_ACCOUNT_OUT = "examples/solana-devnet/summarize_url.task-account.live.json";
const DEFAULT_FUNDING_OUT = "examples/solana-devnet/summarize_url.funding.live.json";

function usage() {
  console.error([
    "Usage:",
    "  node bin/scan-solana-live.js plan [signed-solana-intent.json] [--env file]",
    "  node bin/scan-solana-live.js scan [signed-solana-intent.json] [--env file] [--account-out file] [--out file]",
    "    [--signature txsig] [--instruction-index n] [--confirmation-status status]",
    "    [--custody-account token-account] [--custody-instruction-index n] [--custody-decimals n]",
    "",
    "scan is read-only: it calls getAccountInfo and writes public account/funding evidence files.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseOptions(rest) {
  const options = {
    envFile: DEFAULT_ENV_FILE,
    signedFile: DEFAULT_SIGNED_INTENT,
    accountOut: DEFAULT_ACCOUNT_OUT,
    out: DEFAULT_FUNDING_OUT,
    signature: null,
    instructionIndex: "0",
    confirmationStatus: "confirmed",
    custodyAccount: null,
    custodyInstructionIndex: null,
    custodyDecimals: null,
  };
  const args = [...rest];
  if (args[0] && !args[0].startsWith("--")) options.signedFile = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = args[++i];
    else if (arg === "--account-out") options.accountOut = args[++i];
    else if (arg === "--out") options.out = args[++i];
    else if (arg === "--signature") options.signature = args[++i];
    else if (arg === "--instruction-index") options.instructionIndex = String(args[++i]);
    else if (arg === "--confirmation-status") options.confirmationStatus = args[++i];
    else if (arg === "--custody-account") options.custodyAccount = args[++i];
    else if (arg === "--custody-instruction-index") options.custodyInstructionIndex = String(args[++i]);
    else if (arg === "--custody-decimals") options.custodyDecimals = args[++i];
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

function loadSignedIntent(file) {
  const signed = loadJson(file);
  const signatureCheck = verifySignedSolanaIntent(signed);
  assert(signatureCheck.ok, "signed Solana intent signature is invalid");
  return signed;
}

function rpcHost(envFile) {
  const env = mergedEnv(envFile, {});
  return new URL(env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL).host;
}

function plan(options = {}) {
  const signed = loadSignedIntent(options.signedFile || DEFAULT_SIGNED_INTENT);
  const message = signed.intent.message;
  const addresses = fundAddresses(message);
  return {
    ok: true,
    mode: "plan",
    signed_intent: options.signedFile || DEFAULT_SIGNED_INTENT,
    env_file: path.resolve(options.envFile || DEFAULT_ENV_FILE),
    rpc_host: rpcHost(options.envFile || DEFAULT_ENV_FILE),
    rpc_url_printed: false,
    sends_transactions: false,
    writes_files: false,
    cluster: message.cluster,
    program_id: message.program_id,
    task_account: addresses.task_account,
    expected_owner: message.program_id,
    expected_vault: addresses.vault,
    token_mint: message.token_mint,
    verifier: message.verifier,
    custody_account: options.custodyAccount || null,
    scan_outputs: {
      account: options.accountOut || DEFAULT_ACCOUNT_OUT,
      funding: options.out || DEFAULT_FUNDING_OUT,
    },
  };
}

function accountFixtureFromRpc(input) {
  const value = input.value;
  assert(value, `task account ${input.pubkey} not found`);
  assert(Array.isArray(value.data), "getAccountInfo data must be [base64, encoding]");
  assert(value.data[1] === "base64", "getAccountInfo data encoding must be base64");
  const account = {
    kind: "tasc.solana.program.account.live",
    version: "0.1",
    pubkey: input.pubkey,
    owner: value.owner,
    executable: Boolean(value.executable),
    lamports: String(value.lamports),
    rent_epoch: String(value.rentEpoch ?? "0"),
    data_base64: value.data[0],
    context: {
      slot: String(input.context?.slot ?? "0"),
      api_version: input.context?.apiVersion || null,
    },
  };
  account.decoded = decodeTaskAccount(account.data_base64, {
    programId: account.owner,
    taskPda: account.pubkey,
  });
  return account;
}

function tokenAccountFixtureFromRpc(input) {
  const value = input.value;
  assert(value, `SPL token account ${input.pubkey} not found`);
  assert(value.owner === TOKEN_PROGRAM_ID, `SPL token account ${input.pubkey} must be owned by SPL Token Program`);
  assert(Array.isArray(value.data), "getAccountInfo data must be [base64, encoding]");
  assert(value.data[1] === "base64", "getAccountInfo data encoding must be base64");
  const account = {
    kind: "tasc.solana.spl_token.account.live",
    version: "0.1",
    pubkey: input.pubkey,
    owner: value.owner,
    executable: Boolean(value.executable),
    lamports: String(value.lamports),
    rent_epoch: String(value.rentEpoch ?? "0"),
    data_base64: value.data[0],
    context: {
      slot: String(input.context?.slot ?? "0"),
      api_version: input.context?.apiVersion || null,
    },
  };
  account.decoded = decodedTokenAccountFromFixture(account);
  return account;
}

function fundingFromLiveAccount(input) {
  const account = accountFixtureFromRpc(input);
  const funding = fundingEvidenceFromTaskAccount({
    signed: input.signed,
    account,
    tx: {
      signature: input.signature || null,
      slot: account.context.slot,
      instruction_index: input.instructionIndex || "0",
      confirmation_status: input.confirmationStatus || "confirmed",
    },
  });
  return { account, funding };
}

async function scan(options = {}) {
  const signed = loadSignedIntent(options.signedFile || DEFAULT_SIGNED_INTENT);
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE);
  const rpcUrl = env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL;
  const addresses = fundAddresses(signed.intent.message);
  const result = await rpcCall(rpcUrl, "getAccountInfo", [
    addresses.task_account,
    {
      commitment: "confirmed",
      encoding: "base64",
    },
  ]);
  const { account, funding } = fundingFromLiveAccount({
    signed,
    pubkey: addresses.task_account,
    context: result.context,
    value: result.value,
    signature: options.signature,
    instructionIndex: options.instructionIndex,
    confirmationStatus: options.confirmationStatus,
  });

  let custodyAccount = null;
  if (options.custodyAccount) {
    const custodyResult = await rpcCall(rpcUrl, "getAccountInfo", [
      options.custodyAccount,
      {
        commitment: "confirmed",
        encoding: "base64",
      },
    ]);
    custodyAccount = tokenAccountFixtureFromRpc({
      pubkey: options.custodyAccount,
      context: custodyResult.context,
      value: custodyResult.value,
    });
    funding.custody = custodyEvidenceFromVault({
      signed,
      account: custodyAccount,
      vault: options.custodyAccount,
      decimals: options.custodyDecimals ?? signed.intent.chain_reward?.decimals ?? 6,
      tx: {
        signature: options.signature || null,
        slot: custodyAccount.context.slot,
        instruction_index: options.custodyInstructionIndex || options.instructionIndex || "0",
        confirmation_status: options.confirmationStatus || "confirmed",
      },
    });
  }

  if (options.accountOut) writeJson(options.accountOut, account);
  if (options.out) writeJson(options.out, funding);

  return {
    ok: true,
    mode: "scan",
    signed_intent: options.signedFile || DEFAULT_SIGNED_INTENT,
    rpc_host: new URL(rpcUrl).host,
    rpc_url_printed: false,
    sends_transactions: false,
    account_out: options.accountOut || null,
    funding_out: options.out || null,
    custody_account: custodyAccount ? {
      pubkey: custodyAccount.pubkey,
      owner: custodyAccount.decoded.owner,
      mint: custodyAccount.decoded.mint,
      amount: custodyAccount.decoded.amount,
      slot: custodyAccount.context.slot,
    } : null,
    account: {
      pubkey: account.pubkey,
      owner: account.owner,
      lamports: account.lamports,
      status: account.decoded.status,
      amount: account.decoded.amount,
      slot: account.context.slot,
    },
    funding,
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
    console.error(`scan-solana-live: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  accountFixtureFromRpc,
  fundingFromLiveAccount,
  plan,
  scan,
};
