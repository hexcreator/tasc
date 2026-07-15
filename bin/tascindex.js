#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { verifySignedIntent } = require("./tascsign");
const { verifySignedSolanaIntent } = require("./tascsolana");
const { base58Decode } = require("./run-solana-devnet");
const { TOKEN_PROGRAM_ID } = require("./tascsolana-spl");

function usage() {
  console.error([
    "Usage:",
    "  node bin/tascindex.js admit <signed-intent.json> <funding.json> [--out index.json]",
    "  node bin/tascindex.js admit-batch <signed-intent-dir-or-file> <funding-batch.json> [--out index.json]",
    "  node bin/tascindex.js reject-check <signed-intent.json> <funding.json>",
  ].join("\n"));
  process.exit(1);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadInput(value, inlineKey) {
  if (typeof value === "string") return loadJson(value);
  if (value && value[inlineKey]) return value[inlineKey];
  return value;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sameAddress(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function sameValue(a, b) {
  return String(a || "") === String(b || "");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateEvmFundingEvidence(funding) {
  assert(funding.kind === "tasc.funding.evm", "funding kind must be tasc.funding.evm");
  assert(funding.status === "Funded", "funding status must be Funded");
  assert(/^\d+$/.test(String(funding.chain_id)), "funding chain_id must be numeric");
  assert(/^0x[a-fA-F0-9]{64}$/.test(String(funding.task_hash)), "funding task_hash must be bytes32 hex");
  assert(/^0x[a-fA-F0-9]{40}$/.test(String(funding.escrow)), "funding escrow must be address hex");
  assert(/^0x[a-fA-F0-9]{40}$/.test(String(funding.buyer)), "funding buyer must be address hex");
  assert(/^0x[a-fA-F0-9]{40}$/.test(String(funding.token)), "funding token must be address hex");
  assert(/^\d+$/.test(String(funding.amount)), "funding amount must be integer string");
  assert(/^\d+$/.test(String(funding.deadline)), "funding deadline must be integer string");
  assert(/^0x[a-fA-F0-9]{64}$/.test(String(funding.tx_hash)), "funding tx_hash must be bytes32 hex");
  assert(/^\d+$/.test(String(funding.block_number)), "funding block_number must be integer string");
  assert(/^\d+$/.test(String(funding.log_index)), "funding log_index must be integer string");
}

function validateSolanaAddress(value, label) {
  assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value || "")), `${label} must be Solana base58 address`);
  assert(base58Decode(value).length === 32, `${label} must decode to 32 bytes`);
}

function validateSolanaSignature(value, label) {
  assert(/^[1-9A-HJ-NP-Za-km-z]+$/.test(String(value || "")), `${label} must be base58`);
  assert(base58Decode(value).length === 64, `${label} must decode to 64 bytes`);
}

function validateSolanaFundingEvidence(funding) {
  assert(funding.kind === "tasc.funding.solana", "funding kind must be tasc.funding.solana");
  assert(funding.status === "Funded", "funding status must be Funded");
  assert(funding.cluster === "devnet" || funding.cluster === "testnet" || funding.cluster === "mainnet-beta", "funding cluster is invalid");
  assert(/^0x[a-fA-F0-9]{64}$/.test(String(funding.task_hash)), "funding task_hash must be bytes32 hex");
  validateSolanaAddress(funding.program_id, "funding program_id");
  validateSolanaAddress(funding.task_pda, "funding task_pda");
  validateSolanaAddress(funding.vault, "funding vault");
  validateSolanaAddress(funding.buyer, "funding buyer");
  validateSolanaAddress(funding.token_mint, "funding token_mint");
  validateSolanaAddress(funding.verifier, "funding verifier");
  assert(/^\d+$/.test(String(funding.amount)), "funding amount must be integer string");
  assert(/^\d+$/.test(String(funding.deadline_unix)), "funding deadline_unix must be integer string");
  validateSolanaSignature(funding.signature, "funding signature");
  assert(/^\d+$/.test(String(funding.slot)), "funding slot must be integer string");
  assert(/^\d+$/.test(String(funding.instruction_index)), "funding instruction_index must be integer string");
  assert(funding.confirmation_status === "confirmed" || funding.confirmation_status === "finalized", "funding confirmation_status must be confirmed or finalized");
}

function validateSolanaCustodyEvidence(custody) {
  assert(custody.kind === "tasc.custody.solana.spl_token", "custody kind must be tasc.custody.solana.spl_token");
  validateSolanaAddress(custody.token_program_id, "custody token_program_id");
  assert(custody.token_program_id === TOKEN_PROGRAM_ID, "custody token_program_id must be SPL Token Program");
  validateSolanaAddress(custody.vault_token_account, "custody vault_token_account");
  validateSolanaAddress(custody.vault_authority, "custody vault_authority");
  validateSolanaAddress(custody.token_mint, "custody token_mint");
  assert(/^\d+$/.test(String(custody.amount)), "custody amount must be integer string");
  assert(/^\d+$/.test(String(custody.required_amount)), "custody required_amount must be integer string");
  assert(Number.isInteger(Number(custody.decimals)) && Number(custody.decimals) >= 0 && Number(custody.decimals) <= 255, "custody decimals must be u8");
  if (custody.transfer_signature) validateSolanaSignature(custody.transfer_signature, "custody transfer_signature");
  if (custody.slot !== null && custody.slot !== undefined) assert(/^\d+$/.test(String(custody.slot)), "custody slot must be integer string");
  if (custody.instruction_index !== null && custody.instruction_index !== undefined) assert(/^\d+$/.test(String(custody.instruction_index)), "custody instruction_index must be integer string");
  if (custody.confirmation_status !== null && custody.confirmation_status !== undefined) {
    assert(custody.confirmation_status === "confirmed" || custody.confirmation_status === "finalized", "custody confirmation_status must be confirmed or finalized");
  }
}

function compareEvmFundingToIntent(signed, funding) {
  const signatureCheck = verifySignedIntent(signed);
  assert(signatureCheck.ok, "signed intent signature is invalid");

  validateEvmFundingEvidence(funding);
  const message = signed.typed_data.message;
  const domain = signed.typed_data.domain;

  const checks = [
    ["chain_id", Number(funding.chain_id) === Number(domain.chainId)],
    ["task_hash", String(funding.task_hash).toLowerCase() === String(message.taskHash).toLowerCase()],
    ["escrow", sameAddress(funding.escrow, message.escrow)],
    ["escrow_domain", sameAddress(funding.escrow, domain.verifyingContract)],
    ["buyer", sameAddress(funding.buyer, message.buyer)],
    ["token", sameAddress(funding.token, message.token)],
    ["amount", String(funding.amount) === String(message.amount)],
    ["deadline", String(funding.deadline) === String(message.deadline)],
  ];

  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`Funding evidence does not match signed intent: ${failed.join(", ")}`);
  }

  return {
    signatureCheck,
    checks: checks.map(([name, pass]) => ({ name, pass })),
  };
}

