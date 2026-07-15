#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  DEFAULT_RPC_URL,
  assertBase58Address,
  base58Decode,
  base58Encode,
  encodeShortVectorLength,
  encodeSignedTransaction,
  formatSol,
  keypairForRole,
  mergedEnv,
  pollSignature,
  rpcCall,
  signSolanaMessage,
} = require("./run-solana-devnet");
const {
  createWithSeedAddress,
  seededTaskAddress,
  seededTaskSeed,
  seededVaultAddress,
  seededVaultSeed,
  verifySignedSolanaIntent,
} = require("./tascsolana");
const { TASK_ACCOUNT_SIZE, encodeInstruction } = require("./tascsolana-program");
const {
  TOKEN_PROGRAM_ID,
  TOKEN_ACCOUNT_SIZE,
  decodeTokenAccountData,
  initializeAccount3Instruction,
  splVaultAddress,
  splVaultSeed,
  transferCheckedInstruction,
  vaultAuthorityPda,
} = require("./tascsolana-spl");

const DEFAULT_ENV_FILE = ".env.solana-devnet.local";
const DEFAULT_SIGNED_INTENT = "examples/solana/summarize_url.signature.json";
const DEFAULT_PROGRAM_KEYPAIR = "build/solana/global_tasc_solana_program-keypair.json";
const DEFAULT_SPL_SETUP = "examples/solana-devnet/spl-setup.live.json";
const ALLOW_ENV = "GLOBAL_TASC_ALLOW_SOLANA_FUND";
const SPL_ALLOW_ENV = "GLOBAL_TASC_ALLOW_SOLANA_SPL_FUND";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SPL_ENV = {
  buyerTokenAccount: "GLOBAL_TASC_SOLANA_BUYER_TOKEN_ACCOUNT",
  vaultTokenAccount: "GLOBAL_TASC_SOLANA_VAULT_TOKEN_ACCOUNT",
  tokenDecimals: "GLOBAL_TASC_SOLANA_TOKEN_DECIMALS",
};

function usage() {
  console.error([
    "Usage:",
    "  node bin/run-solana-fund.js plan [signed-solana-intent.json] [--env file]",
    "  node bin/run-solana-fund.js send [signed-solana-intent.json] [--env file]",
    "  node bin/run-solana-fund.js plan-spl [signed-solana-intent.json] [--env file] [--spl-setup file]",
    "  node bin/run-solana-fund.js send-spl [signed-solana-intent.json] [--env file] [--spl-setup file] [--out file]",
    "",
    "send is guarded by GLOBAL_TASC_ALLOW_SOLANA_FUND=1.",
    `send-spl is guarded by ${SPL_ALLOW_ENV}=1.`,
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
    splSetupFile: DEFAULT_SPL_SETUP,
    out: null,
  };
  const args = [...rest];
  if (args[0] && !args[0].startsWith("--")) options.signedFile = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = args[++i];
    else if (arg === "--spl-setup") options.splSetupFile = args[++i];
    else if (arg === "--out") options.out = args[++i];
    else usage();
  }
  return options;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function addressFromKeypairFile(file) {
  if (!fs.existsSync(file)) return null;
  const parsed = loadJson(file);
  if (!Array.isArray(parsed) || parsed.length !== 64) return null;
  return base58Encode(Buffer.from(parsed.slice(32)));
}

function buyerAddressFromEnv(env) {
  try {
    return keypairForRole(env, "buyer").address;
  } catch {
    return env.GLOBAL_TASC_SOLANA_BUYER_ADDRESS || null;
  }
}

function assertU64(value, label) {
  const raw = String(value ?? "");
  assert(/^\d+$/.test(raw), `${label} must be a u64 integer string`);
  const parsed = BigInt(raw);
  assert(parsed >= 0n && parsed <= ((1n << 64n) - 1n), `${label} exceeds u64`);
  return parsed;
}

function u64Buffer(value, label) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(assertU64(value, label), 0);
  return out;
}

