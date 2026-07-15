#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { admit, admitBatch } = require("./tascindex");
const { demo, verifySignedSolanaIntent } = require("./tascsolana");

const TASK = "examples/summarize_url.tasc";
const SUBMISSION = "examples/submissions/summarize_url.pass.md";
const OUT_DIR = "examples/solana";
const SIGNED = "examples/solana/summarize_url.signature.json";
const FUNDING = "examples/solana/summarize_url.funding.json";
const BATCH = "examples/solana/funded.batch.json";
const INDEX_OUT = "examples/index/solana.summarize_url.index.json";
const BATCH_INDEX_OUT = "examples/index/solana.funded.batch.index.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  const result = demo(TASK, SUBMISSION, { outDir: OUT_DIR });
  const signed = JSON.parse(fs.readFileSync(SIGNED, "utf8"));
  const funding = JSON.parse(fs.readFileSync(FUNDING, "utf8"));
  const signatureCheck = verifySignedSolanaIntent(signed);
  const admitted = admit(SIGNED, FUNDING, INDEX_OUT);
  fs.mkdirSync(path.dirname(BATCH), { recursive: true });
  fs.writeFileSync(BATCH, `${JSON.stringify({
    kind: "tasc.funding.batch.solana",
    version: "0.1",
    entries: [funding],
  }, null, 2)}\n`);
  const batchAdmitted = admitBatch(SIGNED, BATCH, BATCH_INDEX_OUT);

  const badAmount = expectReject("bad Solana amount", () => {
    admit({ inlineSigned: signed }, {
      inlineFunding: {
        ...funding,
        amount: String(Number(funding.amount) + 1),
      },
    });
  }, "amount");

  assert(result.settlement.status === "Released", "settlement should release");
  assert(result.settlement.token_accounts.vault === "0", "vault should be empty after release");
  assert(result.settlement.token_accounts.worker === "10000000", "worker should receive 10 USDC base units");
  assert(signatureCheck.ok === true, "Solana signature should verify");
  assert(admitted.entry.status === "claimable", "Solana funding should admit a claimable task");
  assert(admitted.entry.settlement.chain === "solana", "index entry should be Solana settlement");
  assert(admitted.entry.funding.signature === funding.signature, "funding signature mismatch");
  assert(batchAdmitted.admitted === 1, "Solana batch should admit one entry");
  assert(batchAdmitted.rejected === 0, "Solana batch should have no rejects");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    out_dir: OUT_DIR,
    index_out: INDEX_OUT,
    settlement: {
      status: result.settlement.status,
      task_pda: result.settlement.task_pda,
      vault: result.settlement.vault,
      worker_balance: result.settlement.token_accounts.worker,
    },
    admitted: {
      status: admitted.entry.status,
      task_hash: admitted.entry.task_hash,
      chain: admitted.entry.settlement.chain,
      funding_signature: admitted.entry.funding.signature,
    },
    batch_admitted: {
      out: BATCH_INDEX_OUT,
      admitted: batchAdmitted.admitted,
      rejected: batchAdmitted.rejected,
    },
    rejected_bad_amount: badAmount,
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-solana-settlement: ${error.message}`);
    process.exit(1);
  }
}
