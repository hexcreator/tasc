#!/usr/bin/env node

const fs = require("fs");
const {
  assertBase58Address,
  base58Decode,
  base58Encode,
  formatSol,
  lamportsFromSol,
  rpcCall: defaultRpcCall,
} = require("./run-solana-devnet");
const {
  MINT_ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  decodeMintAccountData,
  decodeTokenAccountData,
  encodeTokenAccount,
} = require("./tascsolana-spl");

const DEFAULT_ENV_FILE = ".env.solana-mainnet.local";
const DEFAULT_MIN_ROLE_SOL = "0.02";
const DEFAULT_USDC_BASE_UNITS = "10000000";
const DEFAULT_COMMITMENT = "finalized";
const MAINNET_CLUSTER = "solana-mainnet-beta";
const PROGRAM_OWNERS = new Set([
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
]);
const TEST_RPC_HOST_RE = /(devnet|testnet|localhost|127\.0\.0\.1|0\.0\.0\.0)/i;

const ENV = {
  rpcUrl: "SOLANA_MAINNET_RPC_URL",
  expectedGenesisHash: "SOLANA_MAINNET_EXPECTED_GENESIS_HASH",
  programId: "GLOBAL_TASC_SOLANA_MAINNET_PROGRAM_ID",
  usdcMint: "GLOBAL_TASC_SOLANA_MAINNET_USDC_MINT",
  buyer: "GLOBAL_TASC_SOLANA_MAINNET_BUYER_ADDRESS",
  worker: "GLOBAL_TASC_SOLANA_MAINNET_WORKER_ADDRESS",
  verifier: "GLOBAL_TASC_SOLANA_MAINNET_VERIFIER_ADDRESS",
  fallbackBuyer: "GLOBAL_TASC_SOLANA_BUYER_ADDRESS",
  fallbackWorker: "GLOBAL_TASC_SOLANA_WORKER_ADDRESS",
  fallbackVerifier: "GLOBAL_TASC_SOLANA_VERIFIER_ADDRESS",
  buyerUsdc: "GLOBAL_TASC_SOLANA_MAINNET_BUYER_USDC_TOKEN_ACCOUNT",
  workerUsdc: "GLOBAL_TASC_SOLANA_MAINNET_WORKER_USDC_TOKEN_ACCOUNT",
};

