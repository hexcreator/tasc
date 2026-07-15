#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  DEFAULT_RPC_URL,
  assertBase58Address,
  encodeSignedTransaction,
  keypairForRole,
  mergedEnv,
  pollSignature,
  rpcCall,
  signSolanaMessage,
} = require("./run-solana-devnet");
const {
  SYSTEM_PROGRAM_ID,
  compileLegacyMessage,
  createWithSeedAddress,
  systemCreateAccountWithSeedData,
} = require("./run-solana-fund");
const { verifySignedSolanaIntent } = require("./tascsolana");
const {
  MINT_ACCOUNT_SIZE,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  decodeInitializeAccount3Data,
  decodeInitializeMint2Data,
  decodeMintToCheckedData,
  initializeAccount3Instruction,
  initializeMint2Instruction,
  mintToCheckedInstruction,
  splBuyerTokenAddress,
  splBuyerTokenSeed,
  splMintAddress,
  splMintSeed,
  splVaultAddress,
  splVaultSeed,
  vaultAuthorityPda,
} = require("./tascsolana-spl");

const DEFAULT_ENV_FILE = ".env.solana-devnet.local";
const DEFAULT_SIGNED_INTENT = "examples/solana-devnet/summarize_url.signature.json";
const DEFAULT_OUT = "examples/solana-devnet/spl-setup.live.json";
const ALLOW_ENV = "GLOBAL_TASC_ALLOW_SOLANA_SPL_SETUP";