function u32Buffer(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

function stringBuffer(value) {
  const raw = Buffer.from(String(value), "utf8");
  return Buffer.concat([u64Buffer(raw.length, "string length"), raw]);
}

function pubkeyBytes(address, label) {
  const bytes = base58Decode(assertBase58Address(address, label));
  assert(bytes.length === 32, `${label} must decode to 32 bytes`);
  return bytes;
}

function systemCreateAccountWithSeedData(input) {
  return Buffer.concat([
    u32Buffer(3),
    pubkeyBytes(input.base, "base"),
    stringBuffer(input.seed),
    u64Buffer(input.lamports, "lamports"),
    u64Buffer(input.space, "space"),
    pubkeyBytes(input.owner, "owner"),
  ]);
}

function accountMeta(pubkey, signer, writable) {
  return { pubkey, signer: Boolean(signer), writable: Boolean(writable) };
}

function mergeAccountMeta(map, meta) {
  const existing = map.get(meta.pubkey);
  if (!existing) {
    map.set(meta.pubkey, { ...meta });
    return;
  }
  existing.signer ||= meta.signer;
  existing.writable ||= meta.writable;
}

function orderedAccountKeys(payer, instructions) {
  const map = new Map();
  mergeAccountMeta(map, accountMeta(payer, true, true));
  for (const ix of instructions) {
    for (const meta of ix.accounts) mergeAccountMeta(map, meta);
    mergeAccountMeta(map, accountMeta(ix.programId, false, false));
  }
  const metas = [...map.values()];
  const payerMeta = metas.find((meta) => meta.pubkey === payer);
  const rest = metas.filter((meta) => meta.pubkey !== payer);
  const signedWritable = [payerMeta, ...rest.filter((meta) => meta.signer && meta.writable)];
  const signedReadonly = rest.filter((meta) => meta.signer && !meta.writable);
  const unsignedWritable = rest.filter((meta) => !meta.signer && meta.writable);
  const unsignedReadonly = rest.filter((meta) => !meta.signer && !meta.writable);
  return [...signedWritable, ...signedReadonly, ...unsignedWritable, ...unsignedReadonly];
}

function compileLegacyMessage(input) {
  const accountKeys = orderedAccountKeys(input.payer, input.instructions);
  const keyIndex = new Map(accountKeys.map((meta, index) => [meta.pubkey, index]));
  const signers = accountKeys.filter((meta) => meta.signer);
  const readonlySigners = signers.filter((meta) => !meta.writable);
  const readonlyUnsigned = accountKeys.filter((meta) => !meta.signer && !meta.writable);
  const recentBlockhash = base58Decode(input.recentBlockhash);
  assert(recentBlockhash.length === 32, "recent blockhash must decode to 32 bytes");

  const compiledInstructions = input.instructions.map((ix) => {
    const data = Buffer.from(ix.data);
    const accountIndexes = ix.accounts.map((meta) => {
      const index = keyIndex.get(meta.pubkey);
      assert(index !== undefined, `missing account key ${meta.pubkey}`);
      return index;
    });
    const programIndex = keyIndex.get(ix.programId);
    assert(programIndex !== undefined, `missing program id ${ix.programId}`);
    return Buffer.concat([
      Buffer.from([programIndex]),
      encodeShortVectorLength(accountIndexes.length),
      Buffer.from(accountIndexes),
      encodeShortVectorLength(data.length),
      data,
    ]);
  });

  return {
    accountKeys,
    message: Buffer.concat([
      Buffer.from([signers.length, readonlySigners.length, readonlyUnsigned.length]),
      encodeShortVectorLength(accountKeys.length),
      ...accountKeys.map((meta) => pubkeyBytes(meta.pubkey, "account key")),
      recentBlockhash,
      encodeShortVectorLength(compiledInstructions.length),
      ...compiledInstructions,
    ]),
  };
}

function fundAddresses(message) {
  const taskSeed = seededTaskSeed(message.task_hash);
  const vaultSeed = seededVaultSeed(message.task_hash, message.token_mint);
  return {
    task_seed: taskSeed,
    task_account: seededTaskAddress(message.program_id, message.buyer, message.task_hash),
    vault_seed: vaultSeed,
    vault: seededVaultAddress(message.program_id, message.buyer, message.task_hash, message.token_mint),
  };
}

function buildFundInstructions(signed, rents) {
  const message = signed.intent.message;
  const addresses = fundAddresses(message);
  const taskRent = assertU64(rents.task_lamports, "task_lamports");
  const vaultRent = assertU64(rents.vault_lamports, "vault_lamports");
  return {
    addresses,
    instructions: [
      {
        name: "create_task_account",
        programId: SYSTEM_PROGRAM_ID,
        accounts: [
          accountMeta(message.buyer, true, true),
          accountMeta(addresses.task_account, false, true),
        ],
        data: systemCreateAccountWithSeedData({
          base: message.buyer,
          seed: addresses.task_seed,
          lamports: taskRent,
          space: TASK_ACCOUNT_SIZE,
          owner: message.program_id,
        }),
      },
      {
        name: "create_vault_account",
        programId: SYSTEM_PROGRAM_ID,
        accounts: [
          accountMeta(message.buyer, true, true),
          accountMeta(addresses.vault, false, true),
        ],
        data: systemCreateAccountWithSeedData({
          base: message.buyer,
          seed: addresses.vault_seed,
          lamports: vaultRent,
          space: 0,
          owner: message.program_id,
        }),
      },
      {
        name: "fund",
        programId: message.program_id,
        accounts: [
          accountMeta(message.buyer, true, true),
          accountMeta(addresses.task_account, false, true),
          accountMeta(addresses.vault, false, true),
          accountMeta(message.token_mint, false, false),
          accountMeta(message.verifier, false, false),
        ],
        data: encodeInstruction("fund", message),
      },
    ],
  };
}

function buildFundWithSplTransferInstructions(signed, options = {}) {
  const message = signed.intent.message;
  const addresses = fundAddresses(message);
  const taskRent = assertU64(options.task_lamports, "task_lamports");
  const buyerTokenAccount = assertBase58Address(options.buyer_token_account, "buyer_token_account");
  const vaultTokenAccount = assertBase58Address(options.vault_token_account || addresses.vault, "vault_token_account");
  const tokenDecimals = Number(options.token_decimals ?? signed.intent.chain_reward?.decimals ?? 6);
  assert(Number.isInteger(tokenDecimals) && tokenDecimals >= 0 && tokenDecimals <= 255, "token_decimals must be a u8");
  return {
    addresses: {
      ...addresses,
      buyer_token_account: buyerTokenAccount,
      vault: vaultTokenAccount,
      vault_token_account: vaultTokenAccount,
    },
    instructions: [
      {
        name: "create_task_account",
        programId: SYSTEM_PROGRAM_ID,
        accounts: [
          accountMeta(message.buyer, true, true),
          accountMeta(addresses.task_account, false, true),
        ],
        data: systemCreateAccountWithSeedData({
          base: message.buyer,
          seed: addresses.task_seed,
          lamports: taskRent,
          space: TASK_ACCOUNT_SIZE,
          owner: message.program_id,
        }),
      },
      transferCheckedInstruction({
        source: buyerTokenAccount,
        mint: message.token_mint,
        destination: vaultTokenAccount,
        authority: message.buyer,
        amount: message.amount,
        decimals: tokenDecimals,
      }),
      {
        name: "fund",
        programId: message.program_id,
        accounts: [
          accountMeta(message.buyer, true, true),
          accountMeta(addresses.task_account, false, true),
          accountMeta(vaultTokenAccount, false, true),
          accountMeta(message.token_mint, false, false),
          accountMeta(message.verifier, false, false),
        ],
        data: encodeInstruction("fund", message),
      },
    ],
  };
}

function loadSignedIntent(signedFile) {
  const signed = loadJson(signedFile);
  const signatureCheck = verifySignedSolanaIntent(signed);
  assert(signatureCheck.ok, "signed Solana intent signature is invalid");
  return signed;
}

function loadSplSetup(file) {
  const setup = loadJson(file);
  assertBase58Address(setup.mint, "setup mint");
  assertBase58Address(setup.buyer, "setup buyer");
  assertBase58Address(setup.buyer_token_account, "setup buyer_token_account");
  assert(/^\d+$/.test(String(setup.token_decimals ?? "")), "setup token_decimals must be numeric");
  return setup;
}

function splFundingAddresses(message, setup) {
  const addresses = fundAddresses(message);
  const vaultTokenSeed = splVaultSeed(message.program_id, message.task_hash, message.token_mint);
  const vaultTokenAccount = splVaultAddress(message.program_id, message.buyer, message.task_hash, message.token_mint);
  const vaultAuthority = vaultAuthorityPda(message.program_id, message.task_hash, message.token_mint);
  return {
    ...addresses,
    buyer_token_account: setup.buyer_token_account,
    vault: vaultTokenAccount,
    vault_token_seed: vaultTokenSeed,
    vault_token_account: vaultTokenAccount,
    vault_authority: vaultAuthority.address,
    vault_authority_bump: vaultAuthority.bump,
  };
}

function plan(options = {}) {
  const signed = loadSignedIntent(options.signedFile);
  const message = signed.intent.message;
  const addresses = fundAddresses(message);
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE, {});
  const localBuyer = buyerAddressFromEnv(env);
  const deployProgramId = addressFromKeypairFile(DEFAULT_PROGRAM_KEYPAIR);
  const buyerMatches = localBuyer ? localBuyer === message.buyer : false;
  const programMatches = deployProgramId ? deployProgramId === message.program_id : false;
  return {
    ok: true,
    mode: "plan",
    signed_intent: options.signedFile,
    env_file: path.resolve(options.envFile || DEFAULT_ENV_FILE),
    sends_transactions: false,
    guard_for_send: `${ALLOW_ENV}=1`,
    cluster: message.cluster,
    program_id: message.program_id,
    deploy_program_id: deployProgramId,
    deploy_program_matches_signed_intent: programMatches,
    buyer: message.buyer,
    local_buyer: localBuyer,
    local_buyer_matches_signed_intent: buyerMatches,
    task_account: addresses.task_account,
    task_seed: addresses.task_seed,
    vault: addresses.vault,
    vault_seed: addresses.vault_seed,
    token_mint: message.token_mint,
    verifier: message.verifier,
    instructions: [
      "system.create_account_with_seed(task)",
      "system.create_account_with_seed(vault)",
      "global_tasc.fund",
    ],
    spl_escrow_next: {
      sends_transactions: false,
      token_program_id: TOKEN_PROGRAM_ID,
      required_env: [
        SPL_ENV.buyerTokenAccount,
        SPL_ENV.vaultTokenAccount,
        SPL_ENV.tokenDecimals,
      ],
      planned_instruction_shape: [
        "system.create_account_with_seed(task)",
        "spl_token.transfer_checked(buyer_token_account -> vault_token_account)",
        "global_tasc.fund",
      ],
      note: "The plain fund sender uses the placeholder vault path. Use plan-spl/send-spl for live SPL custody; release/refund token movement is handled by the lifecycle/SPL CPI follow-up.",
    },
    send_requirements: [
      "buyer keypair in local env must match the signed intent buyer",
      "signed intent program_id must match the deployed program id",
      "token_mint and verifier accounts must exist on devnet",
      "program must already be deployed at program_id",
    ],
    ready_to_send_after_deploy: buyerMatches && programMatches,
  };
}

