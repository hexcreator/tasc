#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { base58Decode, base58Encode } = require("./run-solana-devnet");

const DEFAULT_ENV_FILE = ".env.solana-mainnet.local";
const TEMPLATE_FILE = ".env.example";
const REQUIRED_ENV = {
  rpcUrl: "SOLANA_MAINNET_RPC_URL",
  expectedGenesisHash: "SOLANA_MAINNET_EXPECTED_GENESIS_HASH",
  programId: "GLOBAL_TASC_SOLANA_MAINNET_PROGRAM_ID",
  usdcMint: "GLOBAL_TASC_SOLANA_MAINNET_USDC_MINT",
  buyer: "GLOBAL_TASC_SOLANA_MAINNET_BUYER_ADDRESS",
  worker: "GLOBAL_TASC_SOLANA_MAINNET_WORKER_ADDRESS",
  verifier: "GLOBAL_TASC_SOLANA_MAINNET_VERIFIER_ADDRESS",
  buyerUsdc: "GLOBAL_TASC_SOLANA_MAINNET_BUYER_USDC_TOKEN_ACCOUNT",
  workerUsdc: "GLOBAL_TASC_SOLANA_MAINNET_WORKER_USDC_TOKEN_ACCOUNT",
};
const PRIVATE_KEY_RE = /(PRIVATE|SECRET|MNEMONIC|SEED|KEYPAIR|KEYPAIR_JSON|WALLET_KEY)/i;
const TEST_RPC_HOST_RE = /(devnet|testnet|localhost|127\.0\.0\.1|0\.0\.0\.0|(^|\.)example\.(com|net|org|invalid)$)/i;

function usage() {
  console.error([
    "Usage:",
    "  node bin/validate-production-env.js plan [options]",
    "  node bin/validate-production-env.js validate [options]",
    "  node bin/validate-production-env.js --self-test",
    "",
    "Options:",
    "  --env <file>                 env file; default .env.solana-mainnet.local",
    "  --allow-test-rpc-host        allow devnet/test/local-looking RPC hosts for self-tests only",
    "",
    "This command never accepts private keys, never calls RPC, and never sends transactions.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requireValue(args, index, label) {
  const value = args[index] || "";
  if (!value) throw new Error(`${label} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {
    command: "plan",
    envFile: DEFAULT_ENV_FILE,
    allowTestRpcHost: false,
    selfTest: false,
  };
  const args = [...argv];
  if (["plan", "validate"].includes(args[0])) options.command = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = requireValue(args, ++i, arg);
    else if (arg === "--allow-test-rpc-host") options.allowTestRpcHost = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  return options;
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    env[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return env;
}

function writeEnvFile(file, values) {
  fs.writeFileSync(file, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

function envSource(key, fileEnv, processEnv) {
  if (Object.prototype.hasOwnProperty.call(fileEnv, key) && fileEnv[key]) return "env-file";
  if (processEnv[key]) return "process";
  return "missing";
}

function assertBase58Hash(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} is required`);
  assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value), `${label} must be base58`);
  assert(base58Decode(value).length === 32, `${label} must decode to 32 bytes`);
  return value;
}

function assertSolanaAddress(value, label) {
  return assertBase58Hash(value, label);
}

function rpcHostOnly(value, blockers, options) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      blockers.push("SOLANA_MAINNET_RPC_URL must be http(s)");
      return null;
    }
    if (!options.allowTestRpcHost && TEST_RPC_HOST_RE.test(url.host)) {
      blockers.push("SOLANA_MAINNET_RPC_URL must not look like devnet/testnet/local/example");
    }
    return url.host;
  } catch (_error) {
    blockers.push("SOLANA_MAINNET_RPC_URL must be a valid URL");
    return null;
  }
}

function validateAddress(value, label, blockers) {
  if (!value) return;
  try {
    assertSolanaAddress(value, label);
  } catch (error) {
    blockers.push(error.message);
  }
}

function duplicateRoleBlockers(env, blockers) {
  const roles = [
    ["buyer", env[REQUIRED_ENV.buyer]],
    ["worker", env[REQUIRED_ENV.worker]],
    ["verifier", env[REQUIRED_ENV.verifier]],
  ].filter((entry) => entry[1]);
  for (let i = 0; i < roles.length; i += 1) {
    for (let j = i + 1; j < roles.length; j += 1) {
      if (roles[i][1] === roles[j][1]) {
        blockers.push(`${roles[i][0]} and ${roles[j][0]} wallets must be distinct for production proof`);
      }
    }
  }
}

