#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_ENV_FILE = ".env.solana-devnet.local";
const LAMPORTS_PER_SOL = 1_000_000_000n;
const ROLES = ["buyer", "worker", "verifier"];
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const ENV = {
  rpcUrl: "SOLANA_DEVNET_RPC_URL",
  keypair: (role) => `GLOBAL_TASC_SOLANA_${role.toUpperCase()}_KEYPAIR_JSON`,
  address: (role) => `GLOBAL_TASC_SOLANA_${role.toUpperCase()}_ADDRESS`,
};

function usage() {
  console.error([
    "Usage:",
    "  node bin/run-solana-devnet.js plan [--env file]",
    "  node bin/run-solana-devnet.js create-wallets [--env file] [--force]",
    "  node bin/run-solana-devnet.js balances [--env file]",
    "  node bin/run-solana-devnet.js airdrop [--env file] [--role buyer|worker|verifier|all] [--sol n]",
    "  node bin/run-solana-devnet.js transfer [--env file] [--from buyer] [--to worker] [--sol n]",
    "  node bin/run-solana-devnet.js fund-roles [--env file] [--from buyer] [--sol n]",
    "",
    "This harness uses raw Solana JSON-RPC and Node built-ins only.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseOptions(rest) {
  const options = {
    envFile: DEFAULT_ENV_FILE,
    role: "buyer",
    fromRole: "buyer",
    toRole: "worker",
    sol: "1",
    force: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--env") options.envFile = rest[++i];
    else if (arg === "--role") options.role = rest[++i];
    else if (arg === "--from") options.fromRole = rest[++i];
    else if (arg === "--to") options.toRole = rest[++i];
    else if (arg === "--sol") options.sol = rest[++i];
    else if (arg === "--force") options.force = true;
    else usage();
  }
  return options;
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

function mergedEnv(envFile, processEnv = process.env) {
  return { ...loadEnvFile(envFile), ...processEnv };
}

function base58Encode(bytes) {
  const source = Buffer.from(bytes);
  if (source.length === 0) return "";

  let value = BigInt(`0x${source.toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    const index = Number(value % 58n);
    encoded = `${BASE58_ALPHABET[index]}${encoded}`;
    value /= 58n;
  }

  for (const byte of source) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }

  return encoded;
}

function base58Decode(value) {
  const text = String(value || "");
  assert(text.length > 0, "base58 value is required");
  let decoded = 0n;
  for (const char of text) {
    const index = BASE58_ALPHABET.indexOf(char);
    assert(index !== -1, "base58 value contains invalid character");
    decoded = (decoded * 58n) + BigInt(index);
  }

  let hex = decoded.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = hex === "00" && decoded === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  for (const char of text) {
    if (char !== "1") break;
    bytes = Buffer.concat([Buffer.from([0]), bytes]);
  }
  return bytes;
}

function assertBase58Address(address, label) {
  const value = String(address || "");
  assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value), `${label} must be a Solana base58 address`);
  return value;
}

function keypairFromNodeCrypto() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privateDer = privateKey.export({ type: "pkcs8", format: "der" });
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const seed = Buffer.from(privateDer).subarray(-32);
  const publicKeyBytes = Buffer.from(publicDer).subarray(-32);
  const keypair = Buffer.concat([seed, publicKeyBytes]);
  assert(keypair.length === 64, "generated Solana keypair must be 64 bytes");
  return {
    address: base58Encode(publicKeyBytes),
    keypair: Array.from(keypair),
  };
}

function keypairAddress(keypairJson, label) {
  const parsed = JSON.parse(keypairJson);
  assert(Array.isArray(parsed) && parsed.length === 64, `${label} must be a 64-byte keypair array`);
  for (const byte of parsed) {
    assert(Number.isInteger(byte) && byte >= 0 && byte <= 255, `${label} contains invalid byte`);
  }
  return base58Encode(Buffer.from(parsed.slice(32)));
}

function keypairForRole(env, role) {
  assert(ROLES.includes(role), "role must be buyer, worker, or verifier");
  const keypairJson = env[ENV.keypair(role)];
  assert(keypairJson, `${ENV.keypair(role)} is required`);
  const parsed = JSON.parse(keypairJson);
  assert(Array.isArray(parsed) && parsed.length === 64, `${ENV.keypair(role)} must be a 64-byte keypair array`);
  const bytes = Buffer.from(parsed);
  return {
    role,
    seed: bytes.subarray(0, 32),
    publicKey: bytes.subarray(32, 64),
    address: base58Encode(bytes.subarray(32, 64)),
  };
}

function envAddresses(env) {
  return Object.fromEntries(ROLES.map((role) => {
    const keypairJson = env[ENV.keypair(role)];
    const address = env[ENV.address(role)] || (keypairJson ? keypairAddress(keypairJson, ENV.keypair(role)) : null);
    return [role, address];
  }));
}

function plan(options = {}, processEnv = process.env) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const env = mergedEnv(envFile, processEnv);
  const rpcUrl = env[ENV.rpcUrl] || DEFAULT_RPC_URL;
  const addresses = envAddresses(env);
  return {
    kind: "tasc.solana-devnet.plan",
    network: {
      name: "Solana Devnet",
      rpc_host: new URL(rpcUrl).host,
      rpc_url_set: Boolean(env[ENV.rpcUrl]),
    },
    safety: {
      sends_transactions: false,
      airdrop_uses_devnet_only: true,
      keypairs_from_local_env_file: true,
      no_new_dependencies: true,
    },
    env_file: path.resolve(envFile),
    env_file_exists: fs.existsSync(envFile),
    required_for_balances: [ENV.rpcUrl, ...ROLES.map(ENV.address)],
    required_for_future_signing: ROLES.map(ENV.keypair),
    configured_addresses: addresses,
    missing_keypairs: ROLES.filter((role) => !env[ENV.keypair(role)]),
    next_commands: [
      "npm run solana:create-wallets",
      "npm run solana:airdrop:buyer",
      "npm run solana:balances",
    ],
  };
}

function createWallets(options = {}) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  if (fs.existsSync(envFile) && !options.force) {
    const env = loadEnvFile(envFile);
    return {
      ok: true,
      created: false,
      env_file: path.resolve(envFile),
      addresses: envAddresses(env),
      note: "Env file already exists. Pass --force to rotate testnet keys.",
    };
  }

  const wallets = Object.fromEntries(ROLES.map((role) => [role, keypairFromNodeCrypto()]));
  const lines = [
    "# Global Tasc Solana devnet env",
    "# Created locally. Fresh devnet-only keys; do not use for real funds.",
    `${ENV.rpcUrl}=${DEFAULT_RPC_URL}`,
  ];
  for (const role of ROLES) {
    lines.push(`${ENV.address(role)}=${wallets[role].address}`);
    lines.push(`${ENV.keypair(role)}=${JSON.stringify(wallets[role].keypair)}`);
  }
  lines.push("");

  fs.writeFileSync(envFile, lines.join("\n"));
  fs.chmodSync(envFile, 0o600);
  return {
    ok: true,
    created: true,
    env_file: path.resolve(envFile),
    addresses: Object.fromEntries(ROLES.map((role) => [role, wallets[role].address])),
  };
}

async function rpcCall(rpcUrl, method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
  if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "Solana RPC error");
  return payload.result;
}

function lamportsFromSol(value) {
  const raw = String(value ?? "");
  assert(/^\d+(\.\d{1,9})?$/.test(raw), "SOL amount must have at most 9 decimal places");
  const [whole, fraction = ""] = raw.split(".");
  return (BigInt(whole) * LAMPORTS_PER_SOL) + BigInt(fraction.padEnd(9, "0"));
}

function formatSol(lamports) {
  const value = BigInt(lamports);
  const whole = value / LAMPORTS_PER_SOL;
  const fraction = (value % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function balances(options = {}) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const env = mergedEnv(envFile);
  const rpcUrl = env[ENV.rpcUrl] || DEFAULT_RPC_URL;
  const addresses = envAddresses(env);
  const result = {};
  for (const role of ROLES) {
    const address = assertBase58Address(addresses[role], `${role} address`);
    const balance = await rpcCall(rpcUrl, "getBalance", [address, { commitment: "confirmed" }]);
    result[role] = {
      address,
      lamports: String(balance.value),
      sol: formatSol(balance.value),
    };
  }
  return {
    ok: true,
    network: "Solana Devnet",
    rpc_host: new URL(rpcUrl).host,
    balances: result,
  };
}

async function pollSignature(rpcUrl, signature) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await rpcCall(rpcUrl, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const value = status.value && status.value[0];
    if (value && (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized")) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

function encodeShortVectorLength(length) {
  assert(Number.isSafeInteger(length) && length >= 0, "short vector length must be non-negative");
  const bytes = [];
  let value = length;
  while (true) {
    let elem = value & 0x7f;
    value >>= 7;
    if (value === 0) {
      bytes.push(elem);
      break;
    }
    elem |= 0x80;
    bytes.push(elem);
  }
  return Buffer.from(bytes);
}

function privateKeyFromSeed(seed) {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return crypto.createPrivateKey({
    key: Buffer.concat([prefix, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
}

function transferInstructionData(lamports) {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(BigInt(lamports), 4);
  return data;
}

function buildTransferMessage(input) {
  const from = Buffer.from(input.fromPublicKey);
  const to = base58Decode(input.toAddress);
  const systemProgram = Buffer.alloc(32);
  const blockhash = base58Decode(input.recentBlockhash);
  assert(from.length === 32, "from public key must be 32 bytes");
  assert(to.length === 32, "to public key must be 32 bytes");
  assert(blockhash.length === 32, "recent blockhash must decode to 32 bytes");

  const accountKeys = [from, to, systemProgram];
  const instructionData = transferInstructionData(input.lamports);
  return Buffer.concat([
    Buffer.from([1, 0, 1]),
    encodeShortVectorLength(accountKeys.length),
    ...accountKeys,
    blockhash,
    encodeShortVectorLength(1),
    Buffer.from([2]),
    encodeShortVectorLength(2),
    Buffer.from([0, 1]),
    encodeShortVectorLength(instructionData.length),
    instructionData,
  ]);
}

function signSolanaMessage(message, seed) {
  const signature = crypto.sign(null, Buffer.from(message), privateKeyFromSeed(seed));
  assert(signature.length === 64, "Solana ed25519 signature must be 64 bytes");
  return signature;
}

function encodeSignedTransaction(message, signature) {
  return Buffer.concat([
    encodeShortVectorLength(1),
    Buffer.from(signature),
    Buffer.from(message),
  ]).toString("base64");
}

async function transfer(options = {}) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const env = mergedEnv(envFile);
  const rpcUrl = env[ENV.rpcUrl] || DEFAULT_RPC_URL;
  const fromRole = options.fromRole || "buyer";
  const toRole = options.toRole || "worker";
  assert(ROLES.includes(fromRole), "from role must be buyer, worker, or verifier");
  assert(ROLES.includes(toRole), "to role must be buyer, worker, or verifier");
  assert(fromRole !== toRole, "from and to roles must differ");

  const addresses = envAddresses(env);
  const signer = keypairForRole(env, fromRole);
  const toAddress = assertBase58Address(addresses[toRole], `${toRole} address`);
  const lamports = lamportsFromSol(options.sol || "0.01");
  const latest = await rpcCall(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const message = buildTransferMessage({
    fromPublicKey: signer.publicKey,
    toAddress,
    lamports,
    recentBlockhash: latest.value.blockhash,
  });
  const signature = signSolanaMessage(message, signer.seed);
  const encoded = encodeSignedTransaction(message, signature);
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
    network: "Solana Devnet",
    rpc_host: new URL(rpcUrl).host,
    from: { role: fromRole, address: signer.address },
    to: { role: toRole, address: toAddress },
    lamports: lamports.toString(),
    sol: formatSol(lamports),
    signature: txSignature,
    confirmation_status: status ? status.confirmationStatus : "pending",
  };
}

async function fundRoles(options = {}) {
  const fromRole = options.fromRole || "buyer";
  const recipients = ROLES.filter((role) => role !== fromRole);
  const transfers = [];
  for (const toRole of recipients) {
    transfers.push(await transfer({ ...options, fromRole, toRole }));
  }
  return {
    ok: true,
    network: "Solana Devnet",
    from_role: fromRole,
    transfers,
  };
}

async function airdrop(options = {}) {
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const env = mergedEnv(envFile);
  const rpcUrl = env[ENV.rpcUrl] || DEFAULT_RPC_URL;
  const role = options.role || "buyer";
  assert(role === "all" || ROLES.includes(role), "role must be buyer, worker, verifier, or all");
  const sol = options.sol || "1";
  const lamports = lamportsFromSol(sol);
  assert(lamports > 0n, "airdrop amount must be positive");
  const addresses = envAddresses(env);
  const targetRoles = role === "all" ? ROLES : [role];
  const results = {};

  for (const targetRole of targetRoles) {
    const address = assertBase58Address(addresses[targetRole], `${targetRole} address`);
    const signature = await rpcCall(rpcUrl, "requestAirdrop", [address, Number(lamports)]);
    const status = await pollSignature(rpcUrl, signature);
    results[targetRole] = {
      address,
      requested_sol: sol,
      signature,
      confirmation_status: status ? status.confirmationStatus : "pending",
    };
  }

  return {
    ok: true,
    network: "Solana Devnet",
    rpc_host: new URL(rpcUrl).host,
    results,
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(plan(options), null, 2)}\n`);
    return;
  }
  if (command === "create-wallets") {
    process.stdout.write(`${JSON.stringify(createWallets(options), null, 2)}\n`);
    return;
  }
  if (command === "balances") {
    process.stdout.write(`${JSON.stringify(await balances(options), null, 2)}\n`);
    return;
  }
  if (command === "airdrop") {
    process.stdout.write(`${JSON.stringify(await airdrop(options), null, 2)}\n`);
    return;
  }
  if (command === "transfer") {
    process.stdout.write(`${JSON.stringify(await transfer(options), null, 2)}\n`);
    return;
  }
  if (command === "fund-roles") {
    process.stdout.write(`${JSON.stringify(await fundRoles(options), null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`run-solana-devnet: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_RPC_URL,
  ENV,
  LAMPORTS_PER_SOL,
  ROLES,
  assertBase58Address,
  airdrop,
  balances,
  base58Decode,
  base58Encode,
  createWallets,
  encodeShortVectorLength,
  encodeSignedTransaction,
  envAddresses,
  formatSol,
  fundRoles,
  keypairFromNodeCrypto,
  keypairForRole,
  lamportsFromSol,
  mergedEnv,
  plan,
  pollSignature,
  signSolanaMessage,
  rpcCall,
  transfer,
};
