#!/usr/bin/env node

const fs = require("fs");
const { admit, admitBatch } = require("./tascindex");

const SIGNED = "examples/signatures/summarize_url.signature.json";
const SIGNED_DIR = "examples/signatures";
const GOOD_FUNDING = "examples/funding/summarize_url.from-log.json";
const BAD_FUNDING = "examples/funding/summarize_url.bad-amount.json";
const GOOD_BATCH = "examples/scan/funded.batch.json";
const OUT = "examples/index/summarize_url.index.json";
const BATCH_OUT = "examples/index/funded.batch.index.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectReject() {
  try {
    admit(SIGNED, BAD_FUNDING);
  } catch (error) {
    return error.message;
  }
  throw new Error("bad funding fixture should have been rejected");
}

function main() {
  const admitted = admit(SIGNED, GOOD_FUNDING, OUT);
  const batchAdmitted = admitBatch(SIGNED_DIR, GOOD_BATCH, BATCH_OUT);
  const rejectedReason = expectReject();
  const written = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const batchWritten = JSON.parse(fs.readFileSync(BATCH_OUT, "utf8"));
  const entry = admitted.entry;
  const rejectedBatch = admitBatch(SIGNED_DIR, buildMissingIntentBatch());

  assert(admitted.ok === true, "good funding was not admitted");
  assert(batchAdmitted.ok === true, "good funding batch was not admitted");
  assert(entry.status === "claimable", "entry must be claimable");
  assert(entry.amount === "10000000", "entry amount mismatch");
  assert(entry.task_hash === "0x28443f131686bc717c485b52cdb05c70fd4b959ee784357537bc1ef92fccbb45", "task hash mismatch");
  assert(entry.funding.status === "Funded", "funding status mismatch");
  assert(entry.signature.valid === true, "signature should be valid");
  assert(written.entries.length === 1, "written index should contain one entry");
  assert(batchWritten.entries.length === 1, "batch index should contain one entry");
  assert(batchWritten.entries[0].catalog.signed_intent === SIGNED, "batch entry should record signed intent source");
  assert(batchAdmitted.admitted === 1, "batch admission count mismatch");
  assert(batchAdmitted.rejected === 0, "good batch should have no rejects");
  assert(rejectedBatch.admitted === 0, "missing signed intent batch should admit no entries");
  assert(rejectedBatch.rejected === 1, "missing signed intent batch should reject one entry");
  assert(rejectedBatch.index.rejected_entries[0].reason === "missing signed intent", "missing signed intent reason mismatch");
  assert(rejectedReason.includes("amount"), "bad fixture rejection should mention amount");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    out: OUT,
    admitted: {
      intent_hash: entry.intent_hash,
      task_hash: entry.task_hash,
      status: entry.status,
      amount: entry.amount,
      funding_tx: entry.funding.tx_hash,
    },
    batch_admitted: {
      out: BATCH_OUT,
      admitted: batchAdmitted.admitted,
      rejected: batchAdmitted.rejected,
    },
    rejected_bad_amount: rejectedReason,
    rejected_missing_signed_intent: rejectedBatch.index.rejected_entries[0].reason,
  }, null, 2)}\n`);
}

function buildMissingIntentBatch() {
  const batch = JSON.parse(fs.readFileSync(GOOD_BATCH, "utf8"));
  return {
    ...batch,
    entries: batch.entries.map((entry) => ({
      ...entry,
      task_hash: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    })),
  };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-indexer: ${error.message}`);
    process.exit(1);
  }
}
