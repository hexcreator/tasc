#!/usr/bin/env node

const fs = require("fs");
const { scannerEnvFromHandoff } = require("./run-base-sepolia");

const FIXTURE = "examples/testnet/base-sepolia.handoff.example.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertAddress(value, label) {
  assert(/^0x[a-fA-F0-9]{40}$/.test(String(value || "")), `${label} must be address hex`);
}

function assertBytes32(value, label) {
  assert(/^0x[a-fA-F0-9]{64}$/.test(String(value || "")), `${label} must be bytes32 hex`);
}

function main() {
  const handoff = loadJson(FIXTURE);
  const scannerEnv = scannerEnvFromHandoff(handoff);
  const serialized = JSON.stringify(handoff);

  assert(handoff.kind === "tasc.testnet.handoff", "wrong handoff kind");
  assert(handoff.chain_id === 84532, "wrong chain id");
  assert(handoff.rpc_env === "BASE_SEPOLIA_RPC_URL", "handoff should reference RPC env name, not an RPC URL");
  assert(handoff.note.includes("No private keys"), "handoff note should state no private keys are stored");
  assert(!serialized.includes("PRIVATE_KEY"), "handoff must not contain private key env names");
  assert(!serialized.includes("GLOBAL_TASC_BUYER_PRIVATE_KEY"), "handoff must not contain buyer private key env");
  assertAddress(handoff.contracts.escrow, "escrow");
  assertAddress(handoff.contracts.token, "token");
  assertAddress(handoff.actors.buyer, "buyer");
  assertAddress(handoff.actors.worker, "worker");
  assertAddress(handoff.actors.verifier, "verifier");
  assertBytes32(handoff.task_hash, "task_hash");
  assertBytes32(handoff.result_hash, "result_hash");
  assertBytes32(handoff.funding_event.tx_hash, "funding tx_hash");
  assert(Number.isInteger(handoff.funding_event.block_number), "funding block must be an integer");
  assert(Number.isInteger(handoff.funding_event.log_index), "funding log index must be an integer");
  assert(handoff.funding_event.confirmations_required === 6, "confirmations_required should be 6 in fixture");
  assert(scannerEnv.TASC_SCAN_RPC_URL === "$BASE_SEPOLIA_RPC_URL", "scanner RPC should be inherited by env reference");
  assert(scannerEnv.TASC_SCAN_ESCROW === handoff.contracts.escrow, "scanner escrow mismatch");
  assert(scannerEnv.TASC_SCAN_CHAIN_ID === "84532", "scanner chain id mismatch");
  assert(scannerEnv.TASC_SCAN_START_BLOCK === String(handoff.funding_event.block_number), "scanner start block mismatch");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    fixture: FIXTURE,
    handoff: {
      chain_id: handoff.chain_id,
      escrow: handoff.contracts.escrow,
      token: handoff.contracts.token,
      funding_tx: handoff.funding_event.tx_hash,
      funding_block: handoff.funding_event.block_number,
    },
    scanner_env: scannerEnv,
    next_commands: [
      "npm run base:flow:handoff",
      "source scanner env from the written handoff",
      "npm run scan:funded",
    ],
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-testnet-handoff: ${error.message}`);
    process.exit(1);
  }
}