function compareSolanaFundingToIntent(signed, funding) {
  const signatureCheck = verifySignedSolanaIntent(signed);
  assert(signatureCheck.ok, "signed intent signature is invalid");

  validateSolanaFundingEvidence(funding);
  if (funding.custody) validateSolanaCustodyEvidence(funding.custody);
  const message = signed.intent.message;

  const checks = [
    ["cluster", sameValue(funding.cluster, message.cluster)],
    ["task_hash", String(funding.task_hash).toLowerCase() === String(message.task_hash).toLowerCase()],
    ["program_id", sameValue(funding.program_id, message.program_id)],
    ["buyer", sameValue(funding.buyer, message.buyer)],
    ["token_mint", sameValue(funding.token_mint, message.token_mint)],
    ["amount", sameValue(funding.amount, message.amount)],
    ["deadline_unix", sameValue(funding.deadline_unix, message.deadline_unix)],
    ["verifier", sameValue(funding.verifier, message.verifier)],
  ];
  if (funding.custody) {
    checks.push(
      ["custody_vault", sameValue(funding.custody.vault_token_account, funding.vault)],
      ["custody_token_mint", sameValue(funding.custody.token_mint, message.token_mint)],
      ["custody_required_amount", sameValue(funding.custody.required_amount, message.amount)],
      ["custody_amount", BigInt(funding.custody.amount) >= BigInt(message.amount)],
    );
  }

  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`Funding evidence does not match signed intent: ${failed.join(", ")}`);
  }

  return {
    signatureCheck,
    checks: checks.map(([name, pass]) => ({ name, pass })),
  };
}

