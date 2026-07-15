#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const core = require("../web/tasc-web-core");

const WEB_DIR = "web";
const LOG = "examples/events/summarize_url.funded-log.json";
const FUNDING = "examples/funding/summarize_url.from-log.json";
const HANDOFF = "examples/testnet/base-sepolia.handoff.example.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function assertNoExternalRuntimeDependencies() {
  const html = read(path.join(WEB_DIR, "index.html"));
  assert(!/(?:src|href)=["']https?:\/\//.test(html), "web/index.html should not load external runtime URLs");
  assert(html.includes("./tasc-web-core.js"), "index should load dependencyless core");
  assert(html.includes("./app.js"), "index should load app script");

  for (const file of ["app.js", "tasc-web-core.js"]) {
    const source = read(path.join(WEB_DIR, file));
    assert(!/from\s+["']/.test(source), `${file} should not use module imports`);
    assert(!/require\s*\(/.test(source), `${file} should not require packages in browser runtime`);
  }
}

function assertDecodeMatchesFundingFixture() {
  const log = loadJson(LOG);
  const expected = loadJson(FUNDING);
  const decoded = core.decodeFundedLog(log, {
    chainId: log.chain_id,
    confirmations: log.confirmations,
  });

  for (const field of [
    "kind",
    "version",
    "chain_id",
    "task_hash",
    "escrow",
    "buyer",
    "token",
    "amount",
    "deadline",
    "status",
    "tx_hash",
    "block_number",
    "log_index",
    "confirmations",
  ]) {
    assert(decoded[field] === expected[field], `decoded ${field} mismatch`);
  }
}

function assertFilterAndHandoff() {
  const handoff = loadJson(HANDOFF);
  const derived = core.deriveConfigFromHandoff(handoff);
  assert(derived.chainId === "84532", "handoff chain id mismatch");
  assert(derived.escrow === handoff.contracts.escrow.toLowerCase(), "handoff escrow mismatch");
  assert(derived.startBlock === String(handoff.funding_event.block_number), "handoff start block mismatch");
  assert(derived.confirmations === String(handoff.funding_event.confirmations_required), "handoff confirmations mismatch");

  const filter = core.buildFundedFilter({
    escrow: derived.escrow,
    fromBlock: Number(derived.startBlock),
    toBlock: Number(derived.startBlock),
  });
  assert(filter.address === derived.escrow, "filter escrow mismatch");
  assert(filter.topics[0] === core.FUNDED_TOPIC, "filter topic mismatch");
  assert(filter.fromBlock === "0x1e240", "filter from block mismatch");
  assert(filter.toBlock === "0x1e240", "filter to block mismatch");
}

function main() {
  assertNoExternalRuntimeDependencies();
  assertDecodeMatchesFundingFixture();
  assertFilterAndHandoff();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    web: WEB_DIR,
    decoded_fixture: LOG,
    handoff_fixture: HANDOFF,
    external_runtime_dependencies: 0,
    next: "Open web/index.html or deploy web/ as static files.",
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-web: ${error.message}`);
    process.exit(1);
  }
}
