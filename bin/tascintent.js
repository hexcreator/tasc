#!/usr/bin/env node

const fs = require("fs");
const crypto = require("crypto");
const { compile, canonicalize } = require("./tasclang");

const DEFAULT_DOMAIN_NAME = "Global Tasc";
const DEFAULT_DOMAIN_VERSION = "0.1";
const DEFAULT_DECIMALS = 6;

function usage() {
  console.error([
    "Usage:",
    "  node bin/tascintent.js create <file.tasc> --buyer 0x... --escrow 0x... --token 0x... --verifier 0x... --chain-id n --nonce n --input name=value [--input name=value ...] [--now unix] [--decimals n] [--out file]",
    "",
    "The output is EIP-712-compatible typed data for a buyer to sign.",
  ].join("\n"));
  process.exit(1);
}

function parseArgs(argv) {
  const [command, taskFile, ...rest] = argv;
  if (command !== "create" || !taskFile) usage();

  const options = { decimals: DEFAULT_DECIMALS, inputs: {} };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--buyer") options.buyer = rest[++i];
    else if (arg === "--escrow") options.escrow = rest[++i];
    else if (arg === "--token") options.token = rest[++i];
    else if (arg === "--verifier") options.verifier = rest[++i];
    else if (arg === "--chain-id") options.chainId = rest[++i];
    else if (arg === "--nonce") options.nonce = rest[++i];
    else if (arg === "--input") {
      const [name, ...valueParts] = String(rest[++i] || "").split("=");
      if (!name || valueParts.length === 0) throw new Error("--input must use name=value");
      options.inputs[name] = valueParts.join("=");
    }
    else if (arg === "--now") options.now = rest[++i];
    else if (arg === "--decimals") options.decimals = Number(rest[++i]);
    else if (arg === "--out") options.out = rest[++i];
    else usage();
  }

  return { taskFile, options };
}

function assertAddress(value, label) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value || "")) {
    throw new Error(`${label} must be a 20-byte hex address`);
  }
  return value.toLowerCase();
}

function assertUint(value, label) {
  if (!/^\d+$/.test(String(value || ""))) {
    throw new Error(`${label} must be a positive integer string`);
  }
  return String(value);
}

function taskHashToBytes32(taskHash) {
  if (!taskHash.startsWith("sha256:")) {
    throw new Error("task hash must use sha256:<hex>");
  }
  const raw = taskHash.slice("sha256:".length);
  if (!/^[a-f0-9]{64}$/.test(raw)) {
    throw new Error("task hash must contain 32 bytes of lowercase hex");
  }
  return `0x${raw}`;
}

function decimalToBaseUnits(amount, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error("decimals must be an integer between 0 and 30");
  }

  const raw = String(amount);
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Invalid decimal amount '${raw}'`);
  }

  const [whole, frac = ""] = raw.split(".");
  if (frac.length > decimals) {
    throw new Error(`Amount '${raw}' has more precision than ${decimals} decimals`);
  }

  return `${whole}${frac.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
}

function unixNow(options) {
  if (options.now !== undefined) return Number(assertUint(options.now, "now"));
  return Math.floor(Date.now() / 1000);
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function normalizeTaskInputs(task, rawInputs = {}) {
  const allowed = new Set(task.inputs.map((field) => field.name));
  const normalized = {};

  for (const key of Object.keys(rawInputs).sort()) {
    if (!allowed.has(key)) throw new Error(`Unknown task input '${key}'`);
  }

  for (const field of task.inputs) {
    if (!Object.prototype.hasOwnProperty.call(rawInputs, field.name)) {
      throw new Error(`Missing task input '${field.name}'. Pass --input ${field.name}=...`);
    }
    if (field.type !== "string") {
      throw new Error(`Input '${field.name}' uses unsupported type '${field.type}'`);
    }
    normalized[field.name] = String(rawInputs[field.name]);
  }

  return normalized;
}

function inputHashToBytes32(inputs) {
  return `0x${sha256Hex(canonicalize(inputs))}`;
}

function createIntent(taskFile, options) {
  const compiled = compile(fs.readFileSync(taskFile, "utf8"));
  const now = unixNow(options);
  const deadline = now + Number(compiled.task.deadline.seconds);
  if (!Number.isInteger(deadline)) throw new Error("EVM deadline must resolve to an integer Unix timestamp");

  const chainId = Number(assertUint(options.chainId, "chain-id"));
  const buyer = assertAddress(options.buyer, "buyer");
  const escrow = assertAddress(options.escrow, "escrow");
  const token = assertAddress(options.token, "token");
  const verifier = assertAddress(options.verifier, "verifier");
  const amount = decimalToBaseUnits(compiled.task.reward.amount, options.decimals);
  const nonce = assertUint(options.nonce, "nonce");
  const taskHash = taskHashToBytes32(compiled.task_hash);
  const inputs = normalizeTaskInputs(compiled.task, options.inputs || {});
  const inputHash = inputHashToBytes32(inputs);

  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TaskIntent: [
        { name: "buyer", type: "address" },
        { name: "taskHash", type: "bytes32" },
        { name: "inputHash", type: "bytes32" },
        { name: "escrow", type: "address" },
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "deadline", type: "uint64" },
        { name: "verifier", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "TaskIntent",
    domain: {
      name: DEFAULT_DOMAIN_NAME,
      version: DEFAULT_DOMAIN_VERSION,
      chainId,
      verifyingContract: escrow,
    },
    message: {
      buyer,
      taskHash,
      inputHash,
      escrow,
      token,
      amount,
      deadline: String(deadline),
      verifier,
      nonce,
    },
  };

  const intent = {
    kind: "tasc.intent.eip712",
    version: "0.1",
    task_file: taskFile,
    task_name: compiled.task.name,
    display_reward: compiled.task.reward,
    chain_reward: {
      amount,
      decimals: options.decimals,
      token,
    },
    relative_deadline: compiled.task.deadline,
    inputs,
    input_hash: inputHash,
    generated_at_unix: now,
    typed_data: typedData,
  };
  intent.intent_hash = `sha256:${sha256Hex(canonicalize(intent))}`;
  return intent;
}

function main() {
  const { taskFile, options } = parseArgs(process.argv.slice(2));
  const intent = createIntent(taskFile, options);
  const output = `${JSON.stringify(intent, null, 2)}\n`;
  if (options.out) {
    fs.writeFileSync(options.out, output);
  } else {
    process.stdout.write(output);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`tascintent: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  createIntent,
  decimalToBaseUnits,
  inputHashToBytes32,
  normalizeTaskInputs,
  taskHashToBytes32,
};
