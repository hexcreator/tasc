#!/usr/bin/env node

const fs = require("fs");
const { Wallet, verifyTypedData } = require("ethers");

const TEST_KEYS = {
  hardhat0: {
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    note: "Public Hardhat/Anvil test key. Never use on mainnet or with real funds.",
  },
};

function usage() {
  console.error([
    "Usage:",
    "  node bin/tascsign.js sign <intent.json> --test-key hardhat0 [--out file]",
    "  node bin/tascsign.js sign <intent.json> --private-key-env ENV_NAME [--out file]",
    "  node bin/tascsign.js verify <signed-intent.json>",
  ].join("\n"));
  process.exit(1);
}

function parseArgs(argv) {
  const [command, file, ...rest] = argv;
  if (!command || !file) usage();

  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--test-key") options.testKey = rest[++i];
    else if (arg === "--private-key-env") options.privateKeyEnv = rest[++i];
    else if (arg === "--out") options.out = rest[++i];
    else usage();
  }

  return { command, file, options };
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function eip712Parts(intent) {
  if (!intent.typed_data) throw new Error("Intent missing typed_data");
  const { domain, types, message } = intent.typed_data;
  if (!domain || !types || !message) throw new Error("Intent typed_data is incomplete");

  const signingTypes = { ...types };
  delete signingTypes.EIP712Domain;

  return { domain, types: signingTypes, message };
}

function privateKeyFromOptions(options) {
  if (options.testKey) {
    const key = TEST_KEYS[options.testKey];
    if (!key) throw new Error(`Unknown test key '${options.testKey}'`);
    return { privateKey: key.privateKey, source: `test:${options.testKey}`, note: key.note };
  }

  if (options.privateKeyEnv) {
    const privateKey = process.env[options.privateKeyEnv];
    if (!privateKey) throw new Error(`Environment variable ${options.privateKeyEnv} is empty`);
    return { privateKey, source: `env:${options.privateKeyEnv}` };
  }

  throw new Error("Missing --test-key or --private-key-env");
}

async function signIntent(intent, options) {
  const key = privateKeyFromOptions(options);
  const wallet = new Wallet(key.privateKey);
  const { domain, types, message } = eip712Parts(intent);
  const signature = await wallet.signTypedData(domain, types, message);
  const recovered = verifyTypedData(domain, types, message, signature);
  const buyer = String(message.buyer);
  const valid = recovered.toLowerCase() === buyer.toLowerCase();

  return {
    kind: "tasc.intent.signature.eip712",
    version: "0.1",
    intent_hash: intent.intent_hash,
    task_file: intent.task_file,
    task_name: intent.task_name,
    display_reward: intent.display_reward,
    chain_reward: intent.chain_reward,
    relative_deadline: intent.relative_deadline,
    inputs: intent.inputs,
    input_hash: intent.input_hash,
    signer: wallet.address,
    buyer,
    recovered,
    valid,
    signature,
    key_source: key.source,
    note: key.note || "Signed with private key from environment.",
    typed_data: intent.typed_data,
  };
}

function verifySignedIntent(signed) {
  const { domain, types, message } = eip712Parts({ typed_data: signed.typed_data });
  if (!signed.signature) throw new Error("Signed intent missing signature");
  const recovered = verifyTypedData(domain, types, message, signed.signature);
  const buyer = String(message.buyer);
  const valid = recovered.toLowerCase() === buyer.toLowerCase();

  return {
    ok: valid,
    intent_hash: signed.intent_hash,
    buyer,
    recovered,
    signature: signed.signature,
  };
}

async function main() {
  const { command, file, options } = parseArgs(process.argv.slice(2));

  if (command === "sign") {
    const intent = loadJson(file);
    const signed = await signIntent(intent, options);
    const output = `${JSON.stringify(signed, null, 2)}\n`;
    if (options.out) fs.writeFileSync(options.out, output);
    else process.stdout.write(output);
    if (!signed.valid) process.exit(2);
    return;
  }

  if (command === "verify") {
    const signed = loadJson(file);
    const result = verifySignedIntent(signed);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exit(2);
    return;
  }

  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`tascsign: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  TEST_KEYS,
  signIntent,
  verifySignedIntent,
};
