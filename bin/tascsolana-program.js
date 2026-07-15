#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { base58Decode, base58Encode } = require("./run-solana-devnet");
const {
  seededTaskAddress,
  seededVaultAddress,
  taskPda,
  vaultPda,
  verifySignedSolanaIntent,
} = require("./tascsolana");
const { splVaultAddress } = require("./tascsolana-spl");

const TASK_ACCOUNT_DISCRIMINATOR = crypto.createHash("sha256")
  .update("global-tasc:solana-task-account:v1")
  .digest()
  .subarray(0, 8);
const TASK_ACCOUNT_SIZE = 276;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const ZERO_PUBKEY = base58Encode(Buffer.alloc(32));
const MAX_U64 = (1n << 64n) - 1n;

const STATUS_NAMES = [
  "Empty",
  "Funded",
  "Claimed",
  "Passed",
  "Failed",
  "Released",
  "Refunded",
  "Disputed",
];

const STATUS_CODES = Object.fromEntries(STATUS_NAMES.map((name, index) => [name.toLowerCase(), index]));

const INSTRUCTION_TAGS = {
  fund: 0,
  claim: 1,
  attest: 2,
  release: 3,
  refund: 4,
  open_dispute: 5,
};

const TASK_ACCOUNT_LAYOUT = [
  { name: "discriminator", offset: 0, size: 8, type: "bytes" },
  { name: "version", offset: 8, size: 1, type: "u8" },
  { name: "status", offset: 9, size: 1, type: "u8 enum" },
  { name: "bump", offset: 10, size: 1, type: "u8" },
  { name: "flags", offset: 11, size: 1, type: "u8" },
  { name: "task_hash", offset: 12, size: 32, type: "bytes32" },
  { name: "buyer", offset: 44, size: 32, type: "pubkey" },
  { name: "worker", offset: 76, size: 32, type: "pubkey" },
  { name: "verifier", offset: 108, size: 32, type: "pubkey" },
  { name: "token_mint", offset: 140, size: 32, type: "pubkey" },
  { name: "vault", offset: 172, size: 32, type: "pubkey" },
  { name: "amount", offset: 204, size: 8, type: "u64 le" },
  { name: "deadline_unix", offset: 212, size: 8, type: "u64 le" },
  { name: "nonce", offset: 220, size: 8, type: "u64 le" },
  { name: "result_hash", offset: 228, size: 32, type: "bytes32" },
  { name: "created_slot", offset: 260, size: 8, type: "u64 le" },
  { name: "updated_slot", offset: 268, size: 8, type: "u64 le" },
];

