#!/usr/bin/env node

const fs = require("fs");
const { decodeInitializeAccount3Data } = require("./tascsolana-spl");
const {
  TOKEN_PROGRAM_ID,
  splBuyerTokenAddress,
  splWorkerTokenAddress,
} = require("./tascsolana-spl");
const {
  buildSettlementPlan,
  buildWorkerTokenInstructions,
  buildWorkerTokenPlan,
} = require("./run-solana-spl-settlement");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main() {
  const workerPlan = buildWorkerTokenPlan({ skipEnv: true });
  assert(workerPlan.sends_transactions === false, "worker token plan must not send");
  assert(workerPlan.guard_for_send === "GLOBAL_TASC_ALLOW_SOLANA_WORKER_TOKEN_SETUP=1", "worker token guard mismatch");
  assert(workerPlan.worker_token_account === splWorkerTokenAddress(workerPlan.worker, workerPlan.token_mint), "worker token address mismatch");

  const workerInstructions = buildWorkerTokenInstructions({
    worker: workerPlan.worker,
    token_mint: workerPlan.token_mint,
  }, "2039280");
  assert(workerInstructions.instructions.length === 2, "worker token setup should have two instructions");
  assert(workerInstructions.instructions[0].name === "create_worker_token_account", "worker token create instruction mismatch");
  assert(workerInstructions.instructions[1].name === "spl_token.initialize_account3", "worker token init instruction mismatch");
  const initializeAccount = decodeInitializeAccount3Data(workerInstructions.instructions[1].data);
  assert(initializeAccount.owner === workerPlan.worker, "worker token init owner mismatch");

  const workerToken = {
    pubkey: workerPlan.worker_token_account,
    owner: TOKEN_PROGRAM_ID,
    decoded: {
      account_owner: TOKEN_PROGRAM_ID,
      mint: workerPlan.token_mint,
      owner: workerPlan.worker,
      amount: "0",
      state: 1,
    },
  };
  const liveLifecycle = loadJson("examples/solana-devnet/summarize_url_spl.lifecycle-account.live.json").decoded;
  const liveFunding = loadJson("examples/solana-devnet/summarize_url_spl.funding.live.json");
  const passedTask = {
    ...liveLifecycle,
    status: "Passed",
    status_code: 3,
  };
  const releasePlan = buildSettlementPlan("release", {
    task: passedTask,
    funding: liveFunding,
    workerToken,
  });
  assert(releasePlan.sends_transactions === false, "release plan must not send");
  assert(releasePlan.cpi_required === true, "release plan should require CPI");
  assert(releasePlan.task_status === "Passed", "release plan should require Passed task state");
  assert(releasePlan.destination_role === "worker", "release destination role mismatch");
  assert(releasePlan.destination_token_account === workerPlan.worker_token_account, "release destination token account mismatch");
  assert(releasePlan.destination_ready === true, "release destination should be ready with supplied evidence");
  assert(releasePlan.transfer_checked.program_id === TOKEN_PROGRAM_ID, "release token program mismatch");
  assert(releasePlan.transfer_checked.accounts.length === 4, "release transfer account count mismatch");
  assert(releasePlan.transfer_checked.accounts[0].pubkey === releasePlan.vault_token_account, "release source account mismatch");
  assert(releasePlan.transfer_checked.accounts[0].writable === true, "release source must be writable");
  assert(releasePlan.transfer_checked.accounts[2].pubkey === releasePlan.destination_token_account, "release destination account mismatch");
  assert(releasePlan.transfer_checked.accounts[2].writable === true, "release destination must be writable");
  assert(releasePlan.transfer_checked.accounts[3].pubkey === releasePlan.vault_authority, "release authority mismatch");
  assert(releasePlan.transfer_checked.accounts[3].signer === true, "release authority must be a CPI signer");
  assert(releasePlan.transfer_checked.decoded_data.amount === releasePlan.amount, "release amount mismatch");

  let refundRejected = false;
  try {
    buildSettlementPlan("refund");
  } catch (error) {
    refundRejected = /requires task status Failed/.test(error.message);
  }
  assert(refundRejected, "refund plan should reject the current non-Failed live task");

  const failedTask = {
    ...releasePlan,
    status: "Failed",
    task_pda: releasePlan.task_account,
    task_hash: releasePlan.vault_authority_seeds[1],
    buyer: "6Apg3YonZ8yCnhSnEVPx3EoUZYnhH9297EuCf5A1beTR",
    worker: workerPlan.worker,
    verifier: "3Siw3mYu8yQVaZ8qvXH5z4quyhhk6vBySn5d3KhNW9Tt",
    token_mint: releasePlan.token_mint,
    vault: releasePlan.vault_token_account,
    amount: releasePlan.amount,
    deadline_unix: "1800000060",
    nonce: "1",
    result_hash: "0x0bdfacb7e0ec2c3241da82c7b812b1a0fa28945b47c7f8a6b113b4de3779776f",
  };
  const refundPlan = buildSettlementPlan("refund", {
    task: failedTask,
    buyerTokenAccount: splBuyerTokenAddress(failedTask.buyer, failedTask.token_mint),
  });
  assert(refundPlan.task_status === "Failed", "refund plan should use failed task state");
  assert(refundPlan.destination_role === "buyer", "refund destination role mismatch");
  assert(refundPlan.destination_token_account === splBuyerTokenAddress(failedTask.buyer, failedTask.token_mint), "refund destination token account mismatch");
  assert(refundPlan.transfer_checked.accounts[0].pubkey === refundPlan.vault_token_account, "refund source account mismatch");
  assert(refundPlan.transfer_checked.accounts[3].pubkey === refundPlan.vault_authority, "refund authority mismatch");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checks: [
      "worker token account is deterministically derived and guarded",
      "release plan encodes SPL Token TransferChecked from vault to worker token account",
      "refund rejects non-Failed live task state",
      "synthetic failed task encodes refund to the buyer token account",
      "no new dependencies",
    ],
    release_destination: releasePlan.destination_token_account,
    refund_destination: refundPlan.destination_token_account,
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-solana-spl-settlement: ${error.message}`);
    process.exit(1);
  }
}
