#!/usr/bin/env node

const fs = require("fs");
const { compile } = require("./tasclang");
const { createIntent, taskHashToBytes32 } = require("./tascintent");

const EXAMPLE_TASK = "examples/summarize_url.tasc";
const EXAMPLE_FIXTURE = "examples/intents/summarize_url.intent.json";
const EXAMPLE_OPTIONS = {
  buyer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  escrow: "0x2222222222222222222222222222222222222222",
  token: "0x3333333333333333333333333333333333333333",
  verifier: "0x4444444444444444444444444444444444444444",
  chainId: "84532",
  nonce: "1",
  now: "1800000000",
  decimals: 6,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const compiled = compile(fs.readFileSync(EXAMPLE_TASK, "utf8"));
  const intent = createIntent(EXAMPLE_TASK, EXAMPLE_OPTIONS);
  const fixture = JSON.parse(fs.readFileSync(EXAMPLE_FIXTURE, "utf8"));
  const typed = intent.typed_data;
  const message = typed.message;

  assert(intent.kind === "tasc.intent.eip712", "wrong intent kind");
  assert(typed.primaryType === "TaskIntent", "wrong primary type");
  assert(typed.domain.name === "Global Tasc", "wrong domain name");
  assert(typed.domain.version === "0.1", "wrong domain version");
  assert(typed.domain.chainId === 84532, "wrong chain id");
  assert(typed.domain.verifyingContract === EXAMPLE_OPTIONS.escrow, "wrong verifying contract");
  assert(message.buyer === EXAMPLE_OPTIONS.buyer, "wrong buyer");
  assert(message.escrow === EXAMPLE_OPTIONS.escrow, "wrong escrow");
  assert(message.token === EXAMPLE_OPTIONS.token, "wrong token");
  assert(message.verifier === EXAMPLE_OPTIONS.verifier, "wrong verifier");
  assert(message.amount === "10000000", "wrong USDC base-unit amount");
  assert(message.deadline === "1800000060", "wrong absolute deadline");
  assert(message.nonce === "1", "wrong nonce");
  assert(message.taskHash === taskHashToBytes32(compiled.task_hash), "wrong task bytes32");
  assert(/^sha256:[a-f0-9]{64}$/.test(intent.intent_hash), "invalid intent hash");
  assert(JSON.stringify(intent) === JSON.stringify(fixture), "generated intent does not match checked-in fixture");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    task_hash: compiled.task_hash,
    evm_task_hash: message.taskHash,
    intent_hash: intent.intent_hash,
    chain_id: typed.domain.chainId,
    escrow: message.escrow,
    token: message.token,
    amount: message.amount,
    deadline: message.deadline,
    verifier: message.verifier,
    nonce: message.nonce,
    fixture: EXAMPLE_FIXTURE,
    note: "Typed data is ready for wallet signing; this validator does not perform ECDSA signing or recovery.",
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-intent: ${error.message}`);
    process.exit(1);
  }
}