function planSpl(options = {}) {
  const signed = loadSignedIntent(options.signedFile);
  const message = signed.intent.message;
  const setup = loadSplSetup(options.splSetupFile || DEFAULT_SPL_SETUP);
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE, {});
  const localBuyer = buyerAddressFromEnv(env);
  const deployProgramId = addressFromKeypairFile(DEFAULT_PROGRAM_KEYPAIR);
  const buyerMatches = localBuyer ? localBuyer === message.buyer : false;
  const programMatches = deployProgramId ? deployProgramId === message.program_id : false;
  const setupMatchesIntent = setup.mint === message.token_mint && setup.buyer === message.buyer;
  const addresses = splFundingAddresses(message, setup);
  return {
    ok: true,
    mode: "plan-spl",
    signed_intent: options.signedFile,
    spl_setup_file: options.splSetupFile || DEFAULT_SPL_SETUP,
    env_file: path.resolve(options.envFile || DEFAULT_ENV_FILE),
    sends_transactions: false,
    guard_for_send: `${SPL_ALLOW_ENV}=1`,
    cluster: message.cluster,
    program_id: message.program_id,
    deploy_program_id: deployProgramId,
    deploy_program_matches_signed_intent: programMatches,
    buyer: message.buyer,
    local_buyer: localBuyer,
    local_buyer_matches_signed_intent: buyerMatches,
    setup_buyer_matches_signed_intent: setup.buyer === message.buyer,
    setup_mint_matches_signed_intent: setup.mint === message.token_mint,
    setup_matches_signed_intent: setupMatchesIntent,
    task_account: addresses.task_account,
    task_seed: addresses.task_seed,
    buyer_token_account: addresses.buyer_token_account,
    vault_token_account: addresses.vault_token_account,
    vault_token_seed: addresses.vault_token_seed,
    vault_authority: addresses.vault_authority,
    vault_authority_bump: addresses.vault_authority_bump,
    token_mint: message.token_mint,
    token_decimals: setup.token_decimals,
    amount: message.amount,
    verifier: message.verifier,
    instructions: [
      "system.create_account_with_seed(task)",
      "system.create_account_with_seed(vault_token_account)",
      "spl_token.initialize_account3(vault PDA authority)",
      "spl_token.transfer_checked(buyer_token_account -> vault_token_account)",
      "global_tasc.fund",
    ],
    send_requirements: [
      "buyer keypair in local env must match the signed intent buyer",
      "signed intent program_id must match the deployed program id",
      "SPL setup mint and buyer must match the signed intent",
      "buyer token account must hold at least the signed amount",
      "fresh task and vault token accounts must not already exist",
    ],
    ready_to_send_after_setup: buyerMatches && programMatches && setupMatchesIntent,
  };
}

