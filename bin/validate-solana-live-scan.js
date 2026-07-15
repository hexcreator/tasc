#!/usr/bin/env node

const fs = require("fs");
const { admit } = require("./tascindex");
const { fundAddresses } = require("./run-solana-fund");
const {
  encodeTaskAccount,
  taskAccountFixtureFromState,
} = require("./tascsolana-program");
const {
  accountFixtureFromRpc,
  fundingFromLiveAccount,
  plan,
} = require("./scan-solana-live");

const SIGNED = "examples/solana-devnet/summarize_url.signature.json";
const TEST_SIGNATURE = "5mGUeAcxNHeCuqn9VeQPtWEMZGRoGt7TCp5euJA1K1SEsMaTe5JxLXgbtjDTpJJAc6h6hFNvvzYhsKLmp9W1DxBe";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main() {
  const signed = loadJson(SIGNED);
  const message = signed.intent.message;
  const addresses = fundAddresses(message);
  const state = {
    kind: "tasc.solana.task_account",
    version: "0.1",
    program_id: message.program_id,
    task_pda: addresses.task_account,
    status: "Funded",
    task_hash: message.task_hash,
    buyer: message.buyer,
    worker: "11111111111111111111111111111111",
    verifier: message.verifier,
    token_mint: message.token_mint,
    vault: addresses.vault,
    amount: String(message.amount),
    deadline_unix: String(message.deadline_unix),
    nonce: String(message.nonce),
    result_hash: `0x${"00".repeat(32)}`,
    created_slot: "0",
    updated_slot: "0",
  };
  const data = encodeTaskAccount(state).toString("base64");
  const rpcAccount = {
    pubkey: addresses.task_account,
    context: {
      slot: 12345,
      apiVersion: "test",
    },
    value: {
      data: [data, "base64"],
      executable: false,
      lamports: 2039280,
      owner: message.program_id,
      rentEpoch: 0,
    },
  };
  const account = accountFixtureFromRpc(rpcAccount);
  const { funding } = fundingFromLiveAccount({
    signed,
    ...rpcAccount,
    signature: TEST_SIGNATURE,
    instructionIndex: "2",
    confirmationStatus: "finalized",
  });
  const admitted = admit({ inlineSigned: signed }, { inlineFunding: funding });
  const planned = plan({ signedFile: SIGNED, envFile: ".env.solana-devnet.local" });

  const oldFixtureShape = taskAccountFixtureFromState(state);
  assert(oldFixtureShape.pubkey === addresses.task_account, "seeded task account fixture pubkey mismatch");
  assert(account.decoded.status === "Funded", "live account should decode as Funded");
  assert(account.decoded.task_hash === message.task_hash, "task hash mismatch");
  assert(funding.kind === "tasc.funding.solana", "funding kind mismatch");
  assert(funding.task_pda === addresses.task_account, "funding task account mismatch");
  assert(funding.vault === addresses.vault, "funding vault mismatch");
  assert(funding.signature === TEST_SIGNATURE, "funding signature should come from the transaction scanner");
  assert(funding.slot === "12345", "funding slot should come from RPC context");
  assert(funding.instruction_index === "2", "funding instruction index should come from the transaction scanner");
  assert(funding.confirmation_status === "finalized", "funding confirmation should come from the transaction scanner");
  assert(admitted.entry.status === "claimable", "live funding should admit");
  assert(planned.sends_transactions === false, "scan plan must not send transactions");
  assert(planned.writes_files === false, "scan plan must not write files");
  assert(planned.rpc_url_printed === false, "scan plan must redact RPC URL");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    signed_intent: SIGNED,
    checks: [
      "scan plan is read-only",
      "RPC getAccountInfo account converts to fixture",
      "276-byte account decodes",
      "seeded task/vault match signed intent",
      "funding evidence admits to index",
    ],
    task_account: addresses.task_account,
    vault: addresses.vault,
    admitted_status: admitted.entry.status,
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-solana-live-scan: ${error.message}`);
    process.exit(1);
  }
}
