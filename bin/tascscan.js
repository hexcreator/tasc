#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Interface, JsonRpcProvider, getAddress } = require("ethers");
const { fundingEvidenceFromLog } = require("./tascfunding");

const ABI_FILE = "abi/TascEscrow.abi.json";
const DEFAULT_CONFIRMATIONS = 6;
const DEFAULT_STATE_FILE = "examples/scan/funded.cursor.json";
const DEFAULT_OUT_FILE = "examples/scan/funded.batch.json";
const REQUIRED_ENV = ["TASC_SCAN_RPC_URL", "TASC_SCAN_ESCROW", "TASC_SCAN_CHAIN_ID"];

function usage() {
  console.error([
    "Usage:",
    "  node bin/tascscan.js plan",
    "  node bin/tascscan.js scan [--rpc-url url] [--escrow 0x...] [--chain-id n] [--start-block n] [--confirmations n] [--state file] [--out file]",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function maybeReadJson(file) {
  if (!fs.existsSync(file)) return null;
  return loadJson(file);
}

function assertUint(value, label) {
  assert(/^\d+$/.test(String(value ?? "")), `${label} must be an integer string`);
  const number = Number(value);
  assert(Number.isSafeInteger(number), `${label} is outside safe integer range`);
  return number;
}

function normalizeAddress(value, label) {
  assert(/^0x[a-fA-F0-9]{40}$/.test(String(value || "")), `${label} must be address hex`);
  return getAddress(value).toLowerCase();
}

function escrowInterface() {
  return new Interface(loadJson(ABI_FILE));
}

function fundedTopic() {
  return escrowInterface().getEvent("Funded").topicHash;
}

function parseOptions(rest, env = process.env) {
  const options = {
    rpcUrl: env.TASC_SCAN_RPC_URL,
    escrow: env.TASC_SCAN_ESCROW,
    chainId: env.TASC_SCAN_CHAIN_ID,
    startBlock: env.TASC_SCAN_START_BLOCK,
    confirmations: env.TASC_SCAN_CONFIRMATIONS || String(DEFAULT_CONFIRMATIONS),
    stateFile: env.TASC_SCAN_STATE || DEFAULT_STATE_FILE,
    outFile: env.TASC_SCAN_OUT || DEFAULT_OUT_FILE,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--rpc-url") options.rpcUrl = rest[++i];
    else if (arg === "--escrow") options.escrow = rest[++i];
    else if (arg === "--chain-id") options.chainId = rest[++i];
    else if (arg === "--start-block") options.startBlock = rest[++i];
    else if (arg === "--confirmations") options.confirmations = rest[++i];
    else if (arg === "--state") options.stateFile = rest[++i];
    else if (arg === "--out") options.outFile = rest[++i];
    else usage();
  }

  return options;
}

function plan(env = process.env) {
  return {
    kind: "tasc.scan.plan",
    sends_transactions: false,
    reads_rpc_logs: true,
    required_env: REQUIRED_ENV,
    optional_env: ["TASC_SCAN_START_BLOCK", "TASC_SCAN_CONFIRMATIONS", "TASC_SCAN_STATE", "TASC_SCAN_OUT"],
    missing_env: REQUIRED_ENV.filter((name) => !env[name]),
    defaults: {
      confirmations: DEFAULT_CONFIRMATIONS,
      state: DEFAULT_STATE_FILE,
      out: DEFAULT_OUT_FILE,
    },
    note: "The scanner only reads TascEscrow.Funded logs and writes a local cursor plus funding batch.",
  };
}

function stateForScan(existingState, options) {
  const chainId = assertUint(options.chainId, "chain-id");
  const escrow = normalizeAddress(options.escrow, "escrow");
  const confirmations = assertUint(options.confirmations ?? DEFAULT_CONFIRMATIONS, "confirmations");

  if (existingState) {
    assert(existingState.kind === "tasc.scan.state", "state kind must be tasc.scan.state");
    assert(Number(existingState.chain_id) === chainId, "state chain_id does not match scan chain-id");
    assert(normalizeAddress(existingState.escrow, "state escrow") === escrow, "state escrow does not match scan escrow");
  }

  const startBlock = existingState?.next_from_block ?? options.startBlock;
  assert(startBlock !== undefined, "missing start block; pass --start-block or set TASC_SCAN_START_BLOCK");

  return {
    chainId,
    escrow,
    confirmations,
    fromBlock: assertUint(startBlock, "start-block"),
  };
}

function providerLogToFundingLog(log, options) {
  return {
    chain_id: options.chainId,
    address: log.address,
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex ?? log.index,
    confirmations: options.headBlock - log.blockNumber + 1,
    removed: Boolean(log.removed),
    topics: log.topics,
    data: log.data,
  };
}

async function scanFundedEvents(provider, options) {
  const headBlock = await provider.getBlockNumber();
  const safeToBlock = headBlock - options.confirmations + 1;

  if (safeToBlock < options.fromBlock) {
    const state = buildState(options, {
      headBlock,
      lastScannedBlock: null,
      nextFromBlock: options.fromBlock,
      scanned: false,
    });
    return {
      batch: buildBatch(options, {
        headBlock,
        fromBlock: options.fromBlock,
        toBlock: null,
        entries: [],
        scanned: false,
      }),
      state,
    };
  }

  const logs = await provider.getLogs({
    address: options.escrow,
    fromBlock: options.fromBlock,
    toBlock: safeToBlock,
    topics: [fundedTopic()],
  });

  const entries = logs.map((log) => fundingEvidenceFromLog(providerLogToFundingLog(log, {
    chainId: options.chainId,
    headBlock,
  }), { minConfirmations: options.confirmations }));

  return {
    batch: buildBatch(options, {
      headBlock,
      fromBlock: options.fromBlock,
      toBlock: safeToBlock,
      entries,
      scanned: true,
    }),
    state: buildState(options, {
      headBlock,
      lastScannedBlock: safeToBlock,
      nextFromBlock: safeToBlock + 1,
      scanned: true,
    }),
  };
}

function buildBatch(options, result) {
  return {
    kind: "tasc.funding.batch.evm",
    version: "0.1",
    chain_id: options.chainId,
    escrow: options.escrow,
    from_block: result.fromBlock,
    to_block: result.toBlock,
    head_block: result.headBlock,
    confirmations: options.confirmations,
    scanned: result.scanned,
    entries: result.entries,
  };
}

function buildState(options, result) {
  return {
    kind: "tasc.scan.state",
    version: "0.1",
    chain_id: options.chainId,
    escrow: options.escrow,
    confirmations: options.confirmations,
    next_from_block: result.nextFromBlock,
    last_scanned_block: result.lastScannedBlock,
    last_head_block: result.headBlock,
    updated_at: new Date(0).toISOString(),
    scanned: result.scanned,
  };
}

async function scanCli(options) {
  const existingState = maybeReadJson(options.stateFile);
  const scanState = stateForScan(existingState, options);
  const provider = new JsonRpcProvider(options.rpcUrl);
  const network = await provider.getNetwork();
  assert(network.chainId === BigInt(scanState.chainId), `RPC chain id ${network.chainId} does not match ${scanState.chainId}`);

  const result = await scanFundedEvents(provider, scanState);
  writeJson(options.outFile, result.batch);
  writeJson(options.stateFile, result.state);
  return {
    ok: true,
    out: options.outFile,
    state: options.stateFile,
    batch: result.batch,
    cursor: result.state,
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();

  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(plan(), null, 2)}\n`);
    return;
  }

  if (command === "scan") {
    const options = parseOptions(rest);
    if (!options.rpcUrl || !options.escrow || !options.chainId) usage();
    process.stdout.write(`${JSON.stringify(await scanCli(options), null, 2)}\n`);
    return;
  }

  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`tascscan: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  fundedTopic,
  plan,
  scanFundedEvents,
  stateForScan,
};