function usage() {
  console.error([
    "Usage:",
    "  node bin/run-solana-spl-setup.js plan [signed-solana-intent.json] [--env file] [--out file] [--mint-amount amount]",
    "  node bin/run-solana-spl-setup.js send [signed-solana-intent.json] [--env file] [--out file] [--mint-amount amount]",
    "",
    `send is guarded by ${ALLOW_ENV}=1 and creates devnet SPL test-token accounts.`,
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
    out: DEFAULT_OUT,
    mintAmount: null,
  };
  const args = [...rest];
  if (args[0] && !args[0].startsWith("--")) options.signedFile = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = args[++i];
    else if (arg === "--out") options.out = args[++i];
    else if (arg === "--mint-amount") options.mintAmount = args[++i];
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

function assertU64(value, label) {
  const raw = String(value ?? "");
  assert(/^\d+$/.test(raw), `${label} must be a u64 integer string`);
  const parsed = BigInt(raw);
  assert(parsed >= 0n && parsed <= ((1n << 64n) - 1n), `${label} exceeds u64`);
  return parsed;
}

function loadSignedIntent(file) {
  const signed = loadJson(file);
  const signatureCheck = verifySignedSolanaIntent(signed);
  assert(signatureCheck.ok, "signed Solana intent signature is invalid");
  return signed;
}

function setupAddresses(message) {
  assertBase58Address(message.buyer, "buyer");
  assertBase58Address(message.program_id, "program_id");
  const mintSeed = splMintSeed(message.program_id, message.task_hash);
  const mint = splMintAddress(message.buyer, message.program_id, message.task_hash);
  const buyerTokenSeed = splBuyerTokenSeed(message.buyer, mint);
  const buyerTokenAccount = splBuyerTokenAddress(message.buyer, mint);
  const vaultTokenSeed = splVaultSeed(message.program_id, message.task_hash, mint);
  const vaultTokenAccount = splVaultAddress(message.program_id, message.buyer, message.task_hash, mint);
  const vaultAuthority = vaultAuthorityPda(message.program_id, message.task_hash, mint);
  return {
    mint_seed: mintSeed,
    mint,
    buyer_token_seed: buyerTokenSeed,
    buyer_token_account: buyerTokenAccount,
    vault_token_seed: vaultTokenSeed,
    vault_token_account: vaultTokenAccount,
    vault_authority: vaultAuthority.address,
    vault_authority_bump: vaultAuthority.bump,
  };
}

function accountMeta(pubkey, signer, writable) {
  return { pubkey, signer: Boolean(signer), writable: Boolean(writable) };
}

function buildSetupInstructions(signed, options = {}) {
  const message = signed.intent.message;
  const addresses = setupAddresses(message);
  const decimals = Number(options.decimals ?? signed.intent.chain_reward?.decimals ?? 6);
  assert(Number.isInteger(decimals) && decimals >= 0 && decimals <= 255, "token decimals must be a u8");
  const mintAmount = assertU64(options.mintAmount || message.amount, "mint amount");
  const mintRent = assertU64(options.mint_lamports, "mint_lamports");
  const tokenRent = assertU64(options.token_lamports, "token_lamports");
  return {
    addresses,
    instructions: [
      {
        name: "create_mint_account",
        programId: SYSTEM_PROGRAM_ID,
        accounts: [
          accountMeta(message.buyer, true, true),
          accountMeta(addresses.mint, false, true),
        ],
        data: systemCreateAccountWithSeedData({
          base: message.buyer,
          seed: addresses.mint_seed,
          lamports: mintRent,
          space: MINT_ACCOUNT_SIZE,
          owner: TOKEN_PROGRAM_ID,
        }),
      },
      initializeMint2Instruction({
        mint: addresses.mint,
        decimals,
        mintAuthority: message.buyer,
        freezeAuthority: null,
      }),
      {
        name: "create_buyer_token_account",
        programId: SYSTEM_PROGRAM_ID,
        accounts: [
          accountMeta(message.buyer, true, true),
          accountMeta(addresses.buyer_token_account, false, true),
        ],
        data: systemCreateAccountWithSeedData({
          base: message.buyer,
          seed: addresses.buyer_token_seed,
          lamports: tokenRent,
          space: TOKEN_ACCOUNT_SIZE,
          owner: TOKEN_PROGRAM_ID,
        }),
      },
      initializeAccount3Instruction({
        account: addresses.buyer_token_account,
        mint: addresses.mint,
        owner: message.buyer,
      }),
      {
        name: "create_vault_token_account",
        programId: SYSTEM_PROGRAM_ID,
        accounts: [
          accountMeta(message.buyer, true, true),
          accountMeta(addresses.vault_token_account, false, true),
        ],
        data: systemCreateAccountWithSeedData({
          base: message.buyer,
          seed: addresses.vault_token_seed,
          lamports: tokenRent,
          space: TOKEN_ACCOUNT_SIZE,
          owner: TOKEN_PROGRAM_ID,
        }),
      },
      initializeAccount3Instruction({
        account: addresses.vault_token_account,
        mint: addresses.mint,
        owner: addresses.vault_authority,
      }),
      mintToCheckedInstruction({
        mint: addresses.mint,
        destination: addresses.buyer_token_account,
        authority: message.buyer,
        amount: mintAmount.toString(),
        decimals,
      }),
    ],
  };
}

function instructionNames(instructions) {
  return instructions.map((instruction) => instruction.name);
}

function plan(options = {}) {
  const signed = loadSignedIntent(options.signedFile || DEFAULT_SIGNED_INTENT);
  const message = signed.intent.message;
  const addresses = setupAddresses(message);
  const mintAmount = (options.mintAmount || message.amount).toString();
  return {
    ok: true,
    mode: "plan",
    signed_intent: options.signedFile || DEFAULT_SIGNED_INTENT,
    env_file: path.resolve(options.envFile || DEFAULT_ENV_FILE),
    sends_transactions: false,
    guard_for_send: `${ALLOW_ENV}=1`,
    cluster: message.cluster,
    buyer: message.buyer,
    program_id: message.program_id,
    token_program_id: TOKEN_PROGRAM_ID,
    setup_mint: addresses.mint,
    signed_intent_token_mint: message.token_mint,
    signed_intent_token_mint_matches_setup: message.token_mint === addresses.mint,
    buyer_token_account: addresses.buyer_token_account,
    vault_token_account: addresses.vault_token_account,
    vault_authority: addresses.vault_authority,
    vault_authority_bump: addresses.vault_authority_bump,
    mint_amount: mintAmount,
    token_decimals: signed.intent.chain_reward?.decimals ?? 6,
    planned_instruction_shape: [
      "system.create_account_with_seed(mint)",
      "spl_token.initialize_mint2",
      "system.create_account_with_seed(buyer_token_account)",
      "spl_token.initialize_account3(buyer)",
      "system.create_account_with_seed(vault_token_account)",
      "spl_token.initialize_account3(vault PDA authority)",
      "spl_token.mint_to_checked(buyer_token_account)",
    ],
    next_commands_after_setup: [
      `node bin/create-solana-live-intent.js ${signed.intent.task_file || "examples/summarize_url.tasc"} --token-mint ${addresses.mint}`,
      "npm run solana:fund-plan:live",
    ],
    key_material_printed: false,
  };
}

async function send(options = {}) {
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE);
  const rpcUrl = env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL;
  const signed = loadSignedIntent(options.signedFile || DEFAULT_SIGNED_INTENT);
  const message = signed.intent.message;
  const buyer = keypairForRole(env, "buyer");
  assert(env[ALLOW_ENV] === "1", `refusing to send without ${ALLOW_ENV}=1`);
  assert(buyer.address === message.buyer, "local buyer keypair must match signed intent buyer");

  const [mintRent, tokenRent, latest] = await Promise.all([
    rpcCall(rpcUrl, "getMinimumBalanceForRentExemption", [MINT_ACCOUNT_SIZE]),
    rpcCall(rpcUrl, "getMinimumBalanceForRentExemption", [TOKEN_ACCOUNT_SIZE]),
    rpcCall(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]),
  ]);
  const { addresses, instructions } = buildSetupInstructions(signed, {
    mint_lamports: String(mintRent),
    token_lamports: String(tokenRent),
    mintAmount: options.mintAmount,
  });
  const compiled = compileLegacyMessage({
    payer: buyer.address,
    recentBlockhash: latest.value.blockhash,
    instructions,
  });
  const signature = signSolanaMessage(compiled.message, buyer.seed);
  const encoded = encodeSignedTransaction(compiled.message, signature);
  const txSignature = await rpcCall(rpcUrl, "sendTransaction", [
    encoded,
    {
      encoding: "base64",
      preflightCommitment: "confirmed",
    },
  ]);
  const status = await pollSignature(rpcUrl, txSignature);
  const result = {
    ok: true,
    mode: "send",
    rpc_host: new URL(rpcUrl).host,
    sends_transactions: true,
    cluster: message.cluster,
    buyer: buyer.address,
    program_id: message.program_id,
    token_program_id: TOKEN_PROGRAM_ID,
    mint: addresses.mint,
    buyer_token_account: addresses.buyer_token_account,
    vault_token_account: addresses.vault_token_account,
    vault_authority: addresses.vault_authority,
    vault_authority_bump: addresses.vault_authority_bump,
    mint_rent_lamports: String(mintRent),
    token_account_rent_lamports: String(tokenRent),
    mint_amount: String(options.mintAmount || message.amount),
    token_decimals: signed.intent.chain_reward?.decimals ?? 6,
    instructions: instructionNames(instructions),
    signature: txSignature,
    confirmation_status: status ? status.confirmationStatus : "pending",
    key_material_printed: false,
  };
  if (options.out) writeJson(options.out, result);
  return result;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(plan(options), null, 2)}\n`);
    return;
  }
  if (command === "send") {
    process.stdout.write(`${JSON.stringify(await send(options), null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`run-solana-spl-setup: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  ALLOW_ENV,
  buildSetupInstructions,
  plan,
  send,
  setupAddresses,
  decodeInitializeAccount3Data,
  decodeInitializeMint2Data,
  decodeMintToCheckedData,
};
