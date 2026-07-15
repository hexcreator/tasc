#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Interface, getAddress } = require("ethers");
const { verifySignedIntent } = require("./tascsign");

const ABI_FILE = "abi/TascEscrow.abi.json";
const DEFAULT_CONFIRMATIONS = 6;

function usage() {
  console.error([
    "Usage:",
    "  node bin/tascfunding.js fixture-log <signed-intent.json> --tx-hash 0x... --block-number n --log-index n [--confirmations n] [--out log.json]",
    "  node bin/tascfunding.js from-log <funded-log.json> [--chain-id n] [--min-confirmations n] [--out funding.json]",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function escrowInterface() {
  return new Interface(loadJson(ABI_FILE));
}

function assertBytes32(value, label) {
  assert(/^0x[a-fA-F0-9]{64}$/.test(String(value || "")), `${label} must be bytes32 hex`);
  return String(value).toLowerCase();
}

function assertUint(value, label) {
  assert(/^\d+$/.test(String(value ?? "")), `${label} must be an integer string`);
  return String(value);
}

function normalizeAddress(value, label) {
  assert(/^0x[a-fA-F0-9]{40}$/.test(String(value || "")), `${label} must be address hex`);
  return getAddress(value).toLowerCase();
}

function numberFromUint(value, label) {
  const raw = assertUint(value, label);
  const number = Number(raw);
  assert(Number.isSafeInteger(number), `${label} is outside safe integer range`);
  return number;
}

function parseOptions(rest) {
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--tx-hash") options.txHash = rest[++i];
    else if (arg === "--block-number") options.blockNumber = rest[++i];
    else if (arg === "--log-index") options.logIndex = rest[++i];
    else if (arg === "--confirmations") options.confirmations = rest[++i];
    else if (arg === "--chain-id") options.chainId = rest[++i];
    else if (arg === "--min-confirmations") options.minConfirmations = rest[++i];
    else if (arg === "--out") options.out = rest[++i];
    else usage();
  }
  return options;
}

function writeJson(outFile, value) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(value, null, 2)}\n`);
}

function buildFundedLogFixture(signed, options) {
  const signatureCheck = verifySignedIntent(signed);
  assert(signatureCheck.ok, "signed intent signature is invalid");

  const message = signed.typed_data.message;
  const domain = signed.typed_data.domain;
  const iface = escrowInterface();
  const event = iface.getEvent("Funded");
  const encoded = iface.encodeEventLog(event, [
    assertBytes32(message.taskHash, "message.taskHash"),
    normalizeAddress(message.buyer, "message.buyer"),
    normalizeAddress(message.token, "message.token"),
    assertUint(message.amount, "message.amount"),
    assertUint(message.deadline, "message.deadline"),
  ]);

  return {
    kind: "tasc.evm.log",
    version: "0.1",
    chain_id: numberFromUint(domain.chainId, "domain.chainId"),
    address: normalizeAddress(domain.verifyingContract, "domain.verifyingContract"),
    event: "Funded",
    transactionHash: assertBytes32(options.txHash, "tx-hash"),
    blockNumber: numberFromUint(options.blockNumber, "block-number"),
    logIndex: numberFromUint(options.logIndex, "log-index"),
    confirmations: numberFromUint(options.confirmations ?? DEFAULT_CONFIRMATIONS, "confirmations"),
    removed: false,
    topics: encoded.topics,
    data: encoded.data,
  };
}

function normalizeLog(rawLog, options = {}) {
  const log = rawLog.log || rawLog;
  const chainId = options.chainId ?? log.chain_id ?? log.chainId;
  const txHash = log.tx_hash ?? log.transactionHash ?? log.transaction_hash;
  const blockNumber = log.block_number ?? log.blockNumber;
  const logIndex = log.log_index ?? log.logIndex ?? log.index;
  const confirmations = log.confirmations;

  return {
    chainId: numberFromUint(chainId, "chain_id"),
    escrow: normalizeAddress(log.escrow ?? log.address, "log address"),
    txHash: assertBytes32(txHash, "tx_hash"),
    blockNumber: numberFromUint(blockNumber, "block_number"),
    logIndex: numberFromUint(logIndex, "log_index"),
    confirmations: confirmations === undefined ? undefined : numberFromUint(confirmations, "confirmations"),
    removed: Boolean(log.removed),
    topics: log.topics,
    data: log.data,
  };
}

function fundingEvidenceFromLog(rawLog, options = {}) {
  const log = normalizeLog(rawLog, options);
  assert(!log.removed, "funding log was removed by a chain reorg");

  const minConfirmations = options.minConfirmations === undefined
    ? 0
    : numberFromUint(options.minConfirmations, "min-confirmations");
  if (minConfirmations > 0) {
    assert(log.confirmations !== undefined, "funding log missing confirmations");
    assert(log.confirmations >= minConfirmations, `funding log has ${log.confirmations} confirmations; expected >= ${minConfirmations}`);
  }

  const parsed = escrowInterface().parseLog({ topics: log.topics, data: log.data });
  assert(parsed && parsed.name === "Funded", "log is not a TascEscrow Funded event");

  return {
    kind: "tasc.funding.evm",
    version: "0.1",
    chain_id: log.chainId,
    task_hash: assertBytes32(parsed.args.taskHash, "event.taskHash"),
    escrow: log.escrow,
    buyer: normalizeAddress(parsed.args.buyer, "event.buyer"),
    token: normalizeAddress(parsed.args.token, "event.token"),
    amount: assertUint(parsed.args.amount, "event.amount"),
    deadline: assertUint(parsed.args.deadline, "event.deadline"),
    status: "Funded",
    tx_hash: log.txHash,
    block_number: log.blockNumber,
    log_index: log.logIndex,
    confirmations: log.confirmations,
  };
}

function main() {
  const [command, file, ...rest] = process.argv.slice(2);
  if (!command || !file) usage();
  const options = parseOptions(rest);

  if (command === "fixture-log") {
    const log = buildFundedLogFixture(loadJson(file), options);
    if (options.out) writeJson(options.out, log);
    process.stdout.write(`${JSON.stringify(log, null, 2)}\n`);
    return;
  }

  if (command === "from-log") {
    const funding = fundingEvidenceFromLog(loadJson(file), options);
    if (options.out) writeJson(options.out, funding);
    process.stdout.write(`${JSON.stringify(funding, null, 2)}\n`);
    return;
  }

  usage();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`tascfunding: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildFundedLogFixture,
  fundingEvidenceFromLog,
};
