#!/usr/bin/env node

const { Wallet } = require("ethers");
const { ENV, DEFAULT_CHAIN_ID, plan, readConfig, assertRunnableConfig, buildHandoff, scannerEnvFromHandoff } = require("./run-base-sepolia");

const TEST_KEYS = [
  "0x0000000000000000000000000000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000000000000000000000000000002",
  "0x0000000000000000000000000000000000000000000000000000000000000003",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectThrows(fn, label) {
  try {
    fn();
  } catch (error) {
    return error.message;
  }
  throw new Error(`${label} should have thrown`);
}

function main() {
  const emptyPlan = plan({});
  assert(emptyPlan.network.expected_chain_id === DEFAULT_CHAIN_ID, "default chain id should be Base Sepolia");
  assert(emptyPlan.missing_env.includes(ENV.rpcUrl), "empty plan should require RPC URL");
  assert(emptyPlan.missing_env.includes(ENV.allowTx), "empty plan should require transaction opt-in");

  const missingConfig = readConfig({});
  const missingMessage = expectThrows(() => assertRunnableConfig(missingConfig), "missing config");
  assert(missingMessage.includes(ENV.rpcUrl), "missing config error should mention RPC URL");

  const env = {
    [ENV.rpcUrl]: "https://example.invalid/rpc",
    [ENV.buyerKey]: TEST_KEYS[0],
    [ENV.workerKey]: TEST_KEYS[1],
    [ENV.verifierKey]: TEST_KEYS[2],
    [ENV.allowTx]: "1",
  };
  const config = readConfig(env);
  assertRunnableConfig(config);
  assert(config.expectedChainId === DEFAULT_CHAIN_ID, "configured default chain id mismatch");
  assert(config.missing.length === 0, "configured env should have no missing vars");
  assert(config.addresses.buyer === new Wallet(TEST_KEYS[0]).address, "buyer address mismatch");
  assert(config.addresses.worker === new Wallet(TEST_KEYS[1]).address, "worker address mismatch");
  assert(config.addresses.verifier === new Wallet(TEST_KEYS[2]).address, "verifier address mismatch");

  const handoff = buildHandoff({
    chainId: DEFAULT_CHAIN_ID,
    contracts: {
      token: "0x3333333333333333333333333333333333333333",
      escrow: "0x2222222222222222222222222222222222222222",
    },
    actors: config.addresses,
    taskHash: "0x28443f131686bc717c485b52cdb05c70fd4b959ee784357537bc1ef92fccbb45",
    resultHash: "0x0bdfacb7e0ec2c3241da82c7b812b1a0fa28945b47c7f8a6b113b4de3779776f",
    amount: "10000000",
    deadline: 1800000060,
    fundTxHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    fundBlockNumber: 123456,
    fundLogIndex: 0,
    confirmationsRequired: 6,
    lifecycleTxs: {
      mint: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      approve: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      fund: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      claim: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      attest: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      release: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    },
  });
  const scannerEnv = scannerEnvFromHandoff(handoff);
  assert(handoff.kind === "tasc.testnet.handoff", "handoff kind mismatch");
  assert(scannerEnv.TASC_SCAN_ESCROW === handoff.contracts.escrow, "scanner escrow env mismatch");
  assert(scannerEnv.TASC_SCAN_START_BLOCK === "123456", "scanner start block mismatch");
  assert(JSON.stringify(handoff).includes(TEST_KEYS[0]) === false, "handoff must not contain private keys");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    default_chain_id: DEFAULT_CHAIN_ID,
    empty_plan_missing_env: emptyPlan.missing_env,
    configured_addresses: config.addresses,
    handoff: {
      kind: handoff.kind,
      chain_id: handoff.chain_id,
      escrow: handoff.contracts.escrow,
      funding_block: handoff.funding_event.block_number,
      scanner_env: scannerEnv,
    },
    note: "Offline validation only; no RPC calls or public testnet transactions were sent.",
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-base-sepolia: ${error.message}`);
    process.exit(1);
  }
}
