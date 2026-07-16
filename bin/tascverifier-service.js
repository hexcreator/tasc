#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { canonicalize } = require("./tasclang");
const { readLedger, sha256, verifyCompiledTaskWithLedger } = require("./tascverify");

function usage() {
  console.error([
    "Usage:",
    "  node bin/tascverifier-service.js ingest <worker-submission.json> --entry <index-or-entry.json> [--ledger ledger.json] [--out file] [--received-at iso]",
    "",
    "The trusted entry supplies the verifier rules and task inputs. The worker submission supplies only the output artifact.",
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

function parseArgs(argv) {
  const [command, submissionFile, ...rest] = argv;
  if (command !== "ingest" || !submissionFile) usage();
  const options = {
    entryFile: null,
    ledgerFile: null,
    out: null,
    receivedAt: null,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--entry") {
      options.entryFile = rest[++i];
      if (!options.entryFile) usage();
    } else if (arg === "--ledger") {
      options.ledgerFile = rest[++i];
      if (!options.ledgerFile) usage();
    } else if (arg === "--out") {
      options.out = rest[++i];
      if (!options.out) usage();
    } else if (arg === "--received-at") {
      options.receivedAt = rest[++i];
      if (!options.receivedAt) usage();
    } else {
      usage();
    }
  }

  if (!options.entryFile) usage();
  return { submissionFile, options };
}

function hashHex(value, label) {
  const raw = String(value || "").toLowerCase();
  const hex = raw.startsWith("sha256:") ? raw.slice("sha256:".length) : raw.startsWith("0x") ? raw.slice(2) : "";
  assert(/^[a-f0-9]{64}$/.test(hex), `${label} must be sha256:<hex> or 0x<hex>`);
  return hex;
}

function hashToBytes32(value, label) {
  return `0x${hashHex(value, label)}`;
}

function hashesMatch(a, b, label) {
  assert(hashHex(a, `${label} left`) === hashHex(b, `${label} right`), `${label} mismatch`);
}

function sameOptionalValue(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return true;
  return String(a) === String(b);
}

function entriesFromTrustedContext(context) {
  if (Array.isArray(context)) return context;
  if (context && Array.isArray(context.entries)) return context.entries;
  if (context && context.kind === "tasc.index.entry") return [context];
  if (context && context.entry && context.entry.kind === "tasc.index.entry") return [context.entry];
  throw new Error("trusted entry file must be a tasc.index, tasc.index.entry, or entry array");
}

function entryMatchesSubmission(entry, submission) {
  try {
    hashesMatch(entry.task_hash, submission.task_hash, "task_hash");
  } catch {
    return false;
  }
  const proofTaskPda = submission.settlement && submission.settlement.task_pda;
  if (proofTaskPda && entry.settlement && entry.settlement.task_pda) {
    return proofTaskPda === entry.settlement.task_pda;
  }
  return true;
}

function findTrustedEntry(context, submission) {
  const entries = entriesFromTrustedContext(context);
  const matches = entries.filter((entry) => entryMatchesSubmission(entry, submission));
  if (matches.length === 0) throw new Error("no trusted entry matches worker submission");
  if (matches.length > 1) throw new Error("multiple trusted entries match worker submission");
  return matches[0];
}

function validateWorkerSubmission(submission) {
  assert(submission && typeof submission === "object", "worker submission must be an object");
  assert(submission.kind === "tasc.worker.submission", "worker submission kind must be tasc.worker.submission");
  assert(submission.version === "0.1", "worker submission version must be 0.1");
  assert(submission.task_hash, "worker submission missing task_hash");
  assert(submission.output && typeof submission.output.markdown === "string", "worker submission missing output.markdown");
  assert(submission.output.markdown.trim().length > 0, "worker submission markdown is empty");
  assert(/^sha256:[a-fA-F0-9]{64}$/.test(String(submission.result_hash || "")), "worker submission result_hash must be sha256:<hex>");
  if (submission.result_hash_bytes32) hashesMatch(submission.result_hash, submission.result_hash_bytes32, "worker result_hash_bytes32");
}

function validateTrustedEntry(entry) {
  assert(entry && entry.kind === "tasc.index.entry", "trusted context must resolve to tasc.index.entry");
  assert(entry.task_hash, "trusted entry missing task_hash");
  assert(entry.task && Array.isArray(entry.task.verify), "trusted entry missing verifier rules");
  assert(entry.inputs && typeof entry.inputs === "object", "trusted entry missing inputs");
}

function validateSubmissionAgainstEntry(submission, entry) {
  hashesMatch(submission.task_hash, entry.task_hash, "task_hash");
  if (submission.input_hash && entry.input_hash) hashesMatch(submission.input_hash, entry.input_hash, "input_hash");
  assert(canonicalize(submission.inputs || {}) === canonicalize(entry.inputs || {}), "worker submission inputs do not match trusted entry");
  assert(sameOptionalValue(submission.intent_hash, entry.intent_hash), "worker submission intent_hash does not match trusted entry");
  assert(sameOptionalValue(submission.verifier, entry.verifier), "worker submission verifier does not match trusted entry");

  const proofSettlement = submission.settlement || {};
  const trustedSettlement = entry.settlement || {};
  for (const field of ["chain", "cluster", "program_id", "task_pda"]) {
    assert(sameOptionalValue(proofSettlement[field], trustedSettlement[field]), `worker submission settlement.${field} does not match trusted entry`);
  }
}

function signatureSummary(submission) {
  if (!submission.signature) return { present: false };
  return {
    present: true,
    scheme: submission.signature.scheme || null,
    signer: submission.signature.signer || null,
    message_hash: submission.signature.message_hash || null,
  };
}

function ingestWorkerSubmissionProof(submission, trustedContext, options = {}) {
  validateWorkerSubmission(submission);
  const trustedEntry = findTrustedEntry(trustedContext, submission);
  validateTrustedEntry(trustedEntry);
  validateSubmissionAgainstEntry(submission, trustedEntry);

  const markdown = submission.output.markdown;
  const calculatedResultHash = `sha256:${sha256(markdown)}`;
  assert(calculatedResultHash === String(submission.result_hash).toLowerCase(), "worker submission result_hash does not match output.markdown");

  const ledger = options.ledger || readLedger(options.ledgerFile);
  const attestation = verifyCompiledTaskWithLedger(
    {
      task: trustedEntry.task,
      task_hash: trustedEntry.task_hash,
    },
    markdown,
    trustedEntry.inputs,
    ledger,
  );
  assert(attestation.result_hash === calculatedResultHash, "attestation result_hash does not match worker submission");

  const resultHashBytes32 = hashToBytes32(attestation.result_hash, "attestation.result_hash");
  const accepted = attestation.verdict === "pass";
  const settlement = trustedEntry.settlement || {};

  return {
    kind: "tasc.verifier.ingestion",
    version: "0.1",
    accepted,
    received_at: options.receivedAt || new Date().toISOString(),
    worker_submission_hash: `sha256:${sha256(canonicalize(submission))}`,
    worker_submission: {
      task_hash: submission.task_hash,
      input_hash: submission.input_hash || null,
      worker: submission.worker || null,
      submitted_at: submission.submitted_at || null,
      signature: signatureSummary(submission),
    },
    trusted_context: {
      source: options.entryFile || null,
      status: trustedEntry.status || null,
      task_hash: trustedEntry.task_hash,
      input_hash: trustedEntry.input_hash || null,
      intent_hash: trustedEntry.intent_hash || null,
      verifier: trustedEntry.verifier || null,
    },
    attestation,
    settlement: {
      chain: settlement.chain || null,
      cluster: settlement.cluster || null,
      program_id: settlement.program_id || null,
      task_pda: settlement.task_pda || null,
      attest: {
        verifier: trustedEntry.verifier || null,
        verdict: attestation.verdict,
        result_hash: attestation.result_hash,
        result_hash_bytes32: resultHashBytes32,
        next_action: "attest",
      },
    },
    checks: [
      { name: "trusted_entry_match", pass: true },
      { name: "output_hash_recomputed", pass: true, expected: calculatedResultHash, actual: submission.result_hash },
      { name: "verifier_rules_executed", pass: true, count: attestation.checks.length },
    ],
  };
}

function ingestFile(submissionFile, options) {
  const submission = loadJson(submissionFile);
  const trustedContext = loadJson(options.entryFile);
  return ingestWorkerSubmissionProof(submission, trustedContext, options);
}

function main() {
  const { submissionFile, options } = parseArgs(process.argv.slice(2));
  const result = ingestFile(submissionFile, options);
  if (options.out) writeJson(options.out, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.accepted) process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`tascverifier-service: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  entriesFromTrustedContext,
  findTrustedEntry,
  hashToBytes32,
  ingestFile,
  ingestWorkerSubmissionProof,
};
