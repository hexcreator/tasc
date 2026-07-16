#!/usr/bin/env node

const {
  base58Decode,
  encodeShortVectorLength,
} = require("./run-solana-devnet");
const {
  createSolanaIntent,
  fixtureKeypair,
  signSolanaIntent,
} = require("./tascsolana");
const {
  SYSTEM_PROGRAM_ID,
  buildFundInstructions,
  compileLegacyMessage,
  createWithSeedAddress,
  fundAddresses,
  plan,
  systemCreateAccountWithSeedData,
} = require("./run-solana-fund");
const { TASK_ACCOUNT_SIZE, decodeInstruction } = require("./tascsolana-program");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const EXAMPLE_INPUTS = { url: "https://docs.cdp.coinbase.com/x402/welcome" };

function main() {
  const zero = "11111111111111111111111111111111";
  assert(
    createWithSeedAddress(zero, "limber chicken: 4/45", zero) === "9h1HyLCW5dZnBVap8C5egQ9Z6pHyjsh5MNy83iPqqRuq",
    "create_with_seed test vector mismatch",
  );
  assert(encodeShortVectorLength(3).equals(Buffer.from([3])), "shortvec sanity mismatch");

  const buyer = fixtureKeypair("buyer");
  const verifier = fixtureKeypair("verifier");
  const programId = fixtureKeypair("program").address;
  const tokenMint = fixtureKeypair("token_mint").address;
  const { intent } = createSolanaIntent("examples/summarize_url.tasc", {
    buyer: buyer.address,
    verifier: verifier.address,
    programId,
    tokenMint,
    inputs: EXAMPLE_INPUTS,
  });
  const signed = signSolanaIntent(intent, buyer);
  const addresses = fundAddresses(signed.intent.message);
  const { instructions } = buildFundInstructions(signed, {
    task_lamports: "2039280",
    vault_lamports: "890880",
  });

  assert(instructions.length === 3, "fund tx should have create task, create vault, and fund instructions");
  assert(instructions[0].programId === SYSTEM_PROGRAM_ID, "first instruction should be system program");
  assert(instructions[1].programId === SYSTEM_PROGRAM_ID, "second instruction should be system program");
  assert(instructions[2].programId === programId, "third instruction should call Global Tasc program");
  assert(instructions[2].accounts[0].pubkey === buyer.address, "fund buyer account mismatch");
  assert(instructions[2].accounts[1].pubkey === addresses.task_account, "fund task account mismatch");
  assert(instructions[2].accounts[2].pubkey === addresses.vault, "fund vault account mismatch");
  assert(decodeInstruction(instructions[2].data).amount === signed.intent.message.amount, "fund instruction amount mismatch");

  const createData = systemCreateAccountWithSeedData({
    base: buyer.address,
    seed: addresses.task_seed,
    lamports: "2039280",
    space: TASK_ACCOUNT_SIZE,
    owner: programId,
  });
  assert(createData.readUInt32LE(0) === 3, "create_account_with_seed variant should be 3");

  const fakeBlockhash = "11111111111111111111111111111111";
  const compiled = compileLegacyMessage({
    payer: buyer.address,
    recentBlockhash: fakeBlockhash,
    instructions,
  });
  assert(compiled.message.length > 0, "compiled Solana message should not be empty");
  assert(compiled.accountKeys[0].pubkey === buyer.address, "payer must be first account");
  assert(compiled.accountKeys[0].signer === true, "payer must sign");
  assert(compiled.accountKeys.some((meta) => meta.pubkey === addresses.task_account), "message missing task account");
  assert(compiled.accountKeys.some((meta) => meta.pubkey === addresses.vault), "message missing vault account");
  assert(base58Decode(addresses.task_account).length === 32, "task account must decode to 32 bytes");
  assert(base58Decode(addresses.vault).length === 32, "vault account must decode to 32 bytes");

  const planned = plan({ signedFile: "examples/solana/summarize_url.signature.json", envFile: ".env.solana-devnet.local" });
  assert(planned.sends_transactions === false, "plan must not send transactions");
  assert(planned.guard_for_send === "GLOBAL_TASC_ALLOW_SOLANA_FUND=1", "send guard mismatch");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checks: [
      "create_with_seed official test vector",
      "create_account_with_seed data",
      "fund instruction data",
      "legacy message account ordering",
      "plan is non-sending and guarded",
    ],
    task_account: addresses.task_account,
    vault: addresses.vault,
    no_new_dependencies: true,
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-solana-fund-tx: ${error.message}`);
    process.exit(1);
  }
}