function usage() {
  console.error([
    "Usage:",
    "  node bin/tascsolana-program.js plan",
    "  node bin/tascsolana-program.js fixture <signed-solana-intent.json> [--out-dir dir]",
    "  node bin/tascsolana-program.js scan-account <signed-solana-intent.json> <task-account.json> [--out funding.json]",
    "  node bin/tascsolana-program.js decode-account <task-account.json>",
    "",
    "This is a dependencyless Solana program/scanner ABI scaffold, not a deployed program.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function parseOptions(rest) {
  const options = {
    outDir: null,
    out: null,
    slot: "42",
    signature: null,
    instructionIndex: "0",
    confirmationStatus: "confirmed",
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--out-dir") options.outDir = rest[++i];
    else if (arg === "--out") options.out = rest[++i];
    else if (arg === "--slot") options.slot = String(rest[++i]);
    else if (arg === "--signature") options.signature = rest[++i];
    else if (arg === "--instruction-index") options.instructionIndex = String(rest[++i]);
    else if (arg === "--confirmation-status") options.confirmationStatus = rest[++i];
    else usage();
  }
  return options;
}

function sha512(data) {
  return crypto.createHash("sha512").update(data).digest();
}

function deriveScannerSignature(parts) {
  return base58Encode(sha512(["global-tasc", "solana-program-fixture", ...parts].join(":")));
}

function bytes32FromHex(value, label) {
  const raw = String(value || "");
  assert(/^0x[a-fA-F0-9]{64}$/.test(raw), `${label} must be bytes32 hex`);
  return Buffer.from(raw.slice(2), "hex");
}

function hexFromBytes(bytes) {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function pubkeyBytes(address, label) {
  const decoded = base58Decode(address);
  assert(decoded.length === 32, `${label} must decode to 32 bytes`);
  return decoded;
}

function pubkeyString(bytes) {
  return base58Encode(Buffer.from(bytes));
}

function u64(value, label) {
  assert(/^\d+$/.test(String(value ?? "")), `${label} must be a u64 integer string`);
  const parsed = BigInt(String(value));
  assert(parsed >= 0n && parsed <= MAX_U64, `${label} exceeds u64`);
  return parsed;
}

function writeU64(buffer, offset, value, label) {
  buffer.writeBigUInt64LE(u64(value, label), offset);
}

function readU64(buffer, offset) {
  return buffer.readBigUInt64LE(offset).toString();
}

function statusCode(status) {
  const key = String(status || "").toLowerCase();
  assert(Object.prototype.hasOwnProperty.call(STATUS_CODES, key), `unknown task account status '${status}'`);
  return STATUS_CODES[key];
}

function statusName(code) {
  assert(Number.isInteger(code) && code >= 0 && code < STATUS_NAMES.length, `unknown task account status code ${code}`);
  return STATUS_NAMES[code];
}

function spec() {
  return {
    kind: "tasc.solana.program.spec",
    version: "0.1",
    note: "Dependencyless live-program ABI scaffold. A real Solana program should use this account layout and instruction shape so scanners can emit tasc.funding.solana.",
    task_account: {
      discriminator_hex: TASK_ACCOUNT_DISCRIMINATOR.toString("hex"),
      size: TASK_ACCOUNT_SIZE,
      layout: TASK_ACCOUNT_LAYOUT,
      statuses: Object.fromEntries(STATUS_NAMES.map((name, index) => [name, index])),
    },
    instructions: {
      tags: INSTRUCTION_TAGS,
      fund_data: [
        { name: "tag", offset: 0, size: 1, type: "u8", value: INSTRUCTION_TAGS.fund },
        { name: "task_hash", offset: 1, size: 32, type: "bytes32" },
        { name: "amount", offset: 33, size: 8, type: "u64 le" },
        { name: "deadline_unix", offset: 41, size: 8, type: "u64 le" },
        { name: "nonce", offset: 49, size: 8, type: "u64 le" },
        { name: "token_mint", offset: 57, size: 32, type: "pubkey" },
        { name: "verifier", offset: 89, size: 32, type: "pubkey" },
      ],
      claim_data: [
        { name: "tag", offset: 0, size: 1, type: "u8", value: INSTRUCTION_TAGS.claim },
      ],
      attest_data: [
        { name: "tag", offset: 0, size: 1, type: "u8", value: INSTRUCTION_TAGS.attest },
        { name: "passed", offset: 1, size: 1, type: "u8 bool" },
        { name: "result_hash", offset: 2, size: 32, type: "bytes32" },
      ],
      release_data: [
        { name: "tag", offset: 0, size: 1, type: "u8", value: INSTRUCTION_TAGS.release },
      ],
      refund_data: [
        { name: "tag", offset: 0, size: 1, type: "u8", value: INSTRUCTION_TAGS.refund },
      ],
    },
    scanner_contract: {
      input: "Solana task account owned by the Global Tasc program plus the matching signed buyer intent",
      output: "tasc.funding.solana",
      required_status: "Funded",
      matching_fields: [
        "program_id",
        "task_hash",
        "buyer",
        "token_mint",
        "amount",
        "deadline_unix",
        "verifier",
        "nonce",
      ],
    },
  };
}

function stateFromSignedIntent(signed, options = {}) {
  const signatureCheck = verifySignedSolanaIntent(signed);
  assert(signatureCheck.ok, "signed Solana intent signature is invalid");
  const message = signed.intent.message;
  const pda = taskPda(message.program_id, message.task_hash);
  const vault = vaultPda(message.program_id, message.task_hash, message.token_mint);
  return {
    kind: "tasc.solana.task_account",
    version: "0.1",
    program_id: message.program_id,
    task_pda: pda,
    status: options.status || "Funded",
    task_hash: message.task_hash,
    buyer: message.buyer,
    worker: options.worker || ZERO_PUBKEY,
    verifier: message.verifier,
    token_mint: message.token_mint,
    vault,
    amount: String(message.amount),
    deadline_unix: String(message.deadline_unix),
    nonce: String(message.nonce),
    result_hash: options.resultHash || ZERO_BYTES32,
    created_slot: String(options.createdSlot || options.slot || "42"),
    updated_slot: String(options.updatedSlot || options.slot || "42"),
  };
}

function encodeTaskAccount(state) {
  const buffer = Buffer.alloc(TASK_ACCOUNT_SIZE);
  TASK_ACCOUNT_DISCRIMINATOR.copy(buffer, 0);
  buffer.writeUInt8(1, 8);
  buffer.writeUInt8(statusCode(state.status), 9);
  buffer.writeUInt8(Number(state.bump || 0), 10);
  buffer.writeUInt8(Number(state.flags || 0), 11);
  bytes32FromHex(state.task_hash, "task_hash").copy(buffer, 12);
  pubkeyBytes(state.buyer, "buyer").copy(buffer, 44);
  pubkeyBytes(state.worker || ZERO_PUBKEY, "worker").copy(buffer, 76);
  pubkeyBytes(state.verifier, "verifier").copy(buffer, 108);
  pubkeyBytes(state.token_mint, "token_mint").copy(buffer, 140);
  pubkeyBytes(state.vault, "vault").copy(buffer, 172);
  writeU64(buffer, 204, state.amount, "amount");
  writeU64(buffer, 212, state.deadline_unix, "deadline_unix");
  writeU64(buffer, 220, state.nonce, "nonce");
  bytes32FromHex(state.result_hash || ZERO_BYTES32, "result_hash").copy(buffer, 228);
  writeU64(buffer, 260, state.created_slot || "0", "created_slot");
  writeU64(buffer, 268, state.updated_slot || "0", "updated_slot");
  return buffer;
}

function decodeTaskAccount(data, options = {}) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "base64");
  assert(buffer.length === TASK_ACCOUNT_SIZE, `task account data must be ${TASK_ACCOUNT_SIZE} bytes`);
  assert(buffer.subarray(0, 8).equals(TASK_ACCOUNT_DISCRIMINATOR), "task account discriminator mismatch");
  const version = buffer.readUInt8(8);
  assert(version === 1, `unsupported task account version ${version}`);
  const decoded = {
    kind: "tasc.solana.task_account",
    version: "0.1",
    program_id: options.programId || null,
    task_pda: options.taskPda || null,
    status: statusName(buffer.readUInt8(9)),
    status_code: buffer.readUInt8(9),
    bump: buffer.readUInt8(10),
    flags: buffer.readUInt8(11),
    task_hash: hexFromBytes(buffer.subarray(12, 44)),
    buyer: pubkeyString(buffer.subarray(44, 76)),
    worker: pubkeyString(buffer.subarray(76, 108)),
    verifier: pubkeyString(buffer.subarray(108, 140)),
    token_mint: pubkeyString(buffer.subarray(140, 172)),
    vault: pubkeyString(buffer.subarray(172, 204)),
    amount: readU64(buffer, 204),
    deadline_unix: readU64(buffer, 212),
    nonce: readU64(buffer, 220),
    result_hash: hexFromBytes(buffer.subarray(228, 260)),
    created_slot: readU64(buffer, 260),
    updated_slot: readU64(buffer, 268),
  };
  if (!decoded.program_id || !decoded.task_pda) {
    const expectedProgram = options.programId || null;
    if (expectedProgram) decoded.task_pda = taskPda(expectedProgram, decoded.task_hash);
  }
  return decoded;
}

function encodeInstruction(name, fields = {}) {
  const tag = INSTRUCTION_TAGS[name];
  assert(tag !== undefined, `unknown instruction '${name}'`);
  if (name === "fund") {
    const buffer = Buffer.alloc(121);
    buffer.writeUInt8(tag, 0);
    bytes32FromHex(fields.task_hash, "task_hash").copy(buffer, 1);
    writeU64(buffer, 33, fields.amount, "amount");
    writeU64(buffer, 41, fields.deadline_unix, "deadline_unix");
    writeU64(buffer, 49, fields.nonce, "nonce");
    pubkeyBytes(fields.token_mint, "token_mint").copy(buffer, 57);
    pubkeyBytes(fields.verifier, "verifier").copy(buffer, 89);
    return buffer;
  }
  if (name === "attest") {
    const verdict = String(fields.verdict || "").toLowerCase();
    assert(verdict === "pass" || verdict === "fail", "attest verdict must be pass or fail");
    return Buffer.concat([
      Buffer.from([tag, verdict === "pass" ? 1 : 0]),
      bytes32FromHex(fields.result_hash, "result_hash"),
    ]);
  }
  return Buffer.from([tag]);
}

function decodeInstruction(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data).replace(/^0x/, ""), "hex");
  assert(buffer.length >= 1, "instruction data is empty");
  const tag = buffer.readUInt8(0);
  const name = Object.entries(INSTRUCTION_TAGS).find(([, value]) => value === tag);
  assert(name, `unknown instruction tag ${tag}`);
  if (name[0] === "fund") {
    assert(buffer.length === 121, "fund instruction data must be 121 bytes");
    return {
      name: "fund",
      tag,
      task_hash: hexFromBytes(buffer.subarray(1, 33)),
      amount: readU64(buffer, 33),
      deadline_unix: readU64(buffer, 41),
      nonce: readU64(buffer, 49),
      token_mint: pubkeyString(buffer.subarray(57, 89)),
      verifier: pubkeyString(buffer.subarray(89, 121)),
    };
  }
  if (name[0] === "attest") {
    assert(buffer.length === 34, "attest instruction data must be 34 bytes");
    return {
      name: "attest",
      tag,
      verdict: buffer.readUInt8(1) === 1 ? "pass" : "fail",
      result_hash: hexFromBytes(buffer.subarray(2, 34)),
    };
  }
  assert(buffer.length === 1, `${name[0]} instruction data must be one byte`);
  return { name: name[0], tag };
}

