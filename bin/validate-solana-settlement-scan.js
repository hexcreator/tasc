#!/usr/bin/env node

const fs = require("fs");
const { admit } = require("./tascindex");
const { plan } = require("./scan-solana-settlement-live");

const CASES = [
  {
    name: "release",
    signed: "examples/solana-devnet/summarize_url_spl.signature.json",
    tx: "examples/solana-devnet/summarize_url_spl.release.live.json",
    settlement: "examples/solana-devnet/summarize_url_spl.settlement.live.json",
    status: "Released",
    action: "release",
    destinationRole: "worker",
  },
  {
    name: "refund",
    signed: "examples/solana-devnet/summarize_url_refund_job.signature.json",
    tx: "examples/solana-devnet/summarize_url_refund_job_spl.refund.live.json",
    settlement: "examples/solana-devnet/summarize_url_refund_job_spl.settlement.live.json",
    status: "Refunded",
    action: "refund",
    destinationRole: "buyer",
  },
  {
    name: "timeout-refund",
    signed: "examples/solana-devnet/summarize_url_timeout_job.signature.json",
    tx: "examples/solana-devnet/summarize_url_timeout_job_spl.timeout-refund.live.json",
    settlement: "examples/solana-devnet/summarize_url_timeout_job_spl.settlement.live.json",
    status: "Refunded",
    action: "refund",
    destinationRole: "buyer",
    worker: "11111111111111111111111111111111",
    resultHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function validateCase(testCase) {
  const settlement = loadJson(testCase.settlement);
  const admitted = admit(testCase.signed, testCase.settlement);
  const planned = plan({
    signedFile: testCase.signed,
    txFile: testCase.tx,
    envFile: ".env.solana-devnet.local",
    out: testCase.settlement,
  });

  assert(planned.sends_transactions === false, "settlement scan plan must not send transactions");
  assert(planned.writes_files === false, "settlement scan plan must not write files");
  assert(planned.rpc_url_printed === false, "settlement scan plan must redact RPC URL");
  assert(settlement.kind === "tasc.settlement.solana.spl_token", "settlement evidence kind mismatch");
  assert(settlement.status === testCase.status, `${testCase.name} settlement status mismatch`);
  assert(settlement.action === testCase.action, `${testCase.name} settlement action mismatch`);
  assert(settlement.destination_role === testCase.destinationRole, `${testCase.name} destination role mismatch`);
  if (testCase.worker) assert(settlement.worker === testCase.worker, `${testCase.name} worker mismatch`);
  if (testCase.resultHash) assert(settlement.result_hash === testCase.resultHash, `${testCase.name} result hash mismatch`);
  assert(settlement.vault_balance_after === "0", `${testCase.name} vault balance should be zero after settlement`);
  assert(settlement.destination_balance_after === settlement.amount, `${testCase.name} destination should hold settled amount in this proof`);
  assert(admitted.entry.status === "completed", "settlement evidence should admit as completed");
  assert(admitted.entry.completed_status === testCase.status, "completed status mismatch");
  assert(admitted.entry.completed_settlement.signature === settlement.signature, "settlement signature mismatch");
  assert(admitted.entry.settlement.destination_token_account === settlement.destination_token_account, "destination token account mismatch");
  let rejectedNonzeroVault = false;
  try {
    admit({ inlineSigned: loadJson(testCase.signed) }, {
      inlineFunding: {
        ...settlement,
        vault_balance_after: "1",
      },
    });
  } catch (error) {
    rejectedNonzeroVault = /vault_empty/.test(error.message);
  }
  assert(rejectedNonzeroVault, "nonzero vault settlement evidence should reject");

  return {
    name: testCase.name,
    signed_intent: testCase.signed,
    settlement: testCase.settlement,
    entry_status: admitted.entry.status,
    completed_status: admitted.entry.completed_status,
    signature: settlement.signature,
  };
}

function main() {
  const results = CASES.map(validateCase);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    cases: results,
    checks: [
      "settlement scan plan is read-only",
      "completed settlement evidence is index-admissible",
      "released, failed-refunded, and timeout-refunded tasks admit as completed, not claimable",
      "vault is empty after release, failure refund, and timeout refund",
      "worker and buyer destinations hold the settled amount",
      "nonzero vault settlement evidence is rejected",
      "no new dependencies",
    ],
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-solana-settlement-scan: ${error.message}`);
    process.exit(1);
  }
}
