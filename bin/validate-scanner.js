#!/usr/bin/env node

const fs = require("fs");
const { scanFundedEvents, stateForScan, fundedTopic } = require("./tascscan");
const { compareFundingToIntent } = require("./tascindex");

const LOG_FIXTURE = "examples/events/summarize_url.funded-log.json";
const SIGNED = "examples/signatures/summarize_url.signature.json";
const BATCH_OUT = "examples/scan/funded.batch.json";
const STATE_OUT = "examples/scan/funded.cursor.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

class MockProvider {
  constructor(logs, headBlock) {
    this.logs = logs;
    this.headBlock = headBlock;
    this.filters = [];
  }

  async getBlockNumber() {
    return this.headBlock;
  }

  async getLogs(filter) {
    this.filters.push(filter);
    return this.logs.filter((log) => (
      log.address.toLowerCase() === filter.address.toLowerCase()
        && log.blockNumber >= filter.fromBlock
        && log.blockNumber <= filter.toBlock
        && log.topics[0].toLowerCase() === filter.topics[0].toLowerCase()
    ));
  }
}

function providerLogFromFixture(fixture) {
  return {
    address: fixture.address,
    transactionHash: fixture.transactionHash,
    blockNumber: fixture.blockNumber,
    logIndex: fixture.logIndex,
    removed: fixture.removed,
    topics: fixture.topics,
    data: fixture.data,
  };
}

async function main() {
  const fixture = loadJson(LOG_FIXTURE);
  const provider = new MockProvider([providerLogFromFixture(fixture)], 123461);
  const options = stateForScan(null, {
    chainId: fixture.chain_id,
    escrow: fixture.address,
    startBlock: fixture.blockNumber,
    confirmations: 6,
  });
  const result = await scanFundedEvents(provider, options);
  const signed = loadJson(SIGNED);
  const admissionCheck = compareFundingToIntent(signed, result.batch.entries[0]);
  fs.mkdirSync("examples/scan", { recursive: true });
  fs.writeFileSync(BATCH_OUT, `${JSON.stringify(result.batch, null, 2)}\n`);
  fs.writeFileSync(STATE_OUT, `${JSON.stringify(result.state, null, 2)}\n`);

  const emptyProvider = new MockProvider([providerLogFromFixture(fixture)], 123461);
  const nextOptions = stateForScan(result.state, {
    chainId: fixture.chain_id,
    escrow: fixture.address,
    confirmations: 6,
  });
  const empty = await scanFundedEvents(emptyProvider, nextOptions);

  assert(result.batch.entries.length === 1, "scanner should find one funded log");
  assert(result.batch.entries[0].task_hash === "0x28443f131686bc717c485b52cdb05c70fd4b959ee784357537bc1ef92fccbb45", "wrong task hash");
  assert(result.batch.entries[0].confirmations === 6, "wrong confirmation count");
  assert(admissionCheck.signatureCheck.ok === true, "scanned funding should match signed intent");
  assert(result.state.next_from_block === 123457, "cursor should advance past safe block");
  assert(provider.filters[0].topics[0] === fundedTopic(), "scanner should filter Funded event topic");
  assert(empty.batch.entries.length === 0, "second scan should be empty at the same head");
  assert(empty.state.next_from_block === 123457, "empty scan should preserve cursor");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    batch: BATCH_OUT,
    state: STATE_OUT,
    found: result.batch.entries.length,
    next_from_block: result.state.next_from_block,
    admission_checks: admissionCheck.checks,
    empty_rescan_entries: empty.batch.entries.length,
    filter: provider.filters[0],
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`validate-scanner: ${error.message}`);
    process.exit(1);
  });
}