function fundInstructionFromSignedIntent(signed) {
  const message = signed.intent.message;
  const pda = taskPda(message.program_id, message.task_hash);
  const vault = vaultPda(message.program_id, message.task_hash, message.token_mint);
  const data = encodeInstruction("fund", message);
  return {
    kind: "tasc.solana.program.instruction",
    version: "0.1",
    name: "fund",
    program_id: message.program_id,
    accounts: [
      { name: "buyer", pubkey: message.buyer, signer: true, writable: true },
      { name: "task", pubkey: pda, signer: false, writable: true },
      { name: "vault", pubkey: vault, signer: false, writable: true },
      { name: "token_mint", pubkey: message.token_mint, signer: false, writable: false },
      { name: "verifier", pubkey: message.verifier, signer: false, writable: false },
    ],
    data_hex: `0x${data.toString("hex")}`,
    decoded: decodeInstruction(data),
  };
}

function taskAccountFixtureFromState(state) {
  const data = encodeTaskAccount(state);
  return {
    kind: "tasc.solana.program.account.fixture",
    version: "0.1",
    pubkey: state.task_pda,
    owner: state.program_id,
    executable: false,
    lamports: "2039280",
    rent_epoch: "0",
    data_base64: data.toString("base64"),
    decoded: decodeTaskAccount(data, {
      programId: state.program_id,
      taskPda: state.task_pda,
    }),
  };
}