function buildFundWithSplVaultInstructions(signed, options = {}) {
  const message = signed.intent.message;
  const setup = {
    buyer_token_account: assertBase58Address(options.buyer_token_account, "buyer_token_account"),
  };
  const addresses = splFundingAddresses(message, setup);
  const taskRent = assertU64(options.task_lamports, "task_lamports");
  const vaultTokenRent = assertU64(options.vault_token_lamports, "vault_token_lamports");
  const tokenDecimals = Number(options.token_decimals ?? signed.intent.chain_reward?.decimals ?? 6);
  assert(Number.isInteger(tokenDecimals) && tokenDecimals >= 0 && tokenDecimals <= 255, "token_decimals must be a u8");
  return {
    addresses,
    instructions: [
      {
        name: "create_task_account",
        programId: SYSTEM_PROGRAM_ID,
        accounts: [
          accountMeta(message.buyer, true, true),
          accountMeta(addresses.task_account, false, true),
        ],
        data: systemCreateAccountWithSeedData({
          base: message.buyer,
          seed: addresses.task_seed,
          lamports: taskRent,
          space: TASK_ACCOUNT_SIZE,
          owner: message.program_id,
        }),
      },
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
          lamports: vaultTokenRent,
          space: TOKEN_ACCOUNT_SIZE,
          owner: TOKEN_PROGRAM_ID,
        }),
      },
      initializeAccount3Instruction({
        account: addresses.vault_token_account,
        mint: message.token_mint,
        owner: addresses.vault_authority,
      }),
      transferCheckedInstruction({
        source: addresses.buyer_token_account,
        mint: message.token_mint,
        destination: addresses.vault_token_account,
        authority: message.buyer,
        amount: message.amount,
        decimals: tokenDecimals,
      }),
      {
        name: "fund",
        programId: message.program_id,
        accounts: [
          accountMeta(message.buyer, true, true),
          accountMeta(addresses.task_account, false, true),
          accountMeta(addresses.vault_token_account, false, true),
          accountMeta(message.token_mint, false, false),
          accountMeta(message.verifier, false, false),
        ],
        data: encodeInstruction("fund", message),
      },
    ],
  };
}

