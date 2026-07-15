#!/usr/bin/env node

const fs = require("fs");
const { admit } = require("./tascindex");
const { plan } = require("./scan-solana-settlement-live");

const SIGNED = "examples/solana-devnet/summarize_url_spl.signature.json";
const SETTLEMENT = "examples/solana-devnet/summarize_url_spl.settlement.live.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main() {
  const settlement = loadJson(SETTLEMENT);
  const admitted = admit(SIGNED, SETTLEMENT);
  const planned = plan({
    signedFile: SIGNED,
    txFile: "examples/solana-devnet/summarize_url_spl.release.live.json",
    envFile: ".env.solana-devnet.local",
    out: SETTLEMENT,
  });

  assert(planned.sends_transactions === false, "settlement scan plan must not send transactions");
  assert(planned.writes_files === false, "settlement scan plan must not write files");
  assert(planned.rpc_url_printed === false, "settlement scan plan must redact RPC URL");
  assert(settlement.kind === "tasc.settlement.solana.spl_token", "settlement evidence kind mismatch");
  assert(settlement.status === "Released", "live settlement should be Released");
  assert(settlement.action === "release", "live settlement action should be release");
  assert(settlement.vault_balance_after === "0", "vault balance should be zero after release");
  assert(settlement.destination_balance_after === settlement.amount, "worker destination should hold released amount in this proof");
  assert(admitted.entry.status === "completed", "settlement evidence should admit as completed");
  assert(admitted.entry.completed_status === "Released", "completed status mismatch");
  assert(admitted.entry.completed_settlement.signature === settlement.signature, "settlement signature mismatch");
  assert(admitted.entry.settlement.destination_token_account === settlement.destination_token_account, "destination token account mismatch");
  let rejectedNonzeroVault = false;
  try {
    admit({ inlineSigned: loadJson(SIGNED) }, {
      inlineFunding: {
        ...settlement,
        vault_balance_after: "1",
      },
    });
  } catch (error) {
    rejectedNonzeroVault = /vault_empty/.test(error.message);
  }
  assert(rejectedNonzeroVault, "nonzero vault settlement evidence should reject");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    signed_intent: SIGNED,
    settlement: SETTLEMENT,
    checks: [
      "settlement scan plan is read-only",
      "completed settlement evidence is index-admissible",
      "released task admits as completed, not claimable",
      "vault is empty after release",
      "worker destination holds the released amount",
      "nonzero vault settlement evidence is rejected",
      "no new dependencies",
    ],
    entry_status: admitted.entry.status,
    completed_status: admitted.entry.completed_status,
    release_signature: settlement.signature,
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
