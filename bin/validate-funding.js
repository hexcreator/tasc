#!/usr/bin/env node

const fs = require("fs");
const { admit } = require("./tascindex");
const { fundingEvidenceFromLog } = require("./tascfunding");

const SIGNED = "examples/signatures/summarize_url.signature.json";
const LOG = "examples/events/summarize_url.funded-log.json";
const OUT = "examples/funding/summarize_url.from-log.json";
const MIN_CONFIRMATIONS = 6;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function expectReject(label, fn, expected) {
  try {
    fn();
  } catch (error) {
    assert(error.message.includes(expected), `${label} rejection should mention ${expected}, got ${error.message}`);
    return error.message;
  }
  throw new Error(`${label} should have been rejected`);
}

function main() {
  const log = loadJson(LOG);
  const funding = fundingEvidenceFromLog(log, { minConfirmations: MIN_CONFIRMATIONS });
  fs.writeFileSync(OUT, `${JSON.stringify(funding, null, 2)}\n`);

  const admitted = admit(SIGNED, OUT);
  const removedReason = expectReject("removed log", () => {
    fundingEvidenceFromLog({ ...log, removed: true }, { minConfirmations: MIN_CONFIRMATIONS });
  }, "reorg");
  const shallowReason = expectReject("shallow log", () => {
    fundingEvidenceFromLog({ ...log, confirmations: MIN_CONFIRMATIONS - 1 }, { minConfirmations: MIN_CONFIRMATIONS });
  }, "confirmations");

  assert(funding.kind === "tasc.funding.evm", "wrong funding kind");
  assert(funding.status === "Funded", "wrong funding status");
  assert(funding.chain_id === 84532, "wrong chain id");
  assert(funding.task_hash === "0x28443f131686bc717c485b52cdb05c70fd4b959ee784357537bc1ef92fccbb45", "wrong task hash");
  assert(funding.amount === "10000000", "wrong funding amount");
  assert(funding.deadline === "1800000060", "wrong funding deadline");
  assert(funding.confirmations === MIN_CONFIRMATIONS, "wrong confirmation count");
  assert(admitted.entry.status === "claimable", "funding evidence should admit a claimable task");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    log: LOG,
    out: OUT,
    admitted: {
      status: admitted.entry.status,
      task_hash: admitted.entry.task_hash,
      amount: admitted.entry.amount,
      funding_tx: admitted.entry.funding.tx_hash,
    },
    rejected_removed_log: removedReason,
    rejected_shallow_log: shallowReason,
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-funding: ${error.message}`);
    process.exit(1);
  }
}
