#!/usr/bin/env node

const { taskHashToBytes32 } = require("./tascintent");
const { demo, fixtureKeypair } = require("./tascsolana");
const { decodeInstruction } = require("./tascsolana-program");
const {
  buildLifecycleInstruction,
  planAction,
  signerRoleForAction,
} = require("./run-solana-lifecycle");
const { fundAddresses } = require("./run-solana-fund");

const TASK = "examples/summarize_url.tasc";
const SUBMISSION = "examples/submissions/summarize_url.pass.md";
const SOLANA_OUT = "examples/solana";
const MISSING_ENV = "examples/solana-devnet/validator-missing.env";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertLifecycleInstruction({ action, signed, signer, expectedDataBytes, expectedVerdict, resultHash }) {
  const built = buildLifecycleInstruction(action, signed, signer, {
    resultHash,
    verdict: expectedVerdict,
  });
  const decoded = decodeInstruction(built.data);
  assert(built.action === action, `${action} action mismatch`);
  assert(built.signer_role === signerRoleForAction(action), `${action} signer role mismatch`);
  assert(built.signer === signer, `${action} signer mismatch`);
  assert(built.task_account === fundAddresses(signed.intent.message).task_account, `${action} task account mismatch`);
  assert(built.accounts.length === 2, `${action} should use signer + task accounts`);
  assert(built.accounts[0].pubkey === signer, `${action} first account should be signer`);
  assert(built.accounts[0].signer === true, `${action} signer account should sign`);
  assert(built.accounts[0].writable === true, `${action} signer account should be fee-payer writable`);
  assert(built.accounts[1].pubkey === built.task_account, `${action} second account should be task account`);
  assert(built.accounts[1].writable === true, `${action} task account should be writable`);
  assert(built.data.length === expectedDataBytes, `${action} instruction size mismatch`);
  assert(decoded.name === action, `${action} decoded name mismatch`);
  if (action === "attest") {
    assert(decoded.verdict === expectedVerdict, "attest verdict mismatch");
    assert(decoded.result_hash === resultHash, "attest result_hash mismatch");
  }
  return built;
}

function main() {
  const adapter = demo(TASK, SUBMISSION, { outDir: SOLANA_OUT });
  const signed = adapter.signed;
  const resultHash = taskHashToBytes32(adapter.attestation.result_hash);
  const worker = fixtureKeypair("worker").address;
  const verifier = fixtureKeypair("verifier").address;
  const buyer = fixtureKeypair("buyer").address;

  const claim = assertLifecycleInstruction({
    action: "claim",
    signed,
    signer: worker,
    expectedDataBytes: 1,
  });
  const attest = assertLifecycleInstruction({
    action: "attest",
    signed,
    signer: verifier,
    expectedDataBytes: 34,
    expectedVerdict: "pass",
    resultHash,
  });
  const release = assertLifecycleInstruction({
    action: "release",
    signed,
    signer: worker,
    expectedDataBytes: 1,
  });
  const refund = assertLifecycleInstruction({
    action: "refund",
    signed,
    signer: buyer,
    expectedDataBytes: 1,
  });

  const claimPlan = planAction("claim", {
    signedFile: "examples/solana/summarize_url.signature.json",
    envFile: MISSING_ENV,
  });
  const attestPlan = planAction("attest", {
    signedFile: "examples/solana/summarize_url.signature.json",
    envFile: MISSING_ENV,
    resultHash,
    verdict: "pass",
  });
  assert(claimPlan.sends_transactions === false, "claim plan must not send");
  assert(attestPlan.sends_transactions === false, "attest plan must not send");
  assert(claimPlan.guard_for_send === "GLOBAL_TASC_ALLOW_SOLANA_CLAIM=1", "claim guard mismatch");
  assert(attestPlan.guard_for_send === "GLOBAL_TASC_ALLOW_SOLANA_ATTEST=1", "attest guard mismatch");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    signed_intent: "examples/solana/summarize_url.signature.json",
    task_account: claim.task_account,
    checks: [
      "claim instruction uses worker signer plus writable task account",
      "attest instruction uses verifier signer plus writable task account",
      "release instruction is status-only pending SPL CPI transfer",
      "refund instruction is status-only pending SPL CPI transfer",
      "send paths are guarded by per-action env vars",
    ],
    instructions: {
      claim: {
        data_hex: claim.data_hex,
        signer_role: claim.signer_role,
      },
      attest: {
        data_hex: attest.data_hex,
        signer_role: attest.signer_role,
        verdict: attest.verdict,
      },
      release: {
        data_hex: release.data_hex,
        signer_role: release.signer_role,
        token_movement: "pending SPL CPI transfer",
      },
      refund: {
        data_hex: refund.data_hex,
        signer_role: refund.signer_role,
        token_movement: "pending SPL CPI transfer",
      },
    },
    no_new_dependencies: true,
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-solana-lifecycle-tx: ${error.message}`);
    process.exit(1);
  }
}