function tokenAccountFixtureFromRpc(pubkey, result) {
  assert(result.value, `token account ${pubkey} not found`);
  assert(result.value.owner === TOKEN_PROGRAM_ID, `token account ${pubkey} must be owned by SPL Token Program`);
  assert(Array.isArray(result.value.data), "token account data must be [base64, encoding]");
  assert(result.value.data[1] === "base64", "token account encoding must be base64");
  return {
    pubkey,
    owner: result.value.owner,
    data_base64: result.value.data[0],
    context: {
      slot: String(result.context?.slot ?? "0"),
      api_version: result.context?.apiVersion || null,
    },
    decoded: decodeTokenAccountData(result.value.data[0]),
  };
}

async function sendSpl(options = {}) {
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE);
  const rpcUrl = env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL;
  const signed = loadSignedIntent(options.signedFile);
  const setup = loadSplSetup(options.splSetupFile || DEFAULT_SPL_SETUP);
  const buyer = keypairForRole(env, "buyer");
  const message = signed.intent.message;
  assert(env[SPL_ALLOW_ENV] === "1", `refusing to send without ${SPL_ALLOW_ENV}=1`);
  assert(buyer.address === message.buyer, "local buyer keypair must match signed intent buyer");
  assert(setup.buyer === message.buyer, "SPL setup buyer must match signed intent buyer");
  assert(setup.mint === message.token_mint, "SPL setup mint must match signed intent token mint");

  const [taskRent, tokenRent, latest, buyerTokenInfo] = await Promise.all([
    rpcCall(rpcUrl, "getMinimumBalanceForRentExemption", [TASK_ACCOUNT_SIZE]),
    rpcCall(rpcUrl, "getMinimumBalanceForRentExemption", [TOKEN_ACCOUNT_SIZE]),
    rpcCall(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]),
    rpcCall(rpcUrl, "getAccountInfo", [
      setup.buyer_token_account,
      {
        commitment: "confirmed",
        encoding: "base64",
      },
    ]),
  ]);
  const buyerToken = tokenAccountFixtureFromRpc(setup.buyer_token_account, buyerTokenInfo);
  assert(buyerToken.decoded.mint === message.token_mint, "buyer token account mint must match signed intent");
  assert(buyerToken.decoded.owner === message.buyer, "buyer token account owner must be signed intent buyer");
  assert(BigInt(buyerToken.decoded.amount) >= BigInt(message.amount), "buyer token account balance is below signed amount");

  const { addresses, instructions } = buildFundWithSplVaultInstructions(signed, {
    task_lamports: String(taskRent),
    vault_token_lamports: String(tokenRent),
    buyer_token_account: setup.buyer_token_account,
    token_decimals: setup.token_decimals,
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
    mode: "send-spl",
    rpc_host: new URL(rpcUrl).host,
    program_id: message.program_id,
    buyer: buyer.address,
    task_account: addresses.task_account,
    buyer_token_account: addresses.buyer_token_account,
    vault_token_account: addresses.vault_token_account,
    vault_authority: addresses.vault_authority,
    token_mint: message.token_mint,
    amount: message.amount,
    token_decimals: setup.token_decimals,
    task_rent_lamports: String(taskRent),
    vault_token_rent_lamports: String(tokenRent),
    transfer_instruction_index: "3",
    fund_instruction_index: "4",
    instructions: instructions.map((instruction) => instruction.name),
    signature: txSignature,
    confirmation_status: status ? status.confirmationStatus : "pending",
    key_material_printed: false,
  };
  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

async function send(options = {}) {
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE);
  const rpcUrl = env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL;
  const signed = loadSignedIntent(options.signedFile);
  const buyer = keypairForRole(env, "buyer");
  const message = signed.intent.message;
  assert(env[ALLOW_ENV] === "1", `refusing to send without ${ALLOW_ENV}=1`);
  assert(buyer.address === message.buyer, "local buyer keypair must match signed intent buyer");

  const [taskRent, vaultRent, latest] = await Promise.all([
    rpcCall(rpcUrl, "getMinimumBalanceForRentExemption", [TASK_ACCOUNT_SIZE]),
    rpcCall(rpcUrl, "getMinimumBalanceForRentExemption", [0]),
    rpcCall(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]),
  ]);
  const { addresses, instructions } = buildFundInstructions(signed, {
    task_lamports: String(taskRent),
    vault_lamports: String(vaultRent),
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
  return {
    ok: true,
    mode: "send",
    rpc_host: new URL(rpcUrl).host,
    program_id: message.program_id,
    buyer: buyer.address,
    task_account: addresses.task_account,
    vault: addresses.vault,
    task_rent_lamports: String(taskRent),
    vault_rent_lamports: String(vaultRent),
    signature: txSignature,
    confirmation_status: status ? status.confirmationStatus : "pending",
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(plan(options), null, 2)}\n`);
    return;
  }
  if (command === "plan-spl") {
    process.stdout.write(`${JSON.stringify(planSpl(options), null, 2)}\n`);
    return;
  }
  if (command === "send") {
    process.stdout.write(`${JSON.stringify(await send(options), null, 2)}\n`);
    return;
  }
  if (command === "send-spl") {
    process.stdout.write(`${JSON.stringify(await sendSpl(options), null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`run-solana-fund: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  SPL_ENV,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  buildFundInstructions,
  buildFundWithSplVaultInstructions,
  buildFundWithSplTransferInstructions,
  compileLegacyMessage,
  createWithSeedAddress,
  fundAddresses,
  plan,
  planSpl,
  send,
  sendSpl,
  systemCreateAccountWithSeedData,
};
