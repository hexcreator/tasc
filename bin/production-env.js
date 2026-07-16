const fs = require("fs");
const path = require("path");

const DEFAULT_ENV_FILE = ".env.solana-mainnet.local";
const PRODUCTION_ENV = {
  rpcUrl: "SOLANA_MAINNET_RPC_URL",
  expectedGenesisHash: "SOLANA_MAINNET_EXPECTED_GENESIS_HASH",
  programId: "GLOBAL_TASC_SOLANA_MAINNET_PROGRAM_ID",
  tokenMint: "GLOBAL_TASC_SOLANA_MAINNET_USDC_MINT",
  buyer: "GLOBAL_TASC_SOLANA_MAINNET_BUYER_ADDRESS",
  worker: "GLOBAL_TASC_SOLANA_MAINNET_WORKER_ADDRESS",
  verifier: "GLOBAL_TASC_SOLANA_MAINNET_VERIFIER_ADDRESS",
  buyerUsdc: "GLOBAL_TASC_SOLANA_MAINNET_BUYER_USDC_TOKEN_ACCOUNT",
  workerUsdc: "GLOBAL_TASC_SOLANA_MAINNET_WORKER_USDC_TOKEN_ACCOUNT",
};

function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return {};
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

function withProductionEnv(options = {}, mapping = {}, processEnv = process.env) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const env = { ...loadEnvFile(envFile), ...processEnv };
  const resolved = { ...options, envFile };
  Object.entries(mapping).forEach(([optionKey, envKey]) => {
    if (!resolved[optionKey]) resolved[optionKey] = env[envKey] || "";
  });
  return resolved;
}

function envMetadata(envFile, keys = [], processEnv = process.env) {
  const file = envFile || DEFAULT_ENV_FILE;
  const fileEnv = loadEnvFile(file);
  const displayFile = path.isAbsolute(file) ? path.relative(process.cwd(), file) : file;
  return {
    env_file: displayFile,
    env_file_exists: fs.existsSync(file),
    env_keys_loaded: keys.filter((key) => Boolean(fileEnv[key] || processEnv[key])),
  };
}

module.exports = {
  DEFAULT_ENV_FILE,
  PRODUCTION_ENV,
  envMetadata,
  loadEnvFile,
  withProductionEnv,
};