function decodedAccountFromFixture(account) {
  if (account && account.kind === "tasc.solana.task_account") return account;
  assert(account && account.data_base64, "task account fixture missing data_base64");
  return decodeTaskAccount(account.data_base64, {
    programId: account.owner || account.program_id,
    taskPda: account.pubkey || account.task_pda,
  });
}

function compareAccountToSignedIntent(signed, decoded) {
  const signatureCheck = verifySignedSolanaIntent(signed);
  assert(signatureCheck.ok, "signed Solana intent signature is invalid");
  const message = signed.intent.message;
  const expectedTaskPda = taskPda(message.program_id, message.task_hash);
  const expectedSeededTask = seededTaskAddress(message.program_id, message.buyer, message.task_hash);
  const expectedVault = vaultPda(message.program_id, message.task_hash, message.token_mint);
  const expectedSeededVault = seededVaultAddress(message.program_id, message.buyer, message.task_hash, message.token_mint);
  const expectedSplVault = splVaultAddress(message.program_id, message.buyer, message.task_hash, message.token_mint);
  const checks = [
    ["program_id", !decoded.program_id || decoded.program_id === message.program_id],
    ["task_pda", !decoded.task_pda || decoded.task_pda === expectedTaskPda || decoded.task_pda === expectedSeededTask],
    ["task_hash", decoded.task_hash.toLowerCase() === message.task_hash.toLowerCase()],
    ["buyer", decoded.buyer === message.buyer],
    ["token_mint", decoded.token_mint === message.token_mint],
    ["vault", decoded.vault === expectedVault || decoded.vault === expectedSeededVault || decoded.vault === expectedSplVault],
    ["amount", decoded.amount === String(message.amount)],
    ["deadline_unix", decoded.deadline_unix === String(message.deadline_unix)],
    ["verifier", decoded.verifier === message.verifier],
    ["nonce", decoded.nonce === String(message.nonce)],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`Task account does not match signed intent: ${failed.join(", ")}`);
  }
  return checks.map(([name, pass]) => ({ name, pass }));
}

