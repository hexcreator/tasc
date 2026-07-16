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
  TOKEN_PROGRAM_ID,
  TOKEN_ACCOUNT_SIZE,
  decodeTokenAccountData,
  encodeTokenAccount,
} = require("./tascsolana-spl");
const { TASK_ACCOUNT_SIZE } = require("./tascsolana-program");
const {
  buildFundWithSplVaultInstructions,
  compileLegacyMessage,
} = require("./run-solana-fund");
const {
  createSolanaIntent,
  fixtureKeypair,
  signSolanaIntent,
  verifySignedSolanaIntent,
} = require("./tascsolana");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_SIGNED_INTENT = ".tascverifier/production-intent/production-intent.signature.json";
const DEFAULT_OUT = ".tascverifier/production-fund-transaction.json";
const DEFAULT_CLUSTER = "solana-mainnet-beta";
const DEFAULT_AMOUNT_BASE_UNITS = "10000000";
const DEFAULT_DECIMALS = 6;
const DEFAULT_COMMITMENT = "confirmed";
const TEST_RPC_HOST_RE = /(devnet|testnet|localhost|127\.0\.0\.1|0\.0\.0\.0)/i;

function usage() {
  console.error([
    "Usage:",
    "  node bin/build-production-fund-transaction.js plan [options]",
    "  node bin/build-production-fund-transaction.js build [options]",
    "  node bin/build-production-fund-transaction.js validate <artifact.json>",
    "  node bin/build-production-fund-transaction.js --self-test",
    "",
    "Build options:",
    "  --signed-intent <file>                    signed production intent; default .tascverifier/production-intent/production-intent.signature.json",
    "  --buyer-usdc-token-account <address>      buyer USDC source token account",
    "  --production-rpc-url <url>                optional read-only mainnet RPC for blockhash/rent/source-account checks",
    "  --recent-blockhash <hash>                 required without --production-rpc-url",
    "  --task-rent-lamports <n>                  required without --production-rpc-url",
    "  --vault-token-rent-lamports <n>           required without --production-rpc-url",
    "  --min-confirmation <status>               processed, confirmed, or finalized; default confirmed",
    "  --out <file>                              output artifact; default .tascverifier/production-fund-transaction.json",
    "",
    "This builder creates an unsigned wallet transaction only. It never accepts private keys and never sends transactions.",
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
    signedIntent: DEFAULT_SIGNED_INTENT,
    buyerUsdcTokenAccount: "",
    productionRpcUrl: "",
    recentBlockhash: "",
    taskRentLamports: "",
    vaultTokenRentLamports: "",
    minConfirmation: DEFAULT_COMMITMENT,
    out: DEFAULT_OUT,
    selfTest: false,
  };
  const args = [...argv];
  if (["plan", "build", "validate"].includes(args[0])) options.command = args.shift();
  if (options.command === "validate" && args[0] && !args[0].startsWith("--")) options.artifactFile = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--signed-intent") options.signedIntent = requireValue(args, ++i, arg);
    else if (arg === "--buyer-usdc-token-account") options.buyerUsdcTokenAccount = requireValue(args, ++i, arg);
    else if (arg === "--production-rpc-url") options.productionRpcUrl = requireValue(args, ++i, arg);
    else if (arg === "--recent-blockhash") options.recentBlockhash = requireValue(args, ++i, arg);
    else if (arg === "--task-rent-lamports") options.taskRentLamports = requireValue(args, ++i, arg);
    else if (arg === "--vault-token-rent-lamports") options.vaultTokenRentLamports = requireValue(args, ++i, arg);
    else if (arg === "--min-confirmation") options.minConfirmation = requireValue(args, ++i, arg);
    else if (arg === "--out") options.out = requireValue(args, ++i, arg);
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
  return path.relative(ROOT, path.resolve(file));
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function assertU64(value, label) {
  const raw = String(value || "");
  assert(/^[0-9]+$/.test(raw), `${label} must be a nonnegative integer string`);
  const parsed = BigInt(raw);
  assert(parsed <= ((1n << 64n) - 1n), `${label} exceeds u64`);
  return raw;
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
  assert(message.buyer === verified.signer, "signed intent signer must be the buyer");
  return { signed, verified };
}

async function fetchTokenAccount(rpcUrl, pubkey, commitment, rpcCall) {
  const result = await rpcCall(rpcUrl, "getAccountInfo", [
    pubkey,
    {
      commitment,
      encoding: "base64",
    },
  ]);
  const value = result && result.value;
  assert(value, `buyer USDC token account ${pubkey} not found`);
  assert(value.owner === TOKEN_PROGRAM_ID, "buyer USDC token account must be owned by SPL Token Program");
  assert(Array.isArray(value.data) && value.data[1] === "base64", "buyer USDC token account must return base64 data");
  return decodeTokenAccountData(value.data[0]);
}

async function assertAccountMissing(rpcUrl, pubkey, label, commitment, rpcCall) {
  const result = await rpcCall(rpcUrl, "getAccountInfo", [
    pubkey,
    {
      commitment,
      encoding: "base64",
    },
  ]);
  assert(!result || !result.value, `${label} already exists at ${pubkey}`);
}

async function resolveInputs(options, signed, addresses, rpcCall) {
  const message = signed.intent.message;
  const commitment = assertConfirmation(options.minConfirmation || DEFAULT_COMMITMENT);
  const source = {
    calls_rpc: false,
    rpc_host: null,
    rpc_url_printed: false,
    full_rpc_url_persisted: false,
    source_account_checked: false,
    fresh_accounts_checked: false,
  };

  let recentBlockhash = options.recentBlockhash ? assertBlockhash(options.recentBlockhash) : "";
  let taskRentLamports = options.taskRentLamports ? assertU64(options.taskRentLamports, "task_rent_lamports") : "";
  let vaultTokenRentLamports = options.vaultTokenRentLamports ? assertU64(options.vaultTokenRentLamports, "vault_token_rent_lamports") : "";

  if (options.productionRpcUrl) {
    const url = assertHttpUrl(options.productionRpcUrl, "production_rpc_url");
    if (!options.allowTestRpcHost && TEST_RPC_HOST_RE.test(url.host)) {
      throw new Error("production RPC host must not look like devnet/testnet/local");
    }
    source.calls_rpc = true;
    source.rpc_host = url.host;
    const [latest, taskRent, vaultRent, buyerToken] = await Promise.all([
      rpcCall(options.productionRpcUrl, "getLatestBlockhash", [{ commitment }]),
      rpcCall(options.productionRpcUrl, "getMinimumBalanceForRentExemption", [TASK_ACCOUNT_SIZE]),
      rpcCall(options.productionRpcUrl, "getMinimumBalanceForRentExemption", [TOKEN_ACCOUNT_SIZE]),
      fetchTokenAccount(options.productionRpcUrl, options.buyerUsdcTokenAccount, commitment, rpcCall),
    ]);
    recentBlockhash = assertBlockhash(latest.value && latest.value.blockhash);
    taskRentLamports = assertU64(String(taskRent), "task_rent_lamports");
    vaultTokenRentLamports = assertU64(String(vaultRent), "vault_token_rent_lamports");
    assert(buyerToken.mint === message.token_mint, "buyer USDC token account mint does not match signed intent token mint");
    assert(buyerToken.owner === message.buyer, "buyer USDC token account owner does not match signed intent buyer");
    assert(BigInt(buyerToken.amount) >= BigInt(message.amount), "buyer USDC token account balance is below signed intent amount");
    source.source_account_checked = true;
    await Promise.all([
      assertAccountMissing(options.productionRpcUrl, addresses.task_account, "task account", commitment, rpcCall),
      assertAccountMissing(options.productionRpcUrl, addresses.vault_token_account, "vault token account", commitment, rpcCall),
    ]);
    source.fresh_accounts_checked = true;
  } else {
    assert(recentBlockhash, "recent_blockhash is required without --production-rpc-url");
    assert(taskRentLamports, "task_rent_lamports is required without --production-rpc-url");
    assert(vaultTokenRentLamports, "vault_token_rent_lamports is required without --production-rpc-url");
  }

  return {
    recentBlockhash,
    taskRentLamports,
    vaultTokenRentLamports,
    minConfirmation: commitment,
    source,
  };
}

async function buildArtifact(options = {}, rpcCall = defaultRpcCall) {
  assert(options.signedIntent, "--signed-intent is required");
  const buyerTokenAccount = assertSolanaAddress(options.buyerUsdcTokenAccount, "buyer_usdc_token_account");
  const { signed, verified } = loadSignedProductionIntent(options.signedIntent);
  const message = signed.intent.message;
  const built = buildFundWithSplVaultInstructions(signed, {
    task_lamports: options.taskRentLamports || "0",
    vault_token_lamports: options.vaultTokenRentLamports || "0",
    buyer_token_account: buyerTokenAccount,
    token_decimals: DEFAULT_DECIMALS,
  });
  const resolved = await resolveInputs(options, signed, built.addresses, rpcCall);
  const rebuilt = buildFundWithSplVaultInstructions(signed, {
    task_lamports: resolved.taskRentLamports,
    vault_token_lamports: resolved.vaultTokenRentLamports,
    buyer_token_account: buyerTokenAccount,
    token_decimals: DEFAULT_DECIMALS,
  });
  const compiled = compileLegacyMessage({
    payer: message.buyer,
    recentBlockhash: resolved.recentBlockhash,
    instructions: rebuilt.instructions,
  });
  const messageBytes = Buffer.from(compiled.message);
  const unsignedTransaction = encodeUnsignedTransaction(messageBytes);

  return {
    ok: true,
    kind: "tasc.production_fund_transaction",
    version: "0.1",
    generated_at: new Date().toISOString(),
    signed_intent_file: rel(options.signedIntent),
    intent_hash: signed.intent_hash,
    signer: verified.signer,
    cluster: DEFAULT_CLUSTER,
    network_type: "mainnet",
    token: {
      symbol: "USDC",
      mint: message.token_mint,
      decimals: DEFAULT_DECIMALS,
      production_asset: true,
    },
    amount: {
      display: "10 USDC",
      base_units: message.amount,
    },
    buyer: message.buyer,
    verifier: message.verifier,
    program_id: message.program_id,
    buyer_usdc_token_account: buyerTokenAccount,
    task_account: rebuilt.addresses.task_account,
    task_seed: rebuilt.addresses.task_seed,
    vault_token_account: rebuilt.addresses.vault_token_account,
    vault_token_seed: rebuilt.addresses.vault_token_seed,
    vault_authority: rebuilt.addresses.vault_authority,
    vault_authority_bump: rebuilt.addresses.vault_authority_bump,
    recent_blockhash: resolved.recentBlockhash,
    task_rent_lamports: resolved.taskRentLamports,
    vault_token_rent_lamports: resolved.vaultTokenRentLamports,
    instructions: rebuilt.instructions.map((instruction, index) => ({
      index,
      name: instruction.name,
      program_id: instruction.programId,
      accounts: instruction.accounts.map((account) => ({
        pubkey: account.pubkey,
        signer: account.signer,
        writable: account.writable,
      })),
      data_hex: `0x${Buffer.from(instruction.data).toString("hex")}`,
    })),
    account_keys: compiled.accountKeys.map((account) => ({
      pubkey: account.pubkey,
      signer: account.signer,
      writable: account.writable,
    })),
    wallet_payload: {
      format: "tasc.solana_wallet_transaction.v0",
      signer: message.buyer,
      signer_role: "buyer",
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
      capture_signature_as: "fund-signature",
      after_send: [
        "confirm the fund transaction on mainnet",
        "record fund signature, task_account, and vault_token_account with real:capture:record after wallet submission",
      ],
    },
    source: {
      built_by: "bin/build-production-fund-transaction.js",
      sends_transactions: false,
      accepts_private_keys: false,
      key_material_printed: false,
      calls_rpc: resolved.source.calls_rpc,
      rpc_host: resolved.source.rpc_host,
      rpc_url_printed: false,
      full_rpc_url_persisted: false,
      source_account_checked: resolved.source.source_account_checked,
      fresh_accounts_checked: resolved.source.fresh_accounts_checked,
      min_confirmation: resolved.minConfirmation,
      no_new_dependencies: true,
    },
  };
}

function validateArtifact(artifact) {
  assert(artifact && typeof artifact === "object", "artifact must be a JSON object");
  assert(artifact.kind === "tasc.production_fund_transaction", "artifact kind mismatch");
  assert(artifact.version === "0.1", "artifact version mismatch");
  assert(artifact.cluster === DEFAULT_CLUSTER, "artifact cluster must be solana-mainnet-beta");
  assert(artifact.network_type === "mainnet", "network_type must be mainnet");
  assert(artifact.amount && artifact.amount.base_units === DEFAULT_AMOUNT_BASE_UNITS, "artifact amount must be exactly 10000000");
  assert(artifact.token && artifact.token.decimals === DEFAULT_DECIMALS, "token decimals must be 6");
  assert(artifact.token.production_asset === true, "token must be marked as production asset");
  assertSolanaAddress(artifact.buyer, "buyer");
  assertSolanaAddress(artifact.verifier, "verifier");
  assertSolanaAddress(artifact.program_id, "program_id");
  assertSolanaAddress(artifact.token.mint, "token.mint");
  assertSolanaAddress(artifact.buyer_usdc_token_account, "buyer_usdc_token_account");
  assertSolanaAddress(artifact.task_account, "task_account");
  assertSolanaAddress(artifact.vault_token_account, "vault_token_account");
  assertSolanaAddress(artifact.vault_authority, "vault_authority");
  assertBlockhash(artifact.recent_blockhash);
  assertU64(artifact.task_rent_lamports, "task_rent_lamports");
  assertU64(artifact.vault_token_rent_lamports, "vault_token_rent_lamports");
  assert(Array.isArray(artifact.instructions) && artifact.instructions.length === 5, "fund artifact must contain five instructions");
  assert(artifact.instructions[0].name === "create_task_account", "first instruction must create task account");
  assert(artifact.instructions[1].name === "create_vault_token_account", "second instruction must create vault token account");
  assert(artifact.instructions[2].name === "spl_token.initialize_account3", "third instruction must initialize vault token account");
  assert(artifact.instructions[3].name === "spl_token.transfer_checked", "fourth instruction must transfer checked USDC");
  assert(artifact.instructions[4].name === "fund", "fifth instruction must call fund");
  const payload = artifact.wallet_payload || {};
  assert(payload.signer === artifact.buyer, "wallet payload signer must be buyer");
  assert(payload.signer_role === "buyer", "wallet payload signer role must be buyer");
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
    kind: "tasc.production_fund_transaction.validation",
    version: "0.1",
    instruction_count: artifact.instructions.length,
    wallet_payload_valid: true,
    sends_transactions: false,
    accepts_private_keys: false,
    no_new_dependencies: true,
  };
}

async function build(options, rpcCall = defaultRpcCall) {
  const artifact = await buildArtifact(options, rpcCall);
  validateArtifact(artifact);
  const out = path.resolve(options.out || DEFAULT_OUT);
  writeJson(out, artifact);
  return {
    ok: true,
    kind: "tasc.production_fund_transaction.build_result",
    version: "0.1",
    artifact_file: rel(out),
    task_account: artifact.task_account,
    vault_token_account: artifact.vault_token_account,
    vault_authority: artifact.vault_authority,
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
  return {
    ok: true,
    kind: "tasc.production_fund_transaction.plan",
    version: "0.1",
    goal: "build the unsigned mainnet wallet transaction that funds a 10 USDC Tasc task",
    default_signed_intent: options.signedIntent || DEFAULT_SIGNED_INTENT,
    default_output: options.out || DEFAULT_OUT,
    cluster: DEFAULT_CLUSTER,
    network_type: "mainnet",
    sends_transactions: false,
    accepts_private_keys: false,
    key_material_printed: false,
    calls_rpc: false,
    writes_files: false,
    required_inputs: [
      "verified signed mainnet buyer intent",
      "buyer USDC source token account",
      "either --production-rpc-url or explicit --recent-blockhash, --task-rent-lamports, and --vault-token-rent-lamports",
    ],
    commands: {
      build_with_rpc: "npm run real:fund:build -- --signed-intent .tascverifier/production-intent/production-intent.signature.json --buyer-usdc-token-account <buyer-usdc-account> --production-rpc-url <mainnet-rpc-url>",
      build_without_rpc: "npm run real:fund:build -- --signed-intent .tascverifier/production-intent/production-intent.signature.json --buyer-usdc-token-account <buyer-usdc-account> --recent-blockhash <blockhash> --task-rent-lamports <lamports> --vault-token-rent-lamports <lamports>",
      validate: "npm run real:fund:validate -- .tascverifier/production-fund-transaction.json",
    },
    notes: [
      "The RPC path is read-only and only stores the RPC host, never the full URL.",
      "The output is unsigned; submit it through a buyer wallet and capture the returned fund signature.",
      "The builder refuses non-mainnet signed intents and exactly targets the 10 USDC MVP funding amount.",
    ],
  };
}

function sampleAddress(byte) {
  return base58Encode(Buffer.alloc(32, byte));
}

function signedIntentFixture(file, cluster = DEFAULT_CLUSTER) {
  const buyer = fixtureKeypair("buyer");
  const verifier = fixtureKeypair("verifier");
  const programId = sampleAddress(21);
  const tokenMint = sampleAddress(22);
  const { intent } = createSolanaIntent("examples/summarize_url.tasc", {
    buyer: buyer.address,
    verifier: verifier.address,
    programId,
    tokenMint,
    now: 1800000000,
    nonce: "4242",
    decimals: DEFAULT_DECIMALS,
    cluster,
    inputs: { url: "https://docs.cdp.coinbase.com/x402/welcome" },
  });
  const signed = signSolanaIntent(intent, buyer);
  writeJson(file, signed);
  return { signed, buyer, verifier, programId, tokenMint };
}

function mockRpcCall(input, options = {}) {
  return async (_rpcUrl, method, params) => {
    if (method === "getLatestBlockhash") {
      return {
        value: {
          blockhash: sampleAddress(30),
          lastValidBlockHeight: 123456,
        },
      };
    }
    if (method === "getMinimumBalanceForRentExemption") {
      if (params[0] === TASK_ACCOUNT_SIZE) return 2039280;
      if (params[0] === TOKEN_ACCOUNT_SIZE) return 2039280;
      throw new Error(`unexpected rent size ${params[0]}`);
    }
    if (method === "getAccountInfo") {
      const pubkey = params[0];
      if (pubkey === input.buyerTokenAccount) {
        return {
          value: {
            owner: TOKEN_PROGRAM_ID,
            data: [
              encodeTokenAccount({
                pubkey,
                mint: input.tokenMint,
                owner: input.buyer,
                amount: options.shortBuyerBalance ? "9999999" : DEFAULT_AMOUNT_BASE_UNITS,
              }).toString("base64"),
              "base64",
            ],
          },
        };
      }
      if (pubkey === input.taskAccount || pubkey === input.vaultTokenAccount) {
        return {
          value: options.accountAlreadyExists ? { owner: input.programId, data: ["", "base64"] } : null,
        };
      }
      throw new Error(`unexpected account ${pubkey}`);
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
}

async function selfTest() {
  fs.mkdirSync(path.join(ROOT, ".tascverifier"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, ".tascverifier", "production-fund-tx-"));
  const signedFile = path.join(dir, "production-intent.signature.json");
  const fixture = signedIntentFixture(signedFile);
  const buyerTokenAccount = sampleAddress(23);
  const preview = buildFundWithSplVaultInstructions(fixture.signed, {
    task_lamports: "2039280",
    vault_token_lamports: "2039280",
    buyer_token_account: buyerTokenAccount,
    token_decimals: DEFAULT_DECIMALS,
  });
  const baseOptions = {
    signedIntent: signedFile,
    buyerUsdcTokenAccount: buyerTokenAccount,
    productionRpcUrl: "https://mainnet.example.com/sensitive/rpc?credential=do-not-store",
    minConfirmation: DEFAULT_COMMITMENT,
    out: path.join(dir, "production-fund-transaction.json"),
    allowTestRpcHost: true,
  };
  const rpcInput = {
    buyer: fixture.buyer.address,
    buyerTokenAccount,
    tokenMint: fixture.tokenMint,
    programId: fixture.programId,
    taskAccount: preview.addresses.task_account,
    vaultTokenAccount: preview.addresses.vault_token_account,
  };
  const planResult = plan();
  assert(planResult.sends_transactions === false, "plan must not send transactions");
  assert(planResult.calls_rpc === false, "plan must not call RPC");
  assert(planResult.writes_files === false, "plan must not write files");

  const result = await build(baseOptions, mockRpcCall(rpcInput));
  assert(result.ok === true, "build should succeed");
  assert(fs.existsSync(baseOptions.out), "artifact should be written");
  const artifact = loadJson(baseOptions.out);
  assert(artifact.source.calls_rpc === true, "RPC build should mark calls_rpc");
  assert(artifact.source.rpc_host === "mainnet.example.com", "artifact should only store RPC host");
  assert(!JSON.stringify(artifact).includes("do-not-store"), "artifact must not store RPC query credential");
  assert(!JSON.stringify(artifact).includes("/sensitive/rpc"), "artifact must not store full RPC path");
  validateArtifact(artifact);

  const manualArtifact = await buildArtifact({
    ...baseOptions,
    productionRpcUrl: "",
    recentBlockhash: sampleAddress(31),
    taskRentLamports: "2039280",
    vaultTokenRentLamports: "2039280",
  });
  assert(manualArtifact.source.calls_rpc === false, "manual build should not call RPC");
  validateArtifact(manualArtifact);

  const devnetSignedFile = path.join(dir, "devnet.signature.json");
  signedIntentFixture(devnetSignedFile, "devnet");
  let rejectedDevnet = false;
  try {
    await buildArtifact({
      ...baseOptions,
      signedIntent: devnetSignedFile,
    }, mockRpcCall(rpcInput));
  } catch {
    rejectedDevnet = true;
  }
  assert(rejectedDevnet, "devnet signed intents should be rejected");

  let rejectedShortBuyerBalance = false;
  try {
    await buildArtifact(baseOptions, mockRpcCall(rpcInput, { shortBuyerBalance: true }));
  } catch {
    rejectedShortBuyerBalance = true;
  }
  assert(rejectedShortBuyerBalance, "short buyer USDC balance should be rejected");

  let rejectedExistingAccounts = false;
  try {
    await buildArtifact(baseOptions, mockRpcCall(rpcInput, { accountAlreadyExists: true }));
  } catch {
    rejectedExistingAccounts = true;
  }
  assert(rejectedExistingAccounts, "existing task/vault accounts should be rejected");

  return {
    ok: true,
    self_test: true,
    plan_safe: true,
    build_with_rpc: true,
    build_without_rpc: true,
    validate_artifact: true,
    rejected_devnet: rejectedDevnet,
    rejected_short_buyer_balance: rejectedShortBuyerBalance,
    rejected_existing_accounts: rejectedExistingAccounts,
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
    console.error(`build-production-fund-transaction: ${error.message}`);
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
