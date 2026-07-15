#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { admit } = require("./tascindex");
const { demo } = require("./tascsolana");
const {
  compareAccountToSignedIntent,
  createProgramFixture,
  decodeInstruction,
  decodeTaskAccount,
  encodeTaskAccount,
  fundingEvidenceFromTaskAccount,
  stateFromSignedIntent,
  taskAccountFixtureFromState,
  writeProgramFixture,
} = require("./tascsolana-program");

const TASK = "examples/summarize_url.tasc";
const SUBMISSION = "examples/submissions/summarize_url.pass.md";
const SOLANA_OUT = "examples/solana";
const OUT_DIR = "examples/solana-program";
const FUNDING_OUT = "examples/solana-program/summarize_url.funding.from-account.json";
const INDEX_OUT = "examples/index/solana.program-account.index.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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
  const adapter = demo(TASK, SUBMISSION, { outDir: SOLANA_OUT });
  const fixture = createProgramFixture(adapter.signed, { slot: "42" });
  writeProgramFixture(OUT_DIR, fixture, adapter.intent.task_name);
  writeJson(FUNDING_OUT, fixture.funding);

  const decoded = decodeTaskAccount(fixture.account.data_base64, {
    programId: fixture.account.owner,
    taskPda: fixture.account.pubkey,
  });
  const checks = compareAccountToSignedIntent(adapter.signed, decoded);
  const instruction = decodeInstruction(fixture.instruction.data_hex);
  const rescannedFunding = fundingEvidenceFromTaskAccount({
    signed: adapter.signed,
    account: fixture.account,
    tx: fixture.tx,
  });
  const admitted = admit({ inlineSigned: adapter.signed }, { inlineFunding: rescannedFunding }, INDEX_OUT);

  const releasedState = stateFromSignedIntent(adapter.signed, { status: "Released", slot: "43" });
  const releasedAccount = taskAccountFixtureFromState(releasedState);
  const rejectedReleased = expectReject("released account", () => {
    fundingEvidenceFromTaskAccount({
      signed: adapter.signed,
      account: releasedAccount,
      tx: fixture.tx,
    });
  }, "Funded");

  const badAmountState = {
    ...stateFromSignedIntent(adapter.signed, { slot: "44" }),
    amount: String(Number(adapter.signed.intent.message.amount) + 1),
  };
  const badAmountAccount = taskAccountFixtureFromState(badAmountState);
  const rejectedBadAmount = expectReject("bad amount account", () => {
    fundingEvidenceFromTaskAccount({
      signed: adapter.signed,
      account: badAmountAccount,
      tx: fixture.tx,
    });
  }, "amount");

  assert(decoded.status === "Funded", "decoded account should be Funded");
  assert(decoded.task_hash === adapter.signed.intent.message.task_hash, "task hash mismatch");
  assert(instruction.name === "fund", "instruction should decode as fund");
  assert(instruction.amount === adapter.signed.intent.message.amount, "fund instruction amount mismatch");
  assert(rescannedFunding.kind === "tasc.funding.solana", "rescanned funding kind mismatch");
  assert(admitted.entry.status === "claimable", "program account funding should admit");
  assert(admitted.entry.settlement.chain === "solana", "admitted entry should use Solana settlement");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    out_dir: OUT_DIR,
    funding_out: FUNDING_OUT,
    index_out: INDEX_OUT,
    task_account: {
      pubkey: fixture.account.pubkey,
      owner: fixture.account.owner,
      data_bytes: Buffer.from(fixture.account.data_base64, "base64").length,
      status: decoded.status,
      amount: decoded.amount,
    },
    instruction: {
      name: instruction.name,
      data_bytes: Buffer.from(fixture.instruction.data_hex.slice(2), "hex").length,
      amount: instruction.amount,
    },
    account_match_checks: checks,
    admitted: {
      status: admitted.entry.status,
      task_hash: admitted.entry.task_hash,
      funding_signature: admitted.entry.funding.signature,
    },
    rejected_released_account: rejectedReleased,
    rejected_bad_amount_account: rejectedBadAmount,
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-solana-program: ${error.message}`);
    process.exit(1);
  }
}