function fundingEvidenceFromTaskAccount(input) {
  const decoded = decodedAccountFromFixture(input.account);
  assert(decoded.status === "Funded", "task account status must be Funded");
  compareAccountToSignedIntent(input.signed, decoded);
  const message = input.signed.intent.message;
  const tx = input.tx || {};
  const slot = String(tx.slot || decoded.updated_slot || "0");
  return {
    kind: "tasc.funding.solana",
    version: "0.1",
    cluster: message.cluster,
    program_id: message.program_id,
    task_hash: decoded.task_hash,
    task_pda: decoded.task_pda || taskPda(message.program_id, decoded.task_hash),
    vault: decoded.vault,
    buyer: decoded.buyer,
    token_mint: decoded.token_mint,
    amount: decoded.amount,
    deadline_unix: decoded.deadline_unix,
    verifier: decoded.verifier,
    status: "Funded",
    signature: tx.signature || deriveScannerSignature([message.program_id, decoded.task_hash, decoded.buyer, slot]),
    slot,
    instruction_index: String(tx.instruction_index || "0"),
    confirmation_status: tx.confirmation_status || "confirmed",
  };
}

function createProgramFixture(signed, options = {}) {
  const state = stateFromSignedIntent(signed, { slot: options.slot || "42" });
  const account = taskAccountFixtureFromState(state);
  const instruction = fundInstructionFromSignedIntent(signed);
  const tx = {
    signature: options.signature || deriveScannerSignature([state.program_id, state.task_hash, state.buyer, options.slot || "42"]),
    slot: String(options.slot || "42"),
    instruction_index: String(options.instructionIndex || "0"),
    confirmation_status: options.confirmationStatus || "confirmed",
  };
  const funding = fundingEvidenceFromTaskAccount({ signed, account, tx });
  return {
    ok: true,
    spec: spec(),
    account,
    instruction,
    tx,
    funding,
  };
}

function writeProgramFixture(outDir, fixture, taskName = "summarize_url") {
  writeJson(path.join(outDir, `${taskName}.program-spec.json`), fixture.spec);
  writeJson(path.join(outDir, `${taskName}.fund-instruction.json`), fixture.instruction);
  writeJson(path.join(outDir, `${taskName}.task-account.json`), fixture.account);
  writeJson(path.join(outDir, `${taskName}.funding.from-account.json`), fixture.funding);
}

function scanAccount(signedFile, accountFile, options = {}) {
  const signed = loadJson(signedFile);
  const account = loadJson(accountFile);
  return fundingEvidenceFromTaskAccount({
    signed,
    account,
    tx: {
      signature: options.signature,
      slot: options.slot,
      instruction_index: options.instructionIndex,
      confirmation_status: options.confirmationStatus,
    },
  });
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "plan") {
    parseOptions(argv.slice(1));
    process.stdout.write(`${JSON.stringify(spec(), null, 2)}\n`);
    return;
  }

  if (command === "fixture") {
    const first = argv[1];
    if (!first) usage();
    const options = parseOptions(argv.slice(2));
    const signed = loadJson(first);
    const fixture = createProgramFixture(signed, options);
    if (options.outDir) writeProgramFixture(options.outDir, fixture, signed.intent.task_name || "task");
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
    return;
  }

  if (command === "scan-account") {
    const first = argv[1];
    const second = argv[2];
    if (!first || !second) usage();
    const options = parseOptions(argv.slice(3));
    const funding = scanAccount(first, second, options);
    if (options.out) writeJson(options.out, funding);
    process.stdout.write(`${JSON.stringify(funding, null, 2)}\n`);
    return;
  }

  if (command === "decode-account") {
    const first = argv[1];
    if (!first) usage();
    parseOptions(argv.slice(2));
    const account = loadJson(first);
    process.stdout.write(`${JSON.stringify(decodedAccountFromFixture(account), null, 2)}\n`);
    return;
  }

  usage();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`tascsolana-program: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  TASK_ACCOUNT_SIZE,
  compareAccountToSignedIntent,
  createProgramFixture,
  decodeInstruction,
  decodeTaskAccount,
  encodeInstruction,
  encodeTaskAccount,
  fundingEvidenceFromTaskAccount,
  scanAccount,
  spec,
  stateFromSignedIntent,
  taskAccountFixtureFromState,
  writeProgramFixture,
};
