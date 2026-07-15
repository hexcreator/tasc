#!/usr/bin/env node

const fs = require("fs");
const { verifySignedIntent, TEST_KEYS } = require("./tascsign");
const { Wallet } = require("ethers");

const SIGNATURE_FIXTURE = "examples/signatures/summarize_url.signature.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const signed = JSON.parse(fs.readFileSync(SIGNATURE_FIXTURE, "utf8"));
  const result = verifySignedIntent(signed);
  const expectedBuyer = new Wallet(TEST_KEYS.hardhat0.privateKey).address;

  assert(result.ok, "signature did not verify");
  assert(result.buyer.toLowerCase() === expectedBuyer.toLowerCase(), "buyer is not the hardhat0 test wallet");
  assert(result.recovered.toLowerCase() === expectedBuyer.toLowerCase(), "recovered signer mismatch");
  assert(signed.valid === true, "fixture valid flag is not true");
  assert(signed.key_source === "test:hardhat0", "fixture should be signed by hardhat0 test key");
  assert(/^0x[a-fA-F0-9]{130}$/.test(signed.signature), "signature must be 65-byte hex");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    fixture: SIGNATURE_FIXTURE,
    intent_hash: signed.intent_hash,
    buyer: result.buyer,
    recovered: result.recovered,
    signature: signed.signature,
    note: "Signature recovers to the buyer address. The key is a public test key only.",
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-signature: ${error.message}`);
    process.exit(1);
  }
}
