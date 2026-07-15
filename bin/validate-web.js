#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const core = require("../web/tasc-web-core");
const demoIndex = require("../web/demo-index");

const WEB_DIR = "web";
const LOG = "examples/events/summarize_url.funded-log.json";
const FUNDING = "examples/funding/summarize_url.from-log.json";
const HANDOFF = "examples/testnet/base-sepolia.handoff.example.json";
const SOLANA_INDEX = "examples/index/solana.spl.live.index.json";
const SOLANA_LIFECYCLE_ACCOUNT = "examples/solana-devnet/summarize_url_spl.lifecycle-account.live.json";

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
  assert(html.includes("./demo-index.js"), "index should load bundled demo index");
  assert(html.includes("./app.js"), "index should load app script");
  assert(html.includes("connect-solana"), "index should expose Solana wallet connection");
  assert(html.includes("refresh-solana"), "index should expose Solana task refresh");

  for (const file of ["app.js", "demo-index.js", "tasc-web-core.js"]) {
    const source = read(path.join(WEB_DIR, file));
    assert(!/from\s+["']/.test(source), `${file} should not use module imports`);
    assert(!/require\s*\(/.test(source), `${file} should not require packages in browser runtime`);
  }
}

function assertBundledSolanaIndexMatchesFixture() {
  const expected = loadJson(SOLANA_INDEX);
  assert(demoIndex.kind === expected.kind, "bundled Solana index kind mismatch");
  assert(Array.isArray(demoIndex.entries), "bundled Solana index entries must be an array");
  assert(demoIndex.entries.length === expected.entries.length, "bundled Solana index entry count mismatch");
  const actualEntry = demoIndex.entries[0];
  const expectedEntry = expected.entries[0];
  for (const field of ["status", "intent_hash", "task_hash", "buyer", "token_mint", "amount", "deadline_unix", "verifier"]) {
    assert(actualEntry[field] === expectedEntry[field], `bundled Solana ${field} mismatch`);
  }
  assert(actualEntry.settlement.vault === expectedEntry.settlement.vault, "bundled Solana vault mismatch");
  assert(actualEntry.funding.signature === expectedEntry.funding.signature, "bundled Solana funding signature mismatch");
  assert(actualEntry.funding.custody.amount === expectedEntry.funding.custody.amount, "bundled Solana custody amount mismatch");
}

function assertSolanaTaskAccountDecode() {
  const fixture = loadJson(SOLANA_LIFECYCLE_ACCOUNT);
  const decoded = core.decodeSolanaTaskAccountBase64(fixture.data_base64, {
    programId: fixture.owner,
    taskPda: fixture.pubkey,
  });
  for (const field of [
    "status",
    "task_hash",
    "buyer",
    "worker",
    "verifier",
    "token_mint",
    "vault",
    "amount",
    "deadline_unix",
    "nonce",
    "result_hash",
    "created_slot",
    "updated_slot",
  ]) {
    assert(decoded[field] === fixture.decoded[field], `Solana task account ${field} mismatch`);
  }
  assert(core.solanaNextAction(demoIndex.entries[0], decoded, fixture.decoded.worker).action === "complete", "released task should be complete");
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
  assertBundledSolanaIndexMatchesFixture();
  assertSolanaTaskAccountDecode();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    web: WEB_DIR,
    decoded_fixture: LOG,
    handoff_fixture: HANDOFF,
    bundled_solana_index: SOLANA_INDEX,
    solana_task_account_fixture: SOLANA_LIFECYCLE_ACCOUNT,
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