function compareFundingToIntent(signed, funding) {
  if (signed.kind === "tasc.intent.signature.eip712") {
    return compareEvmFundingToIntent(signed, funding);
  }
  if (signed.kind === "tasc.intent.signature.solana") {
    return compareSolanaFundingToIntent(signed, funding);
  }
  throw new Error(`Unsupported signed intent kind: ${signed.kind}`);
}

function buildEvmEntry(signed, funding, validation) {
  const message = signed.typed_data.message;
  return {
    kind: "tasc.index.entry",
    version: "0.1",
    status: "claimable",
    admitted_at: new Date(0).toISOString(),
    intent_hash: signed.intent_hash,
    task_hash: message.taskHash,
    chain_id: Number(signed.typed_data.domain.chainId),
    escrow: message.escrow,
    buyer: message.buyer,
    token: message.token,
    amount: message.amount,
    deadline: message.deadline,
    verifier: message.verifier,
    nonce: message.nonce,
    funding: {
      tx_hash: funding.tx_hash,
      block_number: funding.block_number,
      log_index: funding.log_index,
      status: funding.status,
    },
    signature: {
      recovered: validation.signatureCheck.recovered,
      valid: validation.signatureCheck.ok,
    },
  };
}

function buildSolanaEntry(signed, funding, validation) {
  const message = signed.intent.message;
  const fundingEntry = {
    kind: funding.kind,
    signature: funding.signature,
    slot: funding.slot,
    instruction_index: funding.instruction_index,
    status: funding.status,
    confirmation_status: funding.confirmation_status,
  };
  if (funding.custody) {
    fundingEntry.custody = {
      kind: funding.custody.kind,
      token_program_id: funding.custody.token_program_id,
      vault_token_account: funding.custody.vault_token_account,
      vault_authority: funding.custody.vault_authority,
      token_mint: funding.custody.token_mint,
      amount: funding.custody.amount,
      required_amount: funding.custody.required_amount,
      decimals: funding.custody.decimals,
      transfer_signature: funding.custody.transfer_signature,
      slot: funding.custody.slot,
      instruction_index: funding.custody.instruction_index,
      confirmation_status: funding.custody.confirmation_status,
    };
  }
  return {
    kind: "tasc.index.entry",
    version: "0.1",
    status: "claimable",
    admitted_at: new Date(0).toISOString(),
    intent_hash: signed.intent_hash,
    task_hash: message.task_hash,
    settlement: {
      chain: "solana",
      cluster: message.cluster,
      program_id: message.program_id,
      task_pda: funding.task_pda,
      vault: funding.vault,
    },
    buyer: message.buyer,
    token_mint: message.token_mint,
    amount: message.amount,
    deadline_unix: message.deadline_unix,
    verifier: message.verifier,
    nonce: message.nonce,
    funding: fundingEntry,
    signature: {
      signer: validation.signatureCheck.signer,
      valid: validation.signatureCheck.ok,
    },
  };
}

function buildEntry(signed, funding, validation) {
  if (signed.kind === "tasc.intent.signature.eip712") return buildEvmEntry(signed, funding, validation);
  if (signed.kind === "tasc.intent.signature.solana") return buildSolanaEntry(signed, funding, validation);
  throw new Error(`Unsupported signed intent kind: ${signed.kind}`);
}

function buildIndex(entries, rejectedEntries = []) {
  const index = {
    kind: "tasc.index",
    version: "0.1",
    entries,
  };
  if (rejectedEntries.length > 0) index.rejected_entries = rejectedEntries;
  return index;
}

function writeIndex(outFile, entry) {
  const index = buildIndex([entry]);
  writeJson(outFile, index);
  return index;
}

function admit(signedFile, fundingFile, outFile) {
  const signed = loadInput(signedFile, "inlineSigned");
  const funding = loadInput(fundingFile, "inlineFunding");
  const validation = compareFundingToIntent(signed, funding);
  const entry = buildEntry(signed, funding, validation);
  const result = {
    ok: true,
    entry,
    validation,
  };
  if (outFile) {
    result.index = writeIndex(outFile, entry);
    result.out = outFile;
  }
  return result;
}

function signedFilesFromPath(signedPath) {
  const stat = fs.statSync(signedPath);
  if (stat.isFile()) return [signedPath];
  assert(stat.isDirectory(), "signed intent path must be a file or directory");
  return fs.readdirSync(signedPath)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(signedPath, name));
}

