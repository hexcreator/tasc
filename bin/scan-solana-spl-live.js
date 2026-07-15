#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  DEFAULT_RPC_URL,
  mergedEnv,
  rpcCall,
} = require("./run-solana-devnet");
const {
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  decodedMintAccountFromFixture,
  decodedTokenAccountFromFixture,
} = require("./tascsolana-spl");

const DEFAULT_ENV_FILE = ".env.solana-devnet.local";
const DEFAULT_SETUP_FILE = "examples/solana-devnet/spl-setup.live.json";
const DEFAULT_OUT = "examples/solana-devnet/spl-accounts.live.json";

function usage() {
  console.error([
    "Usage:",
    "  node bin/scan-solana-spl-live.js plan [setup.json] [--env file] [--out file]",
    "  node bin/scan-solana-spl-live.js scan [setup.json] [--env file] [--out file]",
    "",
    "scan is read-only: it calls getAccountInfo and writes public decoded SPL account evidence.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseOptions(rest) {
  const options = {
    envFile: DEFAULT_ENV_FILE,
    setupFile: DEFAULT_SETUP_FILE,
    out: DEFAULT_OUT,
  };
  const args = [...rest];
  if (args[0] && !args[0].startsWith("--")) options.setupFile = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = args[++i];
    else if (arg === "--out") options.out = args[++i];
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

function rpcHost(envFile) {
  const env = mergedEnv(envFile, {});
  return new URL(env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL).host;
}

function plan(options = {}) {
  const setup = loadJson(options.setupFile || DEFAULT_SETUP_FILE);
  return {
    ok: true,
    mode: "plan",
    setup_file: options.setupFile || DEFAULT_SETUP_FILE,
    env_file: path.resolve(options.envFile || DEFAULT_ENV_FILE),
    rpc_host: rpcHost(options.envFile || DEFAULT_ENV_FILE),
    rpc_url_printed: false,
    sends_transactions: false,
    writes_files: false,
    mint: setup.mint,
    buyer_token_account: setup.buyer_token_account,
    vault_token_account: setup.vault_token_account,
    vault_authority: setup.vault_authority,
    out: options.out || DEFAULT_OUT,
  };
}

function accountFixtureFromRpc(input) {
  const value = input.value;
  assert(value, `account ${input.pubkey} not found`);
  assert(value.owner === TOKEN_PROGRAM_ID, `account ${input.pubkey} must be owned by SPL Token Program`);
  assert(Array.isArray(value.data), "getAccountInfo data must be [base64, encoding]");
  assert(value.data[1] === "base64", "getAccountInfo data encoding must be base64");
  return {
    kind: input.kind,
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
}

async function fetchAccount(rpcUrl, pubkey, kind) {
  const result = await rpcCall(rpcUrl, "getAccountInfo", [
    pubkey,
    {
      commitment: "confirmed",
      encoding: "base64",
    },
  ]);
  return accountFixtureFromRpc({
    kind,
    pubkey,
    context: result.context,
    value: result.value,
  });
}

async function scan(options = {}) {
  const setupFile = options.setupFile || DEFAULT_SETUP_FILE;
  const setup = loadJson(setupFile);
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE);
  const rpcUrl = env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL;
  const [mintAccount, buyerTokenAccount, vaultTokenAccount] = await Promise.all([
    fetchAccount(rpcUrl, setup.mint, "tasc.solana.spl_token.mint.live"),
    fetchAccount(rpcUrl, setup.buyer_token_account, "tasc.solana.spl_token.account.live"),
    fetchAccount(rpcUrl, setup.vault_token_account, "tasc.solana.spl_token.account.live"),
  ]);
  mintAccount.decoded = decodedMintAccountFromFixture(mintAccount);
  buyerTokenAccount.decoded = decodedTokenAccountFromFixture(buyerTokenAccount);
  vaultTokenAccount.decoded = decodedTokenAccountFromFixture(vaultTokenAccount);

  assert(Number(mintAccount.decoded.decimals) === Number(setup.token_decimals), "mint decimals mismatch");
  assert(mintAccount.decoded.supply === setup.mint_amount, "mint supply mismatch");
  assert(buyerTokenAccount.decoded.mint === setup.mint, "buyer token account mint mismatch");
  assert(vaultTokenAccount.decoded.mint === setup.mint, "vault token account mint mismatch");
  assert(buyerTokenAccount.decoded.owner === setup.buyer, "buyer token account owner mismatch");
  assert(vaultTokenAccount.decoded.owner === setup.vault_authority, "vault token authority mismatch");
  assert(Buffer.from(vaultTokenAccount.data_base64, "base64").length === TOKEN_ACCOUNT_SIZE, "vault token account data size mismatch");
  const initialBalancesMatchSetup = buyerTokenAccount.decoded.amount === setup.mint_amount
    && vaultTokenAccount.decoded.amount === "0";

  const output = {
    kind: "tasc.solana.spl_setup.scan",
    version: "0.1",
    setup_file: setupFile,
    rpc_host: new URL(rpcUrl).host,
    rpc_url_printed: false,
    sends_transactions: false,
    setup_signature: setup.signature,
    confirmation_status: setup.confirmation_status,
    initial_balances_match_setup: initialBalancesMatchSetup,
    mint: mintAccount,
    buyer_token_account: buyerTokenAccount,
    vault_token_account: vaultTokenAccount,
  };
  if (options.out) writeJson(options.out, output);
  return {
    ok: true,
    mode: "scan",
    setup_file: setupFile,
    out: options.out || null,
    rpc_host: new URL(rpcUrl).host,
    rpc_url_printed: false,
    sends_transactions: false,
    mint: {
      pubkey: setup.mint,
      supply: mintAccount.decoded.supply,
      decimals: mintAccount.decoded.decimals,
      mint_authority: mintAccount.decoded.mint_authority,
    },
    buyer_token_account: {
      pubkey: setup.buyer_token_account,
      owner: buyerTokenAccount.decoded.owner,
      amount: buyerTokenAccount.decoded.amount,
    },
    vault_token_account: {
      pubkey: setup.vault_token_account,
      owner: vaultTokenAccount.decoded.owner,
      amount: vaultTokenAccount.decoded.amount,
    },
    initial_balances_match_setup: initialBalancesMatchSetup,
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
    console.error(`scan-solana-spl-live: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  accountFixtureFromRpc,
  plan,
  scan,
};