function privateKeyBlockers(fileEnv) {
  return Object.keys(fileEnv)
    .filter((key) => fileEnv[key] && PRIVATE_KEY_RE.test(key))
    .map((key) => `${key} must not be stored in the production env file`);
}

function requiredStatus(fileEnv, processEnv) {
  return Object.entries(REQUIRED_ENV).map(([name, key]) => ({
    name,
    key,
    set: envSource(key, fileEnv, processEnv) !== "missing",
    source: envSource(key, fileEnv, processEnv),
  }));
}

function commandBlock(envFile) {
  return {
    copy_template: `cp ${TEMPLATE_FILE} ${envFile} && chmod 600 ${envFile}`,
    env_plan: `npm run real:env:plan -- --env ${envFile}`,
    env_validate: `npm run real:env:validate -- --env ${envFile}`,
    preflight: `npm run real:preflight -- --env ${envFile}`,
    packet_build: `npm run real:packet:build -- --env ${envFile} --timed-proof examples/solana-devnet/proofs/<run-id>/proof-summary.json`,
    submitter: "serve web/ as static files, open /production-run.html, and use the packet wallet_submitter handoffs",
  };
}

function validateProductionEnv(options = {}, processEnv = process.env) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const fileEnv = loadEnvFile(envFile);
  const env = { ...fileEnv, ...processEnv };
  const blockers = [];
  const warnings = [];
  const status = requiredStatus(fileEnv, processEnv);
  for (const entry of status) {
    if (!entry.set) blockers.push(`${entry.key} is required`);
  }
  blockers.push(...privateKeyBlockers(fileEnv));

  const rpcHost = rpcHostOnly(env[REQUIRED_ENV.rpcUrl], blockers, options);
  validateAddress(env[REQUIRED_ENV.expectedGenesisHash], REQUIRED_ENV.expectedGenesisHash, blockers);
  validateAddress(env[REQUIRED_ENV.programId], REQUIRED_ENV.programId, blockers);
  validateAddress(env[REQUIRED_ENV.usdcMint], REQUIRED_ENV.usdcMint, blockers);
  validateAddress(env[REQUIRED_ENV.buyer], REQUIRED_ENV.buyer, blockers);
  validateAddress(env[REQUIRED_ENV.worker], REQUIRED_ENV.worker, blockers);
  validateAddress(env[REQUIRED_ENV.verifier], REQUIRED_ENV.verifier, blockers);
  validateAddress(env[REQUIRED_ENV.buyerUsdc], REQUIRED_ENV.buyerUsdc, blockers);
  validateAddress(env[REQUIRED_ENV.workerUsdc], REQUIRED_ENV.workerUsdc, blockers);
  duplicateRoleBlockers(env, blockers);

  if (!fs.existsSync(TEMPLATE_FILE)) warnings.push(`${TEMPLATE_FILE} is missing`);
  const uniqueBlockers = [...new Set(blockers)];
  return {
    ok: true,
    kind: "tasc.production_env.readiness",
    version: "0.1",
    mode: options.command || "plan",
    env_file: envFile,
    env_file_exists: fs.existsSync(envFile),
    template_file: TEMPLATE_FILE,
    template_file_exists: fs.existsSync(TEMPLATE_FILE),
    sends_transactions: false,
    accepts_private_keys: false,
    calls_rpc: false,
    writes_files: false,
    full_rpc_url_persisted: false,
    rpc_url_printed: false,
    rpc_host: rpcHost,
    required_env: status,
    ready_for_preflight: uniqueBlockers.length === 0,
    ready_for_packet_build: uniqueBlockers.length === 0,
    funding_requirements: {
      buyer_usdc_base_units_minimum: "10000000",
      buyer_usdc_display_minimum: "10 USDC",
      role_sol_minimum_recommended: "0.02 SOL each",
    },
    blockers: uniqueBlockers,
    warnings,
    commands: commandBlock(envFile),
    no_new_dependencies: true,
  };
}

function sampleAddress(byte) {
  return base58Encode(Buffer.alloc(32, byte));
}