function signedCatalog(signedPath) {
  const byTaskHash = new Map();
  const files = signedFilesFromPath(signedPath);
  assert(files.length > 0, "signed intent catalog is empty");

  for (const file of files) {
    const signed = loadJson(file);
    assert(signed.kind === "tasc.intent.signature.eip712" || signed.kind === "tasc.intent.signature.solana", `${file} is not a supported signed intent`);
    const taskHash = signedTaskHash(signed);
    const key = String(taskHash).toLowerCase();
    assert(!byTaskHash.has(key), `duplicate signed intent for task hash ${key}`);
    byTaskHash.set(key, { file, signed });
  }

  return byTaskHash;
}

function signedTaskHash(signed) {
  if (signed.kind === "tasc.intent.signature.eip712") {
    const message = signed.typed_data && signed.typed_data.message;
    assert(message && /^0x[a-fA-F0-9]{64}$/.test(String(message.taskHash)), "signed EVM intent missing taskHash");
    return message.taskHash;
  }
  if (signed.kind === "tasc.intent.signature.solana") {
    const message = signed.intent && signed.intent.message;
    assert(message && /^0x[a-fA-F0-9]{64}$/.test(String(message.task_hash)), "signed Solana intent missing task_hash");
    return message.task_hash;
  }
  throw new Error(`Unsupported signed intent kind: ${signed.kind}`);
}

function validateFundingBatch(batch) {
  assert(batch.kind === "tasc.funding.batch.evm" || batch.kind === "tasc.funding.batch.solana", "funding batch kind must be tasc.funding.batch.evm or tasc.funding.batch.solana");
  assert(Array.isArray(batch.entries), "funding batch entries must be an array");
}

function buildRejectedFunding(funding, reason) {
  return {
    kind: "tasc.index.rejected",
    version: "0.1",
    task_hash: funding && funding.task_hash ? String(funding.task_hash).toLowerCase() : null,
    funding_tx: funding && funding.tx_hash ? String(funding.tx_hash).toLowerCase() : null,
    block_number: funding && funding.block_number !== undefined ? funding.block_number : null,
    log_index: funding && funding.log_index !== undefined ? funding.log_index : null,
    reason,
  };
}

function admitBatch(signedPath, fundingBatchFile, outFile) {
  const catalog = signedCatalog(signedPath);
  const batch = typeof fundingBatchFile === "string" ? loadJson(fundingBatchFile) : fundingBatchFile;
  validateFundingBatch(batch);

  const entries = [];
  const rejectedEntries = [];

  for (const funding of batch.entries) {
    const taskHash = String(funding.task_hash || "").toLowerCase();
    const signedRecord = catalog.get(taskHash);
    if (!signedRecord) {
      rejectedEntries.push(buildRejectedFunding(funding, "missing signed intent"));
      continue;
    }

    try {
      const validation = compareFundingToIntent(signedRecord.signed, funding);
      const entry = buildEntry(signedRecord.signed, funding, validation);
      entry.catalog = { signed_intent: signedRecord.file };
      entries.push(entry);
    } catch (error) {
      rejectedEntries.push(buildRejectedFunding(funding, error.message));
    }
  }

  const index = buildIndex(entries, rejectedEntries);
  const result = {
    ok: true,
    signed_catalog: signedPath,
    funding_batch: typeof fundingBatchFile === "string" ? fundingBatchFile : "(inline)",
    admitted: entries.length,
    rejected: rejectedEntries.length,
    index,
  };
  if (outFile) {
    writeJson(outFile, index);
    result.out = outFile;
  }
  return result;
}

function main() {
  const [command, signedFile, fundingFile, ...rest] = process.argv.slice(2);
  if (!command || !signedFile || !fundingFile) usage();

  let outFile = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--out") outFile = rest[++i];
    else usage();
  }

  try {
    if (command === "admit") {
      process.stdout.write(`${JSON.stringify(admit(signedFile, fundingFile, outFile), null, 2)}\n`);
      return;
    }

    if (command === "admit-batch") {
      process.stdout.write(`${JSON.stringify(admitBatch(signedFile, fundingFile, outFile), null, 2)}\n`);
      return;
    }

    if (command === "reject-check") {
      try {
        admit(signedFile, fundingFile, outFile);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({
          ok: true,
          rejected: true,
          reason: error.message,
        }, null, 2)}\n`);
        return;
      }
      throw new Error("Funding fixture was unexpectedly admitted");
    }

    usage();
  } catch (error) {
    throw error;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`tascindex: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  admit,
  admitBatch,
  compareFundingToIntent,
};
