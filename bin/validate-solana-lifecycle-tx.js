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
const {
  TOKEN_PROGRAM_ID,
  splBuyerTokenAddress,
  splVaultAddress,
  splWorkerTokenAddress,
  vaultAuthorityPda,
} = require("./tascsolana-spl");

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
  const expectedAccountCount = action === "release" || action === "refund" ? 7 : 2;
  assert(built.accounts.length === expectedAccountCount, `${action} account count mismatch`);
  assert(built.accounts[0].pubkey === signer, `${action} first account should be signer`);
  assert(built.accounts[0].signer === true, `${action} signer account should sign`);
  assert(built.accounts[0].writable === true, `${action} signer account should be fee-payer writable`);
  assert(built.accounts[1].pubkey === built.task_account, `${action} second account should be task account`);
  assert(built.accounts[1].writable === true, `${action} task account should be writable`);
  if (action === "release" || action === "refund") {
    const message = signed.intent.message;
    const expectedVault = splVaultAddress(message.program_id, message.buyer, message.task_hash, message.token_mint);
    const expectedAuthority = vaultAuthorityPda(message.program_id, message.task_hash, message.token_mint);
    const expectedDestination = action === "release"
      ? splWorkerTokenAddress(signer, message.token_mint)
      : splBuyerTokenAddress(message.buyer, message.token_mint);
    assert(built.accounts[2].pubkey === expectedVault, `${action} vault token account mismatch`);
    assert(built.accounts[2].writable === true, `${action} vault token account must be writable`);
    assert(built.accounts[3].pubkey === message.token_mint, `${action} mint account mismatch`);
    assert(built.accounts[3].writable === false, `${action} mint account must be readonly`);
    assert(built.accounts[4].pubkey === expectedDestination, `${action} destination token account mismatch`);
    assert(built.accounts[4].writable === true, `${action} destination token account must be writable`);
    assert(built.accounts[5].pubkey === expectedAuthority.address, `${action} vault authority mismatch`);
    assert(built.accounts[5].signer === false, `${action} vault authority must be unsigned in the outer transaction`);
    assert(built.accounts[6].pubkey === TOKEN_PROGRAM_ID, `${action} token program mismatch`);
    assert(built.accounts[6].writable === false, `${action} token program must be readonly`);
    assert(built.settlement.vault_authority_bump === expectedAuthority.bump, `${action} vault authority bump mismatch`);
    assert(built.settlement.cpi_transfer_checked_accounts[3].signer === true, `${action} CPI authority must be signer`);
  }
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
      "release instruction includes SPL vault, mint, worker destination, vault authority PDA, and token program",
      "refund instruction includes SPL vault, mint, buyer destination, vault authority PDA, and token program",
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
        token_movement: "program_cpi_transfer_checked",
        account_count: release.accounts.length,
      },
      refund: {
        data_hex: refund.data_hex,
        signer_role: refund.signer_role,
        token_movement: "program_cpi_transfer_checked",
        account_count: refund.accounts.length,
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