async function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasc-production-env-"));
  const validEnv = path.join(dir, ".env.solana-mainnet.local");
  writeEnvFile(validEnv, {
    [REQUIRED_ENV.rpcUrl]: "https://mainnet.example.com/sensitive/rpc?credential=do-not-store",
    [REQUIRED_ENV.expectedGenesisHash]: sampleAddress(1),
    [REQUIRED_ENV.programId]: sampleAddress(2),
    [REQUIRED_ENV.usdcMint]: sampleAddress(3),
    [REQUIRED_ENV.buyer]: sampleAddress(4),
    [REQUIRED_ENV.worker]: sampleAddress(5),
    [REQUIRED_ENV.verifier]: sampleAddress(6),
    [REQUIRED_ENV.buyerUsdc]: sampleAddress(7),
    [REQUIRED_ENV.workerUsdc]: sampleAddress(8),
  });
  const valid = validateProductionEnv({ envFile: validEnv, command: "validate", allowTestRpcHost: true }, {});
  assert(valid.ready_for_preflight === true, "valid env should be ready for preflight");
  const serialized = JSON.stringify(valid);
  assert(!serialized.includes("do-not-store"), "env report must not print RPC credential");
  assert(!serialized.includes("/sensitive/rpc"), "env report must not print full RPC path");

  const placeholderHost = validateProductionEnv({ envFile: validEnv, command: "validate" }, {});
  assert(placeholderHost.ready_for_preflight === false, "example RPC host should not be production-ready");
  assert(placeholderHost.blockers.includes("SOLANA_MAINNET_RPC_URL must not look like devnet/testnet/local/example"), "example RPC host should be rejected");

  const missing = validateProductionEnv({ envFile: path.join(dir, "missing.env") }, {});
  assert(missing.ready_for_preflight === false, "missing env should not be ready");
  assert(missing.blockers.includes(`${REQUIRED_ENV.rpcUrl} is required`), "missing RPC should be reported");

  const privateEnv = path.join(dir, "private.env");
  writeEnvFile(privateEnv, {
    [REQUIRED_ENV.rpcUrl]: "https://mainnet.example.com",
    GLOBAL_TASC_SOLANA_MAINNET_BUYER_PRIVATE_KEY: "never-store-this",
  });
  const privateResult = validateProductionEnv({ envFile: privateEnv }, {});
  assert(privateResult.blockers.some((item) => item.includes("PRIVATE_KEY")), "private key env should be rejected");

  const devnetEnv = path.join(dir, "devnet.env");
  writeEnvFile(devnetEnv, {
    [REQUIRED_ENV.rpcUrl]: "https://api.devnet.solana.com",
  });
  const devnet = validateProductionEnv({ envFile: devnetEnv }, {});
  assert(devnet.blockers.includes("SOLANA_MAINNET_RPC_URL must not look like devnet/testnet/local/example"), "devnet RPC should be rejected");

  const duplicateEnv = path.join(dir, "duplicate.env");
  writeEnvFile(duplicateEnv, {
    [REQUIRED_ENV.rpcUrl]: "https://mainnet.example.com",
    [REQUIRED_ENV.expectedGenesisHash]: sampleAddress(1),
    [REQUIRED_ENV.programId]: sampleAddress(2),
    [REQUIRED_ENV.usdcMint]: sampleAddress(3),
    [REQUIRED_ENV.buyer]: sampleAddress(4),
    [REQUIRED_ENV.worker]: sampleAddress(4),
    [REQUIRED_ENV.verifier]: sampleAddress(6),
    [REQUIRED_ENV.buyerUsdc]: sampleAddress(7),
    [REQUIRED_ENV.workerUsdc]: sampleAddress(8),
  });
  const duplicate = validateProductionEnv({ envFile: duplicateEnv }, {});
  assert(duplicate.blockers.some((item) => item.includes("buyer and worker")), "duplicate role wallets should be rejected");

  return {
    ok: true,
    self_test: true,
    valid_env_ready: valid.ready_for_preflight,
    missing_env_rejected: !missing.ready_for_preflight,
    private_key_rejected: privateResult.blockers.some((item) => item.includes("PRIVATE_KEY")),
    devnet_rpc_rejected: devnet.blockers.includes("SOLANA_MAINNET_RPC_URL must not look like devnet/testnet/local/example"),
    placeholder_rpc_rejected: !placeholderHost.ready_for_preflight,
    duplicate_roles_rejected: duplicate.blockers.some((item) => item.includes("buyer and worker")),
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
  const result = validateProductionEnv(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (options.command === "validate" && !result.ready_for_preflight) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`validate-production-env: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  REQUIRED_ENV,
  selfTest,
  validateProductionEnv,
};