function usage() {
  console.error([
    "Usage:",
    "  node bin/solana-production-preflight.js plan [options]",
    "  node bin/solana-production-preflight.js check [options]",
    "  node bin/solana-production-preflight.js --self-test",
    "",
    "Options:",
    "  --env <file>                              env file; default .env.solana-mainnet.local",
    "  --production-rpc-url <url>                Solana mainnet RPC URL",
    "  --expected-genesis-hash <hash>            expected mainnet genesis hash",
    "  --program-id <address>                    deployed mainnet Global Tasc program id",
    "  --usdc-mint <address>                     verified mainnet USDC mint",
    "  --buyer <address>                         buyer wallet address",
    "  --worker <address>                        worker wallet address",
    "  --verifier <address>                      verifier wallet address",
    "  --buyer-usdc-token-account <address>      buyer USDC source account with >= 10 USDC",
    "  --worker-usdc-token-account <address>     worker USDC destination account",
    "  --min-role-sol <sol>                      minimum SOL per role; default 0.02",
    "  --min-buyer-usdc-base-units <n>           required buyer USDC base units; default 10000000",
    "  --min-worker-usdc-base-units <n>          required worker USDC base units; default 0",
    "  --commitment <status>                     processed, confirmed, or finalized; default finalized",
    "",
    "This preflight is read-only. It never accepts private keys and never sends transactions.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

function parseArgs(argv) {
  const options = {
    command: "plan",
    envFile: DEFAULT_ENV_FILE,
    productionRpcUrl: "",
    expectedGenesisHash: "",
    programId: "",
    usdcMint: "",
    buyer: "",
    worker: "",
    verifier: "",
    buyerUsdcTokenAccount: "",
    workerUsdcTokenAccount: "",
    minRoleSol: DEFAULT_MIN_ROLE_SOL,
    minBuyerUsdcBaseUnits: DEFAULT_USDC_BASE_UNITS,
    minWorkerUsdcBaseUnits: "0",
    commitment: DEFAULT_COMMITMENT,
    selfTest: false,
  };
  const args = [...argv];
  if (args[0] === "plan" || args[0] === "check") options.command = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = requireValue(args, ++i, arg);
    else if (arg === "--production-rpc-url") options.productionRpcUrl = requireValue(args, ++i, arg);
    else if (arg === "--expected-genesis-hash") options.expectedGenesisHash = requireValue(args, ++i, arg);
    else if (arg === "--program-id") options.programId = requireValue(args, ++i, arg);
    else if (arg === "--usdc-mint") options.usdcMint = requireValue(args, ++i, arg);
    else if (arg === "--buyer") options.buyer = requireValue(args, ++i, arg);
    else if (arg === "--worker") options.worker = requireValue(args, ++i, arg);
    else if (arg === "--verifier") options.verifier = requireValue(args, ++i, arg);
    else if (arg === "--buyer-usdc-token-account") options.buyerUsdcTokenAccount = requireValue(args, ++i, arg);
    else if (arg === "--worker-usdc-token-account") options.workerUsdcTokenAccount = requireValue(args, ++i, arg);
    else if (arg === "--min-role-sol") options.minRoleSol = requireValue(args, ++i, arg);
    else if (arg === "--min-buyer-usdc-base-units") options.minBuyerUsdcBaseUnits = requireValue(args, ++i, arg);
    else if (arg === "--min-worker-usdc-base-units") options.minWorkerUsdcBaseUnits = requireValue(args, ++i, arg);
    else if (arg === "--commitment") options.commitment = requireValue(args, ++i, arg);
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

function configFromOptions(options = {}, processEnv = process.env) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const env = { ...loadEnvFile(envFile), ...processEnv };
  return {
    envFile,
    rpcUrl: options.productionRpcUrl || env[ENV.rpcUrl] || "",
    expectedGenesisHash: options.expectedGenesisHash || env[ENV.expectedGenesisHash] || "",
    programId: options.programId || env[ENV.programId] || "",
    usdcMint: options.usdcMint || env[ENV.usdcMint] || "",
    buyer: options.buyer || env[ENV.buyer] || env[ENV.fallbackBuyer] || "",
    worker: options.worker || env[ENV.worker] || env[ENV.fallbackWorker] || "",
    verifier: options.verifier || env[ENV.verifier] || env[ENV.fallbackVerifier] || "",
    buyerUsdcTokenAccount: options.buyerUsdcTokenAccount || env[ENV.buyerUsdc] || "",
    workerUsdcTokenAccount: options.workerUsdcTokenAccount || env[ENV.workerUsdc] || "",
    minRoleSol: options.minRoleSol || DEFAULT_MIN_ROLE_SOL,
    minBuyerUsdcBaseUnits: options.minBuyerUsdcBaseUnits || DEFAULT_USDC_BASE_UNITS,
    minWorkerUsdcBaseUnits: options.minWorkerUsdcBaseUnits || "0",
    commitment: options.commitment || DEFAULT_COMMITMENT,
  };
}

function assertHttpUrl(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} is required`);
  const url = new URL(value);
  assert(url.protocol === "http:" || url.protocol === "https:", `${label} must be http(s)`);
  return url;
}

function assertSolanaAddress(value, label) {
  assertBase58Address(value, label);
  const decoded = base58Decode(value);
  assert(decoded.length === 32, `${label} must decode to 32 bytes`);
  return value;
}

function assertBaseUnits(value, label) {
  const raw = String(value || "");
  assert(/^[0-9]+$/.test(raw), `${label} must be integer base units`);
  return BigInt(raw);
}

function formatUsdc(baseUnits) {
  const value = BigInt(baseUnits);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function addMissing(blockers, value, label) {
  if (!value) blockers.push(`${label} is required`);
}

function safeConfiguredAddress(value, label, blockers) {
  if (!value) {
    blockers.push(`${label} is required`);
    return null;
  }
  try {
    return assertSolanaAddress(value, label);
  } catch (error) {
    blockers.push(error.message);
    return null;
  }
}

function safeBaseUnits(value, label, blockers) {
  try {
    return assertBaseUnits(value, label);
  } catch (error) {
    blockers.push(error.message);
    return 0n;
  }
}

function safeLamports(value, label, blockers) {
  try {
    return lamportsFromSol(value);
  } catch (error) {
    blockers.push(`${label}: ${error.message}`);
    return 0n;
  }
}

async function fetchAccount(rpcUrl, pubkey, commitment, rpcCall) {
  const result = await rpcCall(rpcUrl, "getAccountInfo", [
    pubkey,
    {
      commitment,
      encoding: "base64",
    },
  ]);
  return result && result.value ? result.value : null;
}

async function checkRoleBalances(input) {
  const roles = {
    buyer: input.config.buyer,
    worker: input.config.worker,
    verifier: input.config.verifier,
  };
  const balances = {};
  for (const [role, address] of Object.entries(roles)) {
    const result = await input.rpcCall(input.config.rpcUrl, "getBalance", [address, { commitment: input.config.commitment }]);
    const lamports = BigInt(result.value);
    balances[role] = {
      address,
      lamports: lamports.toString(),
      sol: formatSol(lamports),
      minimum_lamports: input.minRoleLamports.toString(),
      minimum_sol: formatSol(input.minRoleLamports),
      ok: lamports >= input.minRoleLamports,
    };
    if (!balances[role].ok) {
      input.blockers.push(`${role} SOL balance ${balances[role].sol} is below ${balances[role].minimum_sol}`);
    }
  }
  return balances;
}

async function checkProgram(input) {
  const account = await fetchAccount(input.config.rpcUrl, input.config.programId, input.config.commitment, input.rpcCall);
  if (!account) {
    input.blockers.push("mainnet program account not found");
    return {
      program_id: input.config.programId,
      exists: false,
      executable: false,
      ok: false,
    };
  }
  const ok = Boolean(account.executable) && PROGRAM_OWNERS.has(account.owner);
  if (!account.executable) input.blockers.push("mainnet program account is not executable");
  if (!PROGRAM_OWNERS.has(account.owner)) input.blockers.push(`mainnet program owner ${account.owner} is not a Solana BPF loader`);
  return {
    program_id: input.config.programId,
    exists: true,
    owner: account.owner,
    executable: Boolean(account.executable),
    lamports: String(account.lamports),
    ok,
  };
}

async function checkMint(input) {
  const account = await fetchAccount(input.config.rpcUrl, input.config.usdcMint, input.config.commitment, input.rpcCall);
  if (!account) {
    input.blockers.push("USDC mint account not found");
    return {
      mint: input.config.usdcMint,
      exists: false,
      ok: false,
    };
  }
  if (account.owner !== TOKEN_PROGRAM_ID) input.blockers.push("USDC mint account is not owned by the SPL Token Program");
  assert(Array.isArray(account.data) && account.data[1] === "base64", "USDC mint account must return base64 data");
  const decoded = decodeMintAccountData(account.data[0]);
  if (decoded.decimals !== 6) input.blockers.push(`USDC mint decimals expected 6, got ${decoded.decimals}`);
  if (decoded.initialized !== true) input.blockers.push("USDC mint is not initialized");
  return {
    mint: input.config.usdcMint,
    exists: true,
    owner: account.owner,
    decimals: decoded.decimals,
    initialized: decoded.initialized,
    supply: decoded.supply,
    ok: account.owner === TOKEN_PROGRAM_ID && decoded.decimals === 6 && decoded.initialized === true,
  };
}

async function checkTokenAccount(input, role, pubkey, minimumBaseUnits) {
  const account = await fetchAccount(input.config.rpcUrl, pubkey, input.config.commitment, input.rpcCall);
  if (!account) {
    input.blockers.push(`${role} USDC token account not found`);
    return {
      role,
      pubkey,
      exists: false,
      ok: false,
    };
  }
  if (account.owner !== TOKEN_PROGRAM_ID) input.blockers.push(`${role} USDC token account is not owned by the SPL Token Program`);
  assert(Array.isArray(account.data) && account.data[1] === "base64", `${role} token account must return base64 data`);
  const decoded = decodeTokenAccountData(account.data[0]);
  if (decoded.mint !== input.config.usdcMint) input.blockers.push(`${role} USDC token account mint mismatch`);
  const amount = BigInt(decoded.amount);
  if (amount < minimumBaseUnits) input.blockers.push(`${role} USDC balance ${formatUsdc(amount)} is below ${formatUsdc(minimumBaseUnits)}`);
  return {
    role,
    pubkey,
    exists: true,
    owner: account.owner,
    token_owner: decoded.owner,
    mint: decoded.mint,
    amount: decoded.amount,
    display_usdc: formatUsdc(amount),
    minimum_base_units: minimumBaseUnits.toString(),
    minimum_display_usdc: formatUsdc(minimumBaseUnits),
    ok: account.owner === TOKEN_PROGRAM_ID && decoded.mint === input.config.usdcMint && amount >= minimumBaseUnits,
  };
}

function plan(options = {}, processEnv = process.env) {
  const config = configFromOptions(options, processEnv);
  return {
    ok: true,
    kind: "tasc.solana.production_preflight.plan",
    version: "0.1",
    goal: "prove mainnet prerequisites before attempting a real 10 USDC under-60s payout",
    cluster: MAINNET_CLUSTER,
    env_file: config.envFile,
    env_file_exists: fs.existsSync(config.envFile),
    sends_transactions: false,
    accepts_private_keys: false,
    key_material_printed: false,
    calls_rpc: false,
    writes_files: false,
    required_env: [
      ENV.rpcUrl,
      ENV.expectedGenesisHash,
      ENV.programId,
      ENV.usdcMint,
      ENV.buyer,
      ENV.worker,
      ENV.verifier,
      ENV.buyerUsdc,
      ENV.workerUsdc,
    ],
    configured: {
      rpc_url_set: Boolean(config.rpcUrl),
      expected_genesis_hash_set: Boolean(config.expectedGenesisHash),
      program_id_set: Boolean(config.programId),
      usdc_mint_set: Boolean(config.usdcMint),
      buyer_set: Boolean(config.buyer),
      worker_set: Boolean(config.worker),
      verifier_set: Boolean(config.verifier),
      buyer_usdc_token_account_set: Boolean(config.buyerUsdcTokenAccount),
      worker_usdc_token_account_set: Boolean(config.workerUsdcTokenAccount),
      min_role_sol: config.minRoleSol,
      min_buyer_usdc_base_units: config.minBuyerUsdcBaseUnits,
      min_worker_usdc_base_units: config.minWorkerUsdcBaseUnits,
    },
    next_commands: {
      check: "npm run real:preflight -- --production-rpc-url <mainnet-rpc-url> --expected-genesis-hash <mainnet-genesis-hash> --program-id <program-id> --usdc-mint <mainnet-usdc-mint> --buyer <buyer> --worker <worker> --verifier <verifier> --buyer-usdc-token-account <buyer-usdc-account> --worker-usdc-token-account <worker-usdc-account>",
      build_payout_evidence: "npm run real:payout:build -- --token-mint <mainnet-usdc-mint> --task-account <task-account> --vault-token-account <vault-token-account> --destination-token-account <worker-usdc-account> --fund-signature <sig> --claim-signature <sig> --attest-signature <sig> --release-signature <sig> --claim-to-release-ms <ms> --claim-to-completed-index-ms <ms> --production-rpc-url <mainnet-rpc-url>",
    },
  };
}

async function check(options = {}, rpcCall = defaultRpcCall, processEnv = process.env) {
  const config = configFromOptions(options, processEnv);
  const blockers = [];
  const rpcUrl = config.rpcUrl;
  let rpcHost = null;
  let minRoleLamports = 0n;
  let minBuyerUsdc = 0n;
  let minWorkerUsdc = 0n;

  if (!["processed", "confirmed", "finalized"].includes(config.commitment)) {
    blockers.push("commitment must be processed, confirmed, or finalized");
  }

  if (!rpcUrl) {
    blockers.push(`${ENV.rpcUrl} or --production-rpc-url is required`);
  } else {
    try {
      const url = assertHttpUrl(rpcUrl, "production_rpc_url");
      rpcHost = url.host;
      if (!options.allowTestRpcHost && TEST_RPC_HOST_RE.test(rpcHost)) {
        blockers.push("production RPC host must not look like devnet/testnet/local");
      }
    } catch (error) {
      blockers.push(error.message);
    }
  }

  addMissing(blockers, config.expectedGenesisHash, "expected mainnet genesis hash");
  const validated = {
    programId: safeConfiguredAddress(config.programId, "program_id", blockers),
    usdcMint: safeConfiguredAddress(config.usdcMint, "usdc_mint", blockers),
    buyer: safeConfiguredAddress(config.buyer, "buyer address", blockers),
    worker: safeConfiguredAddress(config.worker, "worker address", blockers),
    verifier: safeConfiguredAddress(config.verifier, "verifier address", blockers),
    buyerUsdcTokenAccount: safeConfiguredAddress(config.buyerUsdcTokenAccount, "buyer USDC token account", blockers),
    workerUsdcTokenAccount: safeConfiguredAddress(config.workerUsdcTokenAccount, "worker USDC token account", blockers),
  };
  minRoleLamports = safeLamports(config.minRoleSol, "min_role_sol", blockers);
  minBuyerUsdc = safeBaseUnits(config.minBuyerUsdcBaseUnits, "min_buyer_usdc_base_units", blockers);
  minWorkerUsdc = safeBaseUnits(config.minWorkerUsdcBaseUnits, "min_worker_usdc_base_units", blockers);

  const checks = {
    rpc: null,
    program: null,
    usdc_mint: null,
    role_sol_balances: null,
    token_accounts: null,
  };

  if (rpcUrl && rpcHost && config.expectedGenesisHash) {
    const observedGenesisHash = await rpcCall(rpcUrl, "getGenesisHash", []);
    const genesisMatches = config.expectedGenesisHash ? observedGenesisHash === config.expectedGenesisHash : false;
    if (!genesisMatches) blockers.push("production RPC genesis hash mismatch");
    checks.rpc = {
      rpc_host: rpcHost,
      rpc_url_printed: false,
      cluster: MAINNET_CLUSTER,
      observed_genesis_hash: observedGenesisHash,
      expected_genesis_hash_set: Boolean(config.expectedGenesisHash),
      genesis_hash_matches: genesisMatches,
      ok: genesisMatches,
    };
  }

  const canContinue = Boolean(
    rpcUrl
    && rpcHost
    && ["processed", "confirmed", "finalized"].includes(config.commitment)
    && validated.programId
    && validated.usdcMint
    && validated.buyer
    && validated.worker
    && validated.verifier
    && validated.buyerUsdcTokenAccount
    && validated.workerUsdcTokenAccount,
  );
  if (canContinue) {
    const input = {
      config,
      rpcCall,
      blockers,
      minRoleLamports,
      minBuyerUsdc,
      minWorkerUsdc,
    };
    checks.program = await checkProgram(input);
    checks.usdc_mint = await checkMint(input);
    checks.role_sol_balances = await checkRoleBalances(input);
    checks.token_accounts = {
      buyer: await checkTokenAccount(input, "buyer", config.buyerUsdcTokenAccount, minBuyerUsdc),
      worker: await checkTokenAccount(input, "worker", config.workerUsdcTokenAccount, minWorkerUsdc),
    };
  }

  const uniqueBlockers = [...new Set(blockers)];
  return {
    ok: true,
    kind: "tasc.solana.production_preflight",
    version: "0.1",
    ready_for_real_payout: uniqueBlockers.length === 0,
    goal: "make $10 in less than a minute",
    cluster: MAINNET_CLUSTER,
    commitment: config.commitment,
    env_file: config.envFile,
    rpc_host: rpcHost,
    rpc_url_printed: false,
    accepts_private_keys: false,
    sends_transactions: false,
    writes_files: false,
    checks,
    blockers: uniqueBlockers,
    next_required_evidence: uniqueBlockers.length === 0 ? [
      "mainnet fund transaction signature",
      "mainnet claim transaction signature",
      "mainnet verifier attest transaction signature",
      "mainnet release transaction signature",
      "production payout evidence from real:payout:build",
      "real:readiness result with ready_for_goal true",
    ] : uniqueBlockers,
    no_new_dependencies: true,
  };
}

function sampleAddress(byte) {
  return base58Encode(Buffer.alloc(32, byte));
}

function encodeMintAccountFixture(decimals = 6) {
  const buffer = Buffer.alloc(MINT_ACCOUNT_SIZE);
  buffer.writeBigUInt64LE(100_000_000_000n, 36);
  buffer.writeUInt8(decimals, 44);
  buffer.writeUInt8(1, 45);
  return buffer.toString("base64");
}

function sampleOptions() {
  return {
    command: "check",
    envFile: ".env.solana-mainnet.local",
    productionRpcUrl: "http://127.0.0.1/mock-mainnet-rpc",
    expectedGenesisHash: "mainnet-self-test-genesis",
    programId: sampleAddress(2),
    usdcMint: sampleAddress(3),
    buyer: sampleAddress(4),
    worker: sampleAddress(5),
    verifier: sampleAddress(6),
    buyerUsdcTokenAccount: sampleAddress(7),
    workerUsdcTokenAccount: sampleAddress(8),
    minRoleSol: DEFAULT_MIN_ROLE_SOL,
    minBuyerUsdcBaseUnits: DEFAULT_USDC_BASE_UNITS,
    minWorkerUsdcBaseUnits: "0",
    commitment: DEFAULT_COMMITMENT,
    allowTestRpcHost: true,
  };
}

function mockRpcCall(options, overrides = {}) {
  return async (_rpcUrl, method, params) => {
    if (method === "getGenesisHash") return overrides.genesisHash || options.expectedGenesisHash;
    if (method === "getBalance") {
      const address = params[0];
      const lowRole = overrides.lowRoleAddress && address === overrides.lowRoleAddress;
      return { value: Number(lowRole ? 1_000n : 50_000_000n) };
    }
    if (method === "getAccountInfo") {
      const pubkey = params[0];
      if (pubkey === options.programId) {
        return {
          value: {
            owner: overrides.badProgramOwner || "BPFLoaderUpgradeab1e11111111111111111111111",
            executable: overrides.programNotExecutable ? false : true,
            lamports: 1_000_000,
            data: ["", "base64"],
          },
        };
      }
      if (pubkey === options.usdcMint) {
        return {
          value: {
            owner: TOKEN_PROGRAM_ID,
            executable: false,
            lamports: 1_000_000,
            data: [encodeMintAccountFixture(overrides.badDecimals ? 9 : 6), "base64"],
          },
        };
      }
      if (pubkey === options.buyerUsdcTokenAccount || pubkey === options.workerUsdcTokenAccount) {
        const isBuyer = pubkey === options.buyerUsdcTokenAccount;
        return {
          value: {
            owner: TOKEN_PROGRAM_ID,
            executable: false,
            lamports: 2_039_280,
            data: [
              encodeTokenAccount({
                pubkey,
                mint: overrides.badTokenMint ? sampleAddress(31) : options.usdcMint,
                owner: isBuyer ? options.buyer : options.worker,
                amount: isBuyer && overrides.shortBuyerUsdc ? "9999999" : isBuyer ? DEFAULT_USDC_BASE_UNITS : "0",
              }).toString("base64"),
              "base64",
            ],
          },
        };
      }
      return { value: null };
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
}

async function selfTest() {
  const planResult = plan({}, {});
  assert(planResult.sends_transactions === false, "plan must not send transactions");
  assert(planResult.calls_rpc === false, "plan must not call RPC");
  assert(planResult.accepts_private_keys === false, "plan must not accept private keys");

  const options = sampleOptions();
  const ready = await check(options, mockRpcCall(options), {});
  assert(ready.ready_for_real_payout === true, "complete mainnet preflight should be ready");
  assert(ready.rpc_url_printed === false, "preflight must not print full RPC URL");

  const missingGenesis = await check({ ...options, expectedGenesisHash: "" }, mockRpcCall({ ...options, expectedGenesisHash: "" }), {});
  assert(missingGenesis.ready_for_real_payout === false, "missing expected genesis should block readiness");

  const badGenesis = await check(options, mockRpcCall(options, { genesisHash: "wrong-genesis" }), {});
  assert(badGenesis.ready_for_real_payout === false, "bad genesis should block readiness");

  const shortBuyerUsdc = await check(options, mockRpcCall(options, { shortBuyerUsdc: true }), {});
  assert(shortBuyerUsdc.ready_for_real_payout === false, "short buyer USDC should block readiness");

  const devnetHost = await check({ ...options, allowTestRpcHost: false }, mockRpcCall(options), {});
  assert(devnetHost.ready_for_real_payout === false, "local/test RPC host should block non-test readiness");

  return {
    ok: true,
    self_test: true,
    ready_case: ready.ready_for_real_payout,
    rejected_missing_genesis: !missingGenesis.ready_for_real_payout,
    rejected_bad_genesis: !badGenesis.ready_for_real_payout,
    rejected_short_buyer_usdc: !shortBuyerUsdc.ready_for_real_payout,
    rejected_test_rpc_host: !devnetHost.ready_for_real_payout,
    min_role_sol_lamports: lamportsFromSol(DEFAULT_MIN_ROLE_SOL).toString(),
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
  process.stdout.write(`${JSON.stringify(await check(options), null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`solana-production-preflight: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  check,
  plan,
  selfTest,
};
