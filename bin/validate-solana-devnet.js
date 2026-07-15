#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DEFAULT_RPC_URL,
  ENV,
  ROLES,
  base58Decode,
  base58Encode,
  createWallets,
  encodeShortVectorLength,
  envAddresses,
  formatSol,
  keypairFromNodeCrypto,
  lamportsFromSol,
  plan,
} = require("./run-solana-devnet");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  assert(base58Encode(Buffer.alloc(32)) === "11111111111111111111111111111111", "base58 zero address mismatch");
  assert(base58Decode("11111111111111111111111111111111").equals(Buffer.alloc(32)), "base58 zero decode mismatch");
  assert(lamportsFromSol("1").toString() === "1000000000", "1 SOL lamport conversion mismatch");
  assert(lamportsFromSol("0.001").toString() === "1000000", "0.001 SOL lamport conversion mismatch");
  assert(formatSol(1_000_000n) === "0.001", "lamport formatting mismatch");
  assert(encodeShortVectorLength(0).equals(Buffer.from([0])), "shortvec 0 mismatch");
  assert(encodeShortVectorLength(127).equals(Buffer.from([127])), "shortvec 127 mismatch");
  assert(encodeShortVectorLength(128).equals(Buffer.from([128, 1])), "shortvec 128 mismatch");

  const keypair = keypairFromNodeCrypto();
  assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(keypair.address), "generated address should be base58");
  assert(keypair.keypair.length === 64, "generated keypair should be 64 bytes");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "global-tasc-solana-"));
  const envFile = path.join(temp, ".env.solana-devnet.local");
  const created = createWallets({ envFile });
  const planned = plan({ envFile }, {});
  const existing = createWallets({ envFile });
  const env = {};
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) env[line.slice(0, index)] = line.slice(index + 1);
  }
  const addresses = envAddresses(env);
  const mode = fs.statSync(envFile).mode & 0o777;

  assert(created.created === true, "wallet creation should create env file");
  assert(existing.created === false, "second wallet creation should not rotate without force");
  assert(mode === 0o600, "solana env file should be chmod 600");
  assert(planned.network.rpc_host === new URL(DEFAULT_RPC_URL).host, "default RPC host mismatch");
  assert(planned.missing_keypairs.length === 0, "created env should have all keypairs");
  for (const role of ROLES) {
    assert(addresses[role] === env[ENV.address(role)], `${role} address should derive from env`);
    assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addresses[role]), `${role} address should be base58`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    generated_roles: ROLES,
    env_mode: "0600",
    default_rpc: DEFAULT_RPC_URL,
    checks: [
      "base58 system address",
      "lamport conversion",
      "short vector encoding",
      "ed25519 keypair generation",
      "solana env file creation",
      "plan derives configured addresses",
    ],
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-solana-devnet: ${error.message}`);
    process.exit(1);
  }
}
