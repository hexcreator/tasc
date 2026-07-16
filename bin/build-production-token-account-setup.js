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
const { compileLegacyMessage } = require("./run-solana-fund");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CREATE_ASSOCIATED_TOKEN_ACCOUNT_IDEMPOTENT_TAG,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  decodeTokenAccountData,
  encodeTokenAccount,
} = require("./tascsolana-spl");
const {
  DEFAULT_ENV_FILE,
  PRODUCTION_ENV,
  envMetadata,
  withProductionEnv,
} = require("./production-env");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_CLUSTER = "solana-mainnet-beta";
const DEFAULT_COMMITMENT = "confirmed";
const DEFAULT_AMOUNT_BASE_UNITS = "10000000";
const DEFAULT_DECIMALS = 6;
const ROLES = new Set(["buyer", "worker"]);
const TEST_RPC_HOST_RE = /(devnet|testnet|localhost|127\.0\.0\.1|0\.0\.0\.0|(^|\.)example\.(com|net|org|invalid)$)/i;

function usage() {
  console.error([
    "Usage:",
    "  node bin/build-production-token-account-setup.js plan [options]",
    "  node bin/build-production-token-account-setup.js build [options]",
    "  node bin/build-production-token-account-setup.js validate <artifact.json>",
    "  node bin/build-production-token-account-setup.js --self-test",
    "",
    "Build options:",
    "  --env <file>                              production env file; default .env.solana-mainnet.local",
    "  --role buyer|worker                       USDC token account owner role",
    "  --owner <address>                         token account owner; defaults to role wallet env",
    "  --payer <address>                         rent payer and transaction signer; defaults to owner",
    "  --usdc-mint <address>                     verified mainnet USDC mint; defaults to env",
    "  --usdc-token-account <address>            optional associated token account; defaults to derived ATA",
    "  --production-rpc-url <url>                optional read-only mainnet RPC for blockhash/account check",
    "  --recent-blockhash <hash>                 required without --production-rpc-url",
    "  --min-confirmation <status>               processed, confirmed, or finalized; default confirmed",
    "  --out <file>                              output artifact; default .tascverifier/production-token-account-setup-<role>.json",
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
    envFile: DEFAULT_ENV_FILE,
    role: "",
    owner: "",
    payer: "",
    usdcMint: "",
    usdcTokenAccount: "",
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
    else if (arg === "--role") options.role = requireValue(args, ++i, arg);
    else if (arg === "--owner") options.owner = requireValue(args, ++i, arg);
    else if (arg === "--payer") options.payer = requireValue(args, ++i, arg);
    else if (arg === "--usdc-mint") options.usdcMint = requireValue(args, ++i, arg);
    else if (arg === "--usdc-token-account") options.usdcTokenAccount = requireValue(args, ++i, arg);
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

function requireValue(args, index, label) {
  const value = args[index] || "";
  if (!value) throw new Error(`${label} requires a value`);
  return value;
}

function normalizeRole(role) {
  const value = String(role || "").toLowerCase().replace(/[_\s]+/g, "-");
  assert(ROLES.has(value), "role must be buyer or worker");
  return value;
}

function optionsWithEnv(options = {}) {
  const mapping = {
    productionRpcUrl: PRODUCTION_ENV.rpcUrl,
    usdcMint: PRODUCTION_ENV.tokenMint,
  };
  const role = String(options.role || "").toLowerCase().replace(/[_\s]+/g, "-");
  if (role === "buyer") {
    mapping.owner = PRODUCTION_ENV.buyer;
    mapping.usdcTokenAccount = PRODUCTION_ENV.buyerUsdc;
  }
  if (role === "worker") {
    mapping.owner = PRODUCTION_ENV.worker;
    mapping.usdcTokenAccount = PRODUCTION_ENV.workerUsdc;
  }
  return withProductionEnv(options, mapping);
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

function artifactPath(options) {
  if (options.out) return path.resolve(options.out);
  const role = options.role ? normalizeRole(options.role) : "role";
  return path.resolve(".tascverifier", `production-token-account-setup-${role}.json`);
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

async function fetchTokenAccount(rpcUrl, pubkey, commitment, rpcCall) {
  const result = await rpcCall(rpcUrl, "getAccountInfo", [
    pubkey,
    {
      commitment,
      encoding: "base64",
    },
  ]);
  const value = result && result.value;
  if (!value) return { exists: false, decoded: null };
  assert(value.owner === TOKEN_PROGRAM_ID, "existing USDC token account must be owned by the SPL Token Program");
  assert(Array.isArray(value.data) && value.data[1] === "base64", "existing USDC token account must return base64 data");
  return { exists: true, decoded: decodeTokenAccountData(value.data[0]) };
}

async function resolveInputs(options, tokenAccount, owner, mint, rpcCall) {
  const commitment = assertConfirmation(options.minConfirmation || DEFAULT_COMMITMENT);
  const source = {
    calls_rpc: false,
    rpc_host: null,
    rpc_url_printed: false,
    full_rpc_url_persisted: false,
    token_account_checked: false,
    token_account_exists: false,
    min_confirmation: commitment,
  };
  if (options.productionRpcUrl) {
    const url = assertHttpUrl(options.productionRpcUrl, "production_rpc_url");
    if (!options.allowTestRpcHost && TEST_RPC_HOST_RE.test(url.host)) {
      throw new Error("production RPC host must not look like devnet/testnet/local/example");
    }
    const [latest, account] = await Promise.all([
      rpcCall(options.productionRpcUrl, "getLatestBlockhash", [{ commitment }]),
      fetchTokenAccount(options.productionRpcUrl, tokenAccount, commitment, rpcCall),
    ]);
    if (account.exists) {
      assert(account.decoded.mint === mint, "existing USDC token account mint mismatch");
      assert(account.decoded.owner === owner, "existing USDC token account owner mismatch");
    }
    source.calls_rpc = true;
    source.rpc_host = url.host;
    source.token_account_checked = true;
    source.token_account_exists = account.exists;
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

function signerRoleForPayer(payer, role, resolved) {
  if (payer === resolved.owner) return role;
  if (payer === resolved.buyer) return "buyer";
  if (payer === resolved.worker) return "worker";
  if (payer === resolved.verifier) return "verifier";
  return "payer";
}

async function buildArtifact(options = {}, rpcCall = defaultRpcCall) {
  options = optionsWithEnv(options);
  const role = normalizeRole(options.role);
  const owner = assertSolanaAddress(options.owner, `${role} wallet`);
  const payer = assertSolanaAddress(options.payer || owner, "payer");
  const mint = assertSolanaAddress(options.usdcMint, "usdc_mint");
  const expectedTokenAccount = associatedTokenAddress(owner, mint);
  const tokenAccount = options.usdcTokenAccount
    ? assertSolanaAddress(options.usdcTokenAccount, "usdc_token_account")
    : expectedTokenAccount;
  assert(tokenAccount === expectedTokenAccount, `${role} USDC token account must be the associated token account for owner and mint`);
  const resolved = await resolveInputs(options, tokenAccount, owner, mint, rpcCall);
  const instruction = createAssociatedTokenAccountIdempotentInstruction({
    payer,
    owner,
    mint,
    account: tokenAccount,
  });
  const compiled = compileLegacyMessage({
    payer,
    recentBlockhash: resolved.recentBlockhash,
    instructions: [instruction],
  });
  const messageBytes = Buffer.from(compiled.message);
  const unsignedTransaction = encodeUnsignedTransaction(messageBytes);
  const signerRole = signerRoleForPayer(payer, role, {
    owner,
    buyer: role === "buyer" ? owner : options.buyer,
    worker: role === "worker" ? owner : options.worker,
    verifier: options.verifier,
  });

  return {
    ok: true,
    kind: "tasc.production_token_account_setup_transaction",
    version: "0.1",
    generated_at: new Date().toISOString(),
    role,
    owner_role: role,
    signer: payer,
    signer_role: signerRole,
    payer,
    owner,
    cluster: DEFAULT_CLUSTER,
    network_type: "mainnet",
    token: {
      symbol: "USDC",
      mint,
      decimals: DEFAULT_DECIMALS,
      production_asset: true,
    },
    production_goal_amount: {
      display: "10 USDC",
      base_units: DEFAULT_AMOUNT_BASE_UNITS,
    },
    associated_token_account: tokenAccount,
    token_program_id: TOKEN_PROGRAM_ID,
    associated_token_program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
    recent_blockhash: resolved.recentBlockhash,
    instruction: {
      name: instruction.name,
      program_id: instruction.programId,
      accounts: instruction.accounts.map((account) => ({
        pubkey: account.pubkey,
        signer: account.signer,
        writable: account.writable,
      })),
      data_hex: `0x${Buffer.from(instruction.data).toString("hex")}`,
    },
    account_keys: compiled.accountKeys.map((account) => ({
      pubkey: account.pubkey,
      signer: account.signer,
      writable: account.writable,
    })),
    wallet_payload: {
      format: "tasc.solana_wallet_transaction.v0",
      signer: payer,
      signer_role: signerRole,
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
      capture_signature_as: `${role}-usdc-ata-setup-signature`,
      after_send: [
        `confirm the ${role} USDC associated token account setup transaction on mainnet`,
        "rerun npm run real:preflight -- --env .env.solana-mainnet.local",
      ],
    },
    source: {
      built_by: "bin/build-production-token-account-setup.js",
      ...envMetadata(options.envFile, [
        PRODUCTION_ENV.rpcUrl,
        PRODUCTION_ENV.tokenMint,
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
      token_account_checked: resolved.source.token_account_checked,
      token_account_exists: resolved.source.token_account_exists,
      min_confirmation: resolved.source.min_confirmation,
      no_new_dependencies: true,
    },
  };
}

function validateArtifact(artifact) {
  assert(artifact && typeof artifact === "object", "artifact must be a JSON object");
  assert(artifact.kind === "tasc.production_token_account_setup_transaction", "artifact kind mismatch");
  assert(artifact.version === "0.1", "artifact version mismatch");
  const role = normalizeRole(artifact.role);
  assert(artifact.owner_role === role, "owner role mismatch");
  assert(artifact.cluster === DEFAULT_CLUSTER, "artifact cluster must be solana-mainnet-beta");
  assert(artifact.network_type === "mainnet", "network_type must be mainnet");
  assert(artifact.token && artifact.token.decimals === DEFAULT_DECIMALS, "token decimals must be 6");
  assert(artifact.token.production_asset === true, "token must be marked as production asset");
  assert(artifact.token.symbol === "USDC", "token symbol must be USDC");
  assertSolanaAddress(artifact.signer, "signer");
  assertSolanaAddress(artifact.payer, "payer");
  assertSolanaAddress(artifact.owner, "owner");
  assert(artifact.signer === artifact.payer, "signer must be payer");
  assert(["buyer", "worker", "verifier", "payer"].includes(artifact.signer_role), "signer_role mismatch");
  assertSolanaAddress(artifact.token.mint, "token.mint");
  assertSolanaAddress(artifact.associated_token_account, "associated_token_account");
  assert(artifact.associated_token_account === associatedTokenAddress(artifact.owner, artifact.token.mint), "associated token account derivation mismatch");
  assert(artifact.token_program_id === TOKEN_PROGRAM_ID, "token program mismatch");
  assert(artifact.associated_token_program_id === ASSOCIATED_TOKEN_PROGRAM_ID, "associated token program mismatch");
  assertBlockhash(artifact.recent_blockhash);
  const instruction = artifact.instruction || {};
  assert(instruction.name === "associated_token.create_idempotent", "instruction name mismatch");
  assert(instruction.program_id === ASSOCIATED_TOKEN_PROGRAM_ID, "instruction program mismatch");
  assert(instruction.data_hex === `0x0${CREATE_ASSOCIATED_TOKEN_ACCOUNT_IDEMPOTENT_TAG}`, "instruction data mismatch");
  assert(Array.isArray(instruction.accounts) && instruction.accounts.length === 6, "instruction must contain six accounts");
  const expectedAccounts = [
    { pubkey: artifact.payer, signer: true, writable: true },
    { pubkey: artifact.associated_token_account, signer: false, writable: true },
    { pubkey: artifact.owner, signer: false, writable: false },
    { pubkey: artifact.token.mint, signer: false, writable: false },
    { pubkey: SYSTEM_PROGRAM_ID, signer: false, writable: false },
    { pubkey: TOKEN_PROGRAM_ID, signer: false, writable: false },
  ];
  expectedAccounts.forEach((expected, index) => {
    const actual = instruction.accounts[index] || {};
    assert(actual.pubkey === expected.pubkey, `instruction account ${index} pubkey mismatch`);
    assert(actual.signer === expected.signer, `instruction account ${index} signer mismatch`);
    assert(actual.writable === expected.writable, `instruction account ${index} writable mismatch`);
  });
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
    kind: "tasc.production_token_account_setup_transaction.validation",
    version: "0.1",
    role,
    associated_token_account: artifact.associated_token_account,
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
    kind: "tasc.production_token_account_setup_transaction.build_result",
    version: "0.1",
    role: artifact.role,
    artifact_file: rel(out),
    signer: artifact.signer,
    signer_role: artifact.signer_role,
    owner: artifact.owner,
    associated_token_account: artifact.associated_token_account,
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
    kind: "tasc.production_token_account_setup_transaction.plan",
    version: "0.1",
    goal: "build unsigned mainnet wallet transactions that create missing buyer/worker USDC associated token accounts",
    default_env_file: envFile,
    default_output_pattern: ".tascverifier/production-token-account-setup-<role>.json",
    cluster: DEFAULT_CLUSTER,
    network_type: "mainnet",
    sends_transactions: false,
    accepts_private_keys: false,
    key_material_printed: false,
    calls_rpc: false,
    writes_files: false,
    required_inputs: [
      "buyer or worker wallet owner from --owner or env",
      "mainnet USDC mint from --usdc-mint or env",
      "either --production-rpc-url/env RPC or --recent-blockhash",
      "a connected wallet matching the artifact payer/signer when submitting",
    ],
    commands: {
      build_buyer_with_env_rpc: `npm run real:token-account:build -- --env ${envFile} --role buyer`,
      build_worker_with_env_rpc: `npm run real:token-account:build -- --env ${envFile} --role worker`,
      build_without_rpc: "npm run real:token-account:build -- --role buyer --owner <wallet> --usdc-mint <mainnet-usdc-mint> --recent-blockhash <blockhash>",
      validate: "npm run real:token-account:validate -- .tascverifier/production-token-account-setup-buyer.json",
      submitter: "npm run real:submitter:serve",
      rerun_preflight: `npm run real:preflight -- --env ${envFile}`,
    },
    notes: [
      "The RPC path is read-only and only stores the RPC host, never the full URL.",
      "The instruction is idempotent, so submitting it is safe if the associated token account already exists with the same owner and mint.",
      "The output is unsigned; submit it through the payer wallet and then rerun production preflight.",
    ],
  };
}

function sampleAddress(byte) {
  return base58Encode(Buffer.alloc(32, byte));
}

function mockRpcCall(input, overrides = {}) {
  return async (_rpcUrl, method, params) => {
    if (method === "getLatestBlockhash") {
      return {
        value: {
          blockhash: sampleAddress(30),
          lastValidBlockHeight: 123456,
        },
      };
    }
    if (method === "getAccountInfo") {
      const pubkey = params[0];
      if (pubkey === input.tokenAccount) {
        if (overrides.missingAccount) return { value: null };
        return {
          value: {
            owner: TOKEN_PROGRAM_ID,
            executable: false,
            lamports: 2_039_280,
            data: [
              encodeTokenAccount({
                pubkey,
                mint: overrides.badMint ? sampleAddress(91) : input.mint,
                owner: overrides.badOwner ? sampleAddress(92) : input.owner,
                amount: "0",
              }).toString("base64"),
              "base64",
            ],
          },
        };
      }
      throw new Error(`unexpected account ${pubkey}`);
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
}

async function selfTest() {
  fs.mkdirSync(path.join(ROOT, ".tascverifier"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, ".tascverifier", "production-token-account-setup-"));
  const buyer = sampleAddress(4);
  const worker = sampleAddress(5);
  const verifier = sampleAddress(6);
  const mint = sampleAddress(7);
  const buyerAta = associatedTokenAddress(buyer, mint);
  const workerAta = associatedTokenAddress(worker, mint);
  const envFile = path.join(dir, ".env.solana-mainnet.local");
  fs.writeFileSync(envFile, [
    `${PRODUCTION_ENV.rpcUrl}=https://mainnet.example.com/sensitive/rpc?credential=env-do-not-store`,
    `${PRODUCTION_ENV.tokenMint}=${mint}`,
    `${PRODUCTION_ENV.buyer}=${buyer}`,
    `${PRODUCTION_ENV.worker}=${worker}`,
    `${PRODUCTION_ENV.verifier}=${verifier}`,
    `${PRODUCTION_ENV.buyerUsdc}=${buyerAta}`,
    `${PRODUCTION_ENV.workerUsdc}=${workerAta}`,
    "",
  ].join("\n"));

  const planResult = plan();
  assert(planResult.sends_transactions === false, "plan must not send transactions");
  assert(planResult.calls_rpc === false, "plan must not call RPC");
  assert(planResult.writes_files === false, "plan must not write files");

  const buyerOptions = {
    envFile,
    role: "buyer",
    owner: buyer,
    usdcMint: mint,
    usdcTokenAccount: buyerAta,
    productionRpcUrl: "https://mainnet.example.com/sensitive/rpc?credential=do-not-store",
    minConfirmation: DEFAULT_COMMITMENT,
    out: path.join(dir, "production-token-account-setup-buyer.json"),
    allowTestRpcHost: true,
  };
  const result = await build(buyerOptions, mockRpcCall({
    owner: buyer,
    mint,
    tokenAccount: buyerAta,
  }, { missingAccount: true }));
  assert(result.ok === true, "buyer setup build should succeed");
  const artifact = loadJson(buyerOptions.out);
  assert(artifact.source.calls_rpc === true, "RPC build should mark calls_rpc");
  assert(artifact.source.rpc_host === "mainnet.example.com", "artifact should only store RPC host");
  assert(artifact.source.token_account_exists === false, "missing account should be marked");
  assert(!JSON.stringify(artifact).includes("do-not-store"), "artifact must not store RPC query credential");
  assert(!JSON.stringify(artifact).includes("/sensitive/rpc"), "artifact must not store full RPC path");
  validateArtifact(artifact);

  const existingArtifact = await buildArtifact({
    ...buyerOptions,
    out: path.join(dir, "existing.json"),
  }, mockRpcCall({
    owner: buyer,
    mint,
    tokenAccount: buyerAta,
  }));
  assert(existingArtifact.source.token_account_exists === true, "existing account should be marked");
  validateArtifact(existingArtifact);

  const manualWorker = await buildArtifact({
    role: "worker",
    owner: worker,
    usdcMint: mint,
    usdcTokenAccount: workerAta,
    recentBlockhash: sampleAddress(31),
  });
  assert(manualWorker.source.calls_rpc === false, "manual build should not call RPC");
  assert(manualWorker.signer_role === "worker", "manual worker signer role mismatch");
  validateArtifact(manualWorker);

  const envWorker = await buildArtifact({
    envFile,
    role: "worker",
    allowTestRpcHost: true,
  }, mockRpcCall({
    owner: worker,
    mint,
    tokenAccount: workerAta,
  }, { missingAccount: true }));
  assert(envWorker.owner === worker, "env build should load worker owner");
  assert(envWorker.associated_token_account === workerAta, "env build should load worker token account");
  validateArtifact(envWorker);

  let rejectedBadMint = false;
  try {
    await buildArtifact(buyerOptions, mockRpcCall({
      owner: buyer,
      mint,
      tokenAccount: buyerAta,
    }, { badMint: true }));
  } catch {
    rejectedBadMint = true;
  }
  assert(rejectedBadMint, "existing ATA with wrong mint should be rejected");

  let rejectedWrongAta = false;
  try {
    await buildArtifact({
      ...buyerOptions,
      productionRpcUrl: "",
      recentBlockhash: sampleAddress(33),
      usdcTokenAccount: workerAta,
    });
  } catch {
    rejectedWrongAta = true;
  }
  assert(rejectedWrongAta, "non-derived associated token account should be rejected");

  return {
    ok: true,
    self_test: true,
    plan_safe: true,
    build_with_rpc: true,
    build_without_rpc: true,
    build_with_env: true,
    validate_artifact: true,
    rejected_bad_existing_mint: rejectedBadMint,
    rejected_wrong_associated_token_account: rejectedWrongAta,
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
    console.error(`build-production-token-account-setup: ${error.message}`);
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
