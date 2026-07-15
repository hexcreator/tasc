#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { compile, canonicalize } = require("./tasclang");
const { verifyCompiledTask } = require("./tascverify");
const { decimalToBaseUnits, taskHashToBytes32 } = require("./tascintent");
const { base58Decode, base58Encode } = require("./run-solana-devnet");

const DEFAULT_CLUSTER = "devnet";
const DEFAULT_DECIMALS = 6;
const DEFAULT_NOW = 1800000000;
const DEFAULT_NONCE = "1";
const EXAMPLE_INPUTS = { url: "https://docs.cdp.coinbase.com/x402/welcome" };
const EXAMPLE_LEDGER = "examples/ledger.json";

function usage() {
  console.error([
    "Usage:",
    "  node bin/tascsolana.js demo <file.tasc> <submission.md> [--out-dir dir]",
    "  node bin/tascsolana.js validate-signature <signed-solana-intent.json>",
    "",
    "The demo is a local Solana account-model settlement adapter, not an on-chain program deployment.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseOptions(rest) {
  const options = {
    outDir: null,
    now: DEFAULT_NOW,
    nonce: DEFAULT_NONCE,
    decimals: DEFAULT_DECIMALS,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--out-dir") options.outDir = rest[++i];
    else if (arg === "--now") options.now = Number(rest[++i]);
    else if (arg === "--nonce") options.nonce = rest[++i];
    else usage();
  }
  return options;
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function intentHash(intent) {
  const { intent_hash: _intentHash, ...hashable } = intent;
  return `sha256:${sha256Hex(canonicalize(hashable))}`;
}

function sha512(data) {
  return crypto.createHash("sha512").update(data).digest();
}

function publicKeyFromSeed(seed) {
  const privateKey = privateKeyFromSeed(seed);
  const publicKey = crypto.createPublicKey(privateKey);
  return Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
}

function privateKeyFromSeed(seed) {
  assert(Buffer.from(seed).length === 32, "ed25519 seed must be 32 bytes");
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return crypto.createPrivateKey({
    key: Buffer.concat([prefix, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyObject(publicKeyBytes) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return crypto.createPublicKey({
    key: Buffer.concat([prefix, Buffer.from(publicKeyBytes)]),
    format: "der",
    type: "spki",
  });
}

function fixtureKeypair(role) {
  const seed = sha256(`global-tasc-solana-${role}-fixture-v1`);
  const publicKey = publicKeyFromSeed(seed);
  return {
    role,
    seed,
    publicKey,
    address: base58Encode(publicKey),
  };
}

function deriveAddress(label, parts = []) {
  return base58Encode(sha256(["global-tasc", label, ...parts].join(":")));
}

function deriveSignature(label, parts = []) {
  return base58Encode(sha512(["global-tasc", label, ...parts].join(":")));
}

function assertSolanaAddress(value, label) {
  const raw = String(value || "");
  assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw), `${label} must be a Solana base58 address`);
  assert(base58Decode(raw).length === 32, `${label} must decode to 32 bytes`);
  return raw;
}

function assertBytes32(value, label) {
  assert(/^0x[a-fA-F0-9]{64}$/.test(String(value || "")), `${label} must be bytes32 hex`);
  return String(value).toLowerCase();
}

function assertUint(value, label) {
  assert(/^\d+$/.test(String(value ?? "")), `${label} must be an integer string`);
  return String(value);
}

function createSolanaIntent(taskFile, options = {}) {
  const compiled = compile(fs.readFileSync(taskFile, "utf8"));
  const buyer = options.buyer || fixtureKeypair("buyer").address;
  const verifier = options.verifier || fixtureKeypair("verifier").address;
  const programId = options.programId || deriveAddress("program-v1");
  const tokenMint = options.tokenMint || deriveAddress("mock-usdc-mint-v1");
  const now = Number(options.now ?? DEFAULT_NOW);
  const deadlineUnix = now + Number(compiled.task.deadline.seconds);
  const amount = decimalToBaseUnits(compiled.task.reward.amount, options.decimals ?? DEFAULT_DECIMALS);
  const nonce = assertUint(options.nonce ?? DEFAULT_NONCE, "nonce");
  const taskHash = taskHashToBytes32(compiled.task_hash);

  assertSolanaAddress(buyer, "buyer");
  assertSolanaAddress(verifier, "verifier");
  assertSolanaAddress(programId, "program_id");
  assertSolanaAddress(tokenMint, "token_mint");

  const intent = {
    kind: "tasc.intent.solana",
    version: "0.1",
    task_file: taskFile,
    task_name: compiled.task.name,
    display_reward: compiled.task.reward,
    chain_reward: {
      amount,
      decimals: options.decimals ?? DEFAULT_DECIMALS,
      token_mint: tokenMint,
    },
    relative_deadline: compiled.task.deadline,
    generated_at_unix: now,
    message: {
      cluster: options.cluster || DEFAULT_CLUSTER,
      program_id: programId,
      buyer,
      task_hash: taskHash,
      token_mint: tokenMint,
      amount,
      deadline_unix: String(deadlineUnix),
      verifier,
      nonce,
    },
  };
  intent.intent_hash = intentHash(intent);
  return { intent, compiled };
}

function signSolanaIntent(intent, keypair) {
  assert(keypair && keypair.seed && keypair.publicKey, "missing Solana keypair");
  const canonicalIntent = canonicalize(intent);
  const signature = crypto.sign(null, Buffer.from(canonicalIntent), privateKeyFromSeed(keypair.seed));
  const signer = base58Encode(keypair.publicKey);
  assert(signer === intent.message.buyer, "signer must equal intent buyer for this adapter");

  return {
    kind: "tasc.intent.signature.solana",
    version: "0.1",
    intent_hash: intent.intent_hash,
    signer,
    buyer: intent.message.buyer,
    signature: base58Encode(signature),
    intent,
  };
}

function verifySignedSolanaIntent(signed) {
  assert(signed.kind === "tasc.intent.signature.solana", "signed intent kind must be tasc.intent.signature.solana");
  assert(signed.intent && signed.intent.kind === "tasc.intent.solana", "signed intent missing Solana intent");
  const calculatedHash = intentHash(signed.intent);
  assert(calculatedHash === signed.intent_hash, "Solana intent hash mismatch");
  assert(signed.intent.intent_hash === signed.intent_hash, "embedded Solana intent hash mismatch");
  const signer = assertSolanaAddress(signed.signer, "signer");
  assert(signer === signed.intent.message.buyer, "Solana signer must equal buyer");
  const signature = base58Decode(signed.signature);
  assert(signature.length === 64, "Solana intent signature must decode to 64 bytes");
  const publicKey = base58Decode(signer);
  assert(publicKey.length === 32, "Solana signer must decode to 32 bytes");
  const ok = crypto.verify(
    null,
    Buffer.from(canonicalize(signed.intent)),
    publicKeyObject(publicKey),
    signature,
  );
  return {
    ok,
    signer,
    recovered: signer,
    intent_hash: signed.intent_hash,
  };
}

function taskPda(programId, taskHash) {
  return deriveAddress("task-pda", [programId, assertBytes32(taskHash, "task_hash")]);
}

function vaultPda(programId, taskHash, tokenMint) {
  return deriveAddress("vault-pda", [programId, assertBytes32(taskHash, "task_hash"), tokenMint]);
}

function createWithSeedAddress(base, seed, owner) {
  const rawSeed = String(seed);
  assert(Buffer.byteLength(rawSeed, "utf8") <= 32, "Solana seed must be 32 bytes or shorter");
  const baseBytes = base58Decode(assertSolanaAddress(base, "base"));
  const ownerBytes = base58Decode(assertSolanaAddress(owner, "owner"));
  return base58Encode(sha256(Buffer.concat([baseBytes, Buffer.from(rawSeed, "utf8"), ownerBytes])));
}

function seededTaskSeed(taskHash) {
  const hash = assertBytes32(taskHash, "task_hash").slice(2);
  return `task-${hash.slice(0, 27)}`;
}

function seededVaultSeed(taskHash, tokenMint) {
  assertSolanaAddress(tokenMint, "token_mint");
  return `vault-${sha256Hex(`${assertBytes32(taskHash, "task_hash")}:${tokenMint}`).slice(0, 26)}`;
}

function seededTaskAddress(programId, buyer, taskHash) {
  return createWithSeedAddress(buyer, seededTaskSeed(taskHash), programId);
}

function seededVaultAddress(programId, buyer, taskHash, tokenMint) {
  return createWithSeedAddress(buyer, seededVaultSeed(taskHash, tokenMint), programId);
}

function buildFundingEvidence(signed, options = {}) {
  const message = signed.intent.message;
  const pda = taskPda(message.program_id, message.task_hash);
  const vault = vaultPda(message.program_id, message.task_hash, message.token_mint);
  return {
    kind: "tasc.funding.solana",
    version: "0.1",
    cluster: message.cluster,
    program_id: message.program_id,
    task_hash: message.task_hash,
    task_pda: pda,
    vault,
    buyer: message.buyer,
    token_mint: message.token_mint,
    amount: message.amount,
    deadline_unix: message.deadline_unix,
    verifier: message.verifier,
    status: "Funded",
    signature: options.signature || deriveSignature("fund", [message.program_id, message.task_hash, message.buyer]),
    slot: options.slot || 1,
    instruction_index: options.instructionIndex || 0,
    confirmation_status: options.confirmationStatus || "confirmed",
  };
}

function simulateSettlement(input) {
  const signatureCheck = verifySignedSolanaIntent(input.signed);
  assert(signatureCheck.ok, "Solana signed intent signature is invalid");
  const message = input.signed.intent.message;
  const worker = input.worker || fixtureKeypair("worker").address;
  assertSolanaAddress(worker, "worker");

  const funding = buildFundingEvidence(input.signed);
  const state = {
    kind: "tasc.solana.settlement",
    version: "0.1",
    cluster: message.cluster,
    program_id: message.program_id,
    task_pda: funding.task_pda,
    vault: funding.vault,
    task_hash: message.task_hash,
    buyer: message.buyer,
    worker: null,
    verifier: message.verifier,
    token_mint: message.token_mint,
    amount: message.amount,
    deadline_unix: message.deadline_unix,
    result_hash: null,
    status: "Funded",
    token_accounts: {
      buyer: "0",
      vault: message.amount,
      worker: "0",
    },
    events: [
      {
        type: "funded",
        signature: funding.signature,
        slot: funding.slot,
        buyer: message.buyer,
        amount: message.amount,
      },
    ],
  };

  state.worker = worker;
  state.status = "Claimed";
  state.events.push({
    type: "claimed",
    signature: deriveSignature("claim", [state.task_pda, worker]),
    slot: 2,
    worker,
  });

  const attestation = verifyCompiledTask(input.compiled, input.submission, input.inputs, input.ledger);
  state.result_hash = taskHashToBytes32(attestation.result_hash);
  state.status = attestation.verdict === "pass" ? "Passed" : "Failed";
  state.events.push({
    type: "attested",
    signature: deriveSignature("attest", [state.task_pda, state.verifier, state.result_hash]),
    slot: 3,
    verifier: state.verifier,
    result_hash: state.result_hash,
    verdict: attestation.verdict,
  });

  if (state.status === "Passed") {
    state.status = "Released";
    state.token_accounts.vault = "0";
    state.token_accounts.worker = state.amount;
    state.events.push({
      type: "released",
      signature: deriveSignature("release", [state.task_pda, state.worker, state.amount]),
      slot: 4,
      worker: state.worker,
      amount: state.amount,
    });
  }

  return {
    ok: true,
    signed: input.signed,
    funding,
    state,
    attestation,
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function demo(taskFile, submissionFile, options = {}) {
  const buyerKeypair = fixtureKeypair("buyer");
  const workerKeypair = fixtureKeypair("worker");
  const verifierKeypair = fixtureKeypair("verifier");
  const { intent, compiled } = createSolanaIntent(taskFile, {
    buyer: buyerKeypair.address,
    verifier: verifierKeypair.address,
    now: options.now,
    nonce: options.nonce,
    decimals: options.decimals,
  });
  const signed = signSolanaIntent(intent, buyerKeypair);
  const result = simulateSettlement({
    signed,
    compiled,
    worker: workerKeypair.address,
    submission: fs.readFileSync(submissionFile, "utf8"),
    inputs: EXAMPLE_INPUTS,
    ledger: EXAMPLE_LEDGER,
  });

  if (options.outDir) {
    writeJson(path.join(options.outDir, "summarize_url.intent.json"), intent);
    writeJson(path.join(options.outDir, "summarize_url.signature.json"), signed);
    writeJson(path.join(options.outDir, "summarize_url.funding.json"), result.funding);
    writeJson(path.join(options.outDir, "summarize_url.settlement.json"), result.state);
    writeJson(path.join(options.outDir, "funded.batch.json"), {
      kind: "tasc.funding.batch.solana",
      version: "0.1",
      entries: [result.funding],
    });
  }

  return {
    ok: true,
    out_dir: options.outDir || null,
    intent,
    signed,
    funding: result.funding,
    settlement: result.state,
    attestation: result.attestation,
  };
}

function main() {
  const [command, first, second, ...rest] = process.argv.slice(2);
  if (command === "demo") {
    if (!first || !second) usage();
    process.stdout.write(`${JSON.stringify(demo(first, second, parseOptions(rest)), null, 2)}\n`);
    return;
  }

  if (command === "validate-signature") {
    if (!first) usage();
    const result = verifySignedSolanaIntent(JSON.parse(fs.readFileSync(first, "utf8")));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  usage();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`tascsolana: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildFundingEvidence,
  createSolanaIntent,
  demo,
  deriveAddress,
  fixtureKeypair,
  signSolanaIntent,
  simulateSettlement,
  createWithSeedAddress,
  taskPda,
  seededTaskAddress,
  seededTaskSeed,
  seededVaultAddress,
  seededVaultSeed,
  vaultPda,
  verifySignedSolanaIntent,
};
