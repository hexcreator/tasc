#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const core = require("../web/tasc-web-core");
const { ingestWorkerSubmissionProof } = require("./tascverifier-service");

const SUBMISSION = "examples/submissions/summarize_url.pass.md";
const TRUSTED_INDEX = "examples/index/solana.spl.live.index.json";
const WORKER_PROOF_OUT = "examples/submissions/summarize_url_spl.worker-submission.json";
const INGEST_OUT = "examples/attestations/summarize_url_spl.verifier-ingestion.json";
const EXPECTED_RESULT_HASH = "sha256:0bdfacb7e0ec2c3241da82c7b812b1a0fa28945b47c7f8a6b113b4de3779776f";
const RECEIVED_AT = "2026-01-01T00:00:01.000Z";
const SUBMITTED_AT = "2026-01-01T00:00:00.000Z";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function expectReject(label, fn, pattern) {
  try {
    fn();
  } catch (error) {
    if (pattern) assert(pattern.test(error.message), `${label} rejected for wrong reason: ${error.message}`);
    return error.message;
  }
  throw new Error(`${label} should have been rejected`);
}

async function main() {
  const trustedIndex = JSON.parse(fs.readFileSync(TRUSTED_INDEX, "utf8"));
  const entry = trustedIndex.entries[0];
  const markdown = fs.readFileSync(SUBMISSION, "utf8");
  const workerSubmission = await core.buildWorkerSubmission({
    entry,
    markdown,
    workerAddress: "BfRmLmH7ksPRCRxNBi7c8SspN7zKoyuAPKrJMDL5uQCJ",
    submittedAt: SUBMITTED_AT,
  });

  const ingestion = ingestWorkerSubmissionProof(workerSubmission, trustedIndex, {
    ledger: [],
    receivedAt: RECEIVED_AT,
    entryFile: TRUSTED_INDEX,
  });

  assert(ingestion.kind === "tasc.verifier.ingestion", "ingestion kind mismatch");
  assert(ingestion.accepted === true, "ingestion should be accepted");
  assert(ingestion.attestation.kind === "tasc.attestation", "attestation kind mismatch");
  assert(ingestion.attestation.verdict === "pass", "attestation verdict mismatch");
  assert(ingestion.attestation.task_hash === entry.task_hash, "attestation task_hash mismatch");
  assert(ingestion.attestation.result_hash === EXPECTED_RESULT_HASH, "attestation result_hash mismatch");
  assert(ingestion.settlement.attest.result_hash === EXPECTED_RESULT_HASH, "settlement result_hash mismatch");
  assert(ingestion.settlement.attest.result_hash_bytes32 === `0x${EXPECTED_RESULT_HASH.slice("sha256:".length)}`, "settlement bytes32 hash mismatch");
  assert(ingestion.settlement.attest.verdict === "pass", "settlement verdict mismatch");
  assert(ingestion.settlement.task_pda === entry.settlement.task_pda, "settlement task_pda mismatch");
  assert(ingestion.checks.every((check) => check.pass === true), "ingestion checks should pass");

  const duplicate = ingestWorkerSubmissionProof(workerSubmission, trustedIndex, {
    ledger: [EXPECTED_RESULT_HASH],
    receivedAt: RECEIVED_AT,
  });
  assert(duplicate.accepted === false, "duplicate ingestion should not be accepted");
  assert(duplicate.attestation.verdict === "fail", "duplicate ingestion should fail attestation");
  assert(duplicate.attestation.checks.some((check) => check.rule.op === "no_duplicate" && check.pass === false), "duplicate check mismatch");

  const tamperedHash = {
    ...workerSubmission,
    result_hash: `sha256:${"11".repeat(32)}`,
    result_hash_bytes32: `0x${"11".repeat(32)}`,
  };
  const rejectedHash = expectReject("tampered result hash", () => ingestWorkerSubmissionProof(tamperedHash, trustedIndex), /result_hash/);

  const tamperedTask = {
    ...workerSubmission,
    task_hash: `0x${"22".repeat(32)}`,
  };
  const rejectedTask = expectReject("tampered task hash", () => ingestWorkerSubmissionProof(tamperedTask, trustedIndex), /trusted entry|task_hash/);

  const tamperedInputs = {
    ...workerSubmission,
    inputs: { url: "https://example.invalid/not-the-task" },
  };
  const rejectedInputs = expectReject("tampered inputs", () => ingestWorkerSubmissionProof(tamperedInputs, trustedIndex), /inputs/);

  writeJson(WORKER_PROOF_OUT, workerSubmission);
  writeJson(INGEST_OUT, ingestion);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    worker_submission: WORKER_PROOF_OUT,
    verifier_ingestion: INGEST_OUT,
    attestation: {
      verdict: ingestion.attestation.verdict,
      result_hash: ingestion.attestation.result_hash,
      result_hash_bytes32: ingestion.settlement.attest.result_hash_bytes32,
    },
    rejected: {
      duplicate: duplicate.attestation.checks.find((check) => check.rule.op === "no_duplicate").actual,
      tampered_hash: rejectedHash,
      tampered_task: rejectedTask,
      tampered_inputs: rejectedInputs,
    },
    no_new_dependencies: true,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`validate-verifier-ingest: ${error.message}`);
    process.exit(1);
  });
}
