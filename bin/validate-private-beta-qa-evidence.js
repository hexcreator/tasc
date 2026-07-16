#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const core = require("../web/tasc-web-core");

const DEFAULT_EVIDENCE = "examples/private-beta/qa-evidence.example.json";
const DEFAULT_LIVE_ACCOUNT = "examples/solana-devnet/summarize_url_spl.lifecycle-account.live.json";
const ACTIONS = new Set(["claim", "attest", "release", "refund", "timeout-refund"]);
const HASH_RE = /^(0x[a-fA-F0-9]{64}|sha256:[a-fA-F0-9]{64})$/;
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/;
const CONFIRMATION_ORDER = {
  processed: 0,
  confirmed: 1,
  finalized: 2,
};

function usage() {
  console.error([
    "Usage:",
    "  node bin/validate-private-beta-qa-evidence.js [evidence.json] [options]",
    "",
    "Options:",
    "  --require-wallet-send          require at least one wallet transaction signature",
    "  --require-verifier-ingestion   require at least one accepted verifier ingestion",
    "  --require-worker-submission    require at least one worker submission proof",
    "  --require-live-account         require at least one live Solana account snapshot",
    "  --solana-rpc-url <url>         verify wallet signatures and task accounts against Solana RPC",
    "  --min-confirmation <status>    processed, confirmed, or finalized; default confirmed",
    "  --allow-empty-feed             do not require exported task entries",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseArgs(argv) {
  const options = {
    file: DEFAULT_EVIDENCE,
    requireWalletSend: false,
    requireVerifierIngestion: false,
    requireWorkerSubmission: false,
    requireLiveAccount: false,
    allowEmptyFeed: false,
    selfTest: false,
    solanaRpcUrl: "",
    minConfirmation: "confirmed",
  };
  let fileSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--require-wallet-send") options.requireWalletSend = true;
    else if (arg === "--require-verifier-ingestion") options.requireVerifierIngestion = true;
    else if (arg === "--require-worker-submission") options.requireWorkerSubmission = true;
    else if (arg === "--require-live-account") options.requireLiveAccount = true;
    else if (arg === "--allow-empty-feed") options.allowEmptyFeed = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--solana-rpc-url") {
      options.solanaRpcUrl = argv[++i] || "";
      if (!options.solanaRpcUrl) usage();
    } else if (arg === "--min-confirmation") {
      options.minConfirmation = argv[++i] || "";
      if (!Object.prototype.hasOwnProperty.call(CONFIRMATION_ORDER, options.minConfirmation)) usage();
    }
    else if (arg === "--help" || arg === "-h") usage();
    else if (!fileSeen) {
      options.file = arg;
      fileSeen = true;
    } else {
      usage();
    }
  }
  return options;
}

function objectValues(record) {
  return record && typeof record === "object" && !Array.isArray(record) ? Object.values(record) : [];
}

function objectKeys(record) {
  return record && typeof record === "object" && !Array.isArray(record) ? Object.keys(record) : [];
}

function assertIsoDate(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} is required`);
  const time = Date.parse(value);
  assert(Number.isFinite(time), `${label} must be an ISO timestamp`);
}

function assertHash(value, label) {
  assert(typeof value === "string" && HASH_RE.test(value), `${label} must be a 32-byte hash`);
}

function assertBytes32(value, label) {
  assert(typeof value === "string" && BYTES32_RE.test(value), `${label} must be 0x-prefixed bytes32`);
}

function assertString(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} is required`);
}

function assertOptionalHttpUrl(value, label) {
  if (!value) return;
  assert(typeof value === "string", `${label} must be a string`);
  const url = new URL(value);
  assert(url.protocol === "http:" || url.protocol === "https:", `${label} must be http(s)`);
}

function assertCount(payload, key, expected) {
  assert(payload.counts && Number.isSafeInteger(payload.counts[key]), `counts.${key} is required`);
  assert(payload.counts[key] === expected, `counts.${key} expected ${expected}, got ${payload.counts[key]}`);
}

function assertVerifierRedaction(payload) {
  assert(Array.isArray(payload.redactions), "redactions must be an array");
  assert(payload.redactions.includes("verifier.token"), "redactions must include verifier.token");
  const verifier = payload.verifier || {};
  assertOptionalHttpUrl(verifier.apiUrl || "", "verifier.apiUrl");
  assert(typeof verifier.token_present === "boolean", "verifier.token_present must be boolean");
  assert(verifier.token === "" || verifier.token === "<redacted>", "verifier.token must be empty or <redacted>");
  assert(!(verifier.token_present && verifier.token !== "<redacted>"), "present verifier token must be redacted");
}

function assertEntry(entry, index) {
  assert(entry && typeof entry === "object", `entries[${index}] must be an object`);
  assertHash(entry.task_hash, `entries[${index}].task_hash`);
  if (entry.input_hash) assertHash(entry.input_hash, `entries[${index}].input_hash`);
  assertString(entry.status, `entries[${index}].status`);
  const settlement = entry.settlement || {};
  assertString(settlement.chain, `entries[${index}].settlement.chain`);
  if (settlement.chain === "solana") {
    assertString(settlement.cluster, `entries[${index}].settlement.cluster`);
    assertString(settlement.program_id, `entries[${index}].settlement.program_id`);
    assertString(settlement.task_pda, `entries[${index}].settlement.task_pda`);
    assertString(settlement.vault, `entries[${index}].settlement.vault`);
  }
  if (entry.worker_submission) {
    assertHash(entry.worker_submission.result_hash, `entries[${index}].worker_submission.result_hash`);
    assertBytes32(entry.worker_submission.result_hash_bytes32, `entries[${index}].worker_submission.result_hash_bytes32`);
  }
  if (entry.verifier_ingestion) {
    assert(typeof entry.verifier_ingestion.accepted === "boolean", `entries[${index}].verifier_ingestion.accepted must be boolean`);
    assert(entry.verifier_ingestion.verdict === "pass" || entry.verifier_ingestion.verdict === "fail", `entries[${index}].verifier_ingestion.verdict must be pass or fail`);
    assertHash(entry.verifier_ingestion.result_hash, `entries[${index}].verifier_ingestion.result_hash`);
  }
  if (entry.live_account) {
    assertString(entry.live_account.status, `entries[${index}].live_account.status`);
    if (entry.live_account.result_hash) assertBytes32(entry.live_account.result_hash, `entries[${index}].live_account.result_hash`);
  }
}

function assertWalletSubmission(submission, key) {
  assert(submission && typeof submission === "object", `wallet_submissions.${key} must be an object`);
  assert(ACTIONS.has(submission.action), `wallet_submissions.${key}.action is invalid`);
  assertString(submission.signature, `wallet_submissions.${key}.signature`);
  assertString(submission.transport, `wallet_submissions.${key}.transport`);
  assertString(submission.confirmationStatus, `wallet_submissions.${key}.confirmationStatus`);
  assertIsoDate(submission.submittedAt, `wallet_submissions.${key}.submittedAt`);
}

function assertWorkerSubmission(submission, key) {
  assert(submission && typeof submission === "object", `worker_submissions.${key} must be an object`);
  assert(submission.kind === "tasc.worker.submission", `worker_submissions.${key}.kind mismatch`);
  assertHash(submission.task_hash, `worker_submissions.${key}.task_hash`);
  assertHash(submission.input_hash, `worker_submissions.${key}.input_hash`);
  assertHash(submission.result_hash, `worker_submissions.${key}.result_hash`);
  assertBytes32(submission.result_hash_bytes32, `worker_submissions.${key}.result_hash_bytes32`);
}

function assertVerifierIngestion(ingestion, key) {
  assert(ingestion && typeof ingestion === "object", `verifier_ingestions.${key} must be an object`);
  assert(ingestion.kind === "tasc.verifier.ingestion", `verifier_ingestions.${key}.kind mismatch`);
  assert(typeof ingestion.accepted === "boolean", `verifier_ingestions.${key}.accepted must be boolean`);
  const attestation = ingestion.attestation || {};
  assert(attestation.verdict === "pass" || attestation.verdict === "fail", `verifier_ingestions.${key}.attestation.verdict must be pass or fail`);
  assertHash(attestation.task_hash, `verifier_ingestions.${key}.attestation.task_hash`);
  assertHash(attestation.result_hash, `verifier_ingestions.${key}.attestation.result_hash`);
  const attest = ingestion.settlement && ingestion.settlement.attest ? ingestion.settlement.attest : {};
  assertHash(attest.result_hash, `verifier_ingestions.${key}.settlement.attest.result_hash`);
  assertBytes32(attest.result_hash_bytes32, `verifier_ingestions.${key}.settlement.attest.result_hash_bytes32`);
}

function validateEvidence(payload, options) {
  assert(payload && typeof payload === "object", "evidence must be a JSON object");
  assert(payload.kind === "tasc.private_beta.qa_evidence", "evidence kind mismatch");
  assert(payload.version === "0.1", "evidence version mismatch");
  assertIsoDate(payload.generated_at, "generated_at");
  assert(payload.app && payload.app.storage_key === "global-tasc.web.feed.v1", "app.storage_key mismatch");
  assertOptionalHttpUrl(payload.app.url || "", "app.url");
  assertVerifierRedaction(payload);

  const entries = Array.isArray(payload.entries) ? payload.entries : null;
  assert(entries, "entries must be an array");
  if (!options.allowEmptyFeed) assert(entries.length > 0, "entries must not be empty");
  entries.forEach(assertEntry);

  const walletSubmissions = payload.wallet_submissions || {};
  const workerSubmissions = payload.worker_submissions || {};
  const verifierIngestions = payload.verifier_ingestions || {};
  objectKeys(walletSubmissions).forEach((key) => assertWalletSubmission(walletSubmissions[key], key));
  objectKeys(workerSubmissions).forEach((key) => assertWorkerSubmission(workerSubmissions[key], key));
  objectKeys(verifierIngestions).forEach((key) => assertVerifierIngestion(verifierIngestions[key], key));

  assertCount(payload, "claimable_entries", entries.length);
  assertCount(payload, "worker_submissions", objectValues(workerSubmissions).length);
  assertCount(payload, "verifier_ingestions", objectValues(verifierIngestions).length);
  assertCount(payload, "wallet_submissions", objectValues(walletSubmissions).length);
  assert(payload.solana && typeof payload.solana === "object", "solana summary is required");
  assert(payload.solana.wallet_submission_count === objectValues(walletSubmissions).length, "solana.wallet_submission_count mismatch");

  const acceptedVerifierIngestions = objectValues(verifierIngestions).filter((ingestion) => ingestion.accepted === true);
  const liveAccountEntries = entries.filter((entry) => entry.live_account);
  if (options.requireWalletSend) assert(objectValues(walletSubmissions).length > 0, "wallet submission evidence is required");
  if (options.requireVerifierIngestion) assert(acceptedVerifierIngestions.length > 0, "accepted verifier ingestion evidence is required");
  if (options.requireWorkerSubmission) assert(objectValues(workerSubmissions).length > 0, "worker submission evidence is required");
  if (options.requireLiveAccount) assert(liveAccountEntries.length > 0, "live account evidence is required");

  return {
    entries: entries.length,
    walletSubmissions: objectValues(walletSubmissions).length,
    workerSubmissions: objectValues(workerSubmissions).length,
    verifierIngestions: objectValues(verifierIngestions).length,
    acceptedVerifierIngestions: acceptedVerifierIngestions.length,
    liveAccounts: liveAccountEntries.length,
  };
}

function normalizeConfirmationStatus(status) {
  if (status === "processed" || status === "confirmed" || status === "finalized") return status;
  return "";
}

function signatureStatusName(status) {
  if (!status) return "";
  const normalized = normalizeConfirmationStatus(status.confirmationStatus);
  if (normalized) return normalized;
  if (status.confirmations === null) return "finalized";
  if (Number.isInteger(status.confirmations)) return "confirmed";
  return "";
}

function assertConfirmationAtLeast(actual, minimum, label) {
  const actualStatus = signatureStatusName(actual);
  assert(actualStatus, `${label} confirmation status is missing`);
  assert(CONFIRMATION_ORDER[actualStatus] >= CONFIRMATION_ORDER[minimum], `${label} confirmation ${actualStatus} is below ${minimum}`);
}

async function defaultRpcCall(rpcUrl, method, params) {
  assert(typeof fetch === "function", "global fetch is required for Solana RPC verification");
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "Solana RPC error");
  return payload.result;
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.length > 0)));
}

async function verifySolanaSignatures(payload, options, rpcCall) {
  const walletSubmissions = objectValues(payload.wallet_submissions || {});
  const signatures = uniqueStrings(walletSubmissions.map((submission) => submission.signature));
  if (signatures.length === 0) return { checked: 0, minimum_confirmation: options.minConfirmation };
  const result = await rpcCall(options.solanaRpcUrl, "getSignatureStatuses", [
    signatures,
    { searchTransactionHistory: true },
  ]);
  const statuses = result && Array.isArray(result.value) ? result.value : [];
  assert(statuses.length === signatures.length, "Solana RPC signature status count mismatch");
  signatures.forEach((signature, index) => {
    const status = statuses[index];
    assert(status, `Solana RPC status missing for ${signature}`);
    assert(!status.err, `Solana transaction ${signature} has error ${JSON.stringify(status.err)}`);
    assertConfirmationAtLeast(status, options.minConfirmation, `Solana transaction ${signature}`);
  });
  return { checked: signatures.length, minimum_confirmation: options.minConfirmation };
}

async function verifySolanaAccounts(payload, options, rpcCall) {
  const entries = (Array.isArray(payload.entries) ? payload.entries : []).filter((entry) => {
    const settlement = entry.settlement || {};
    return settlement.chain === "solana" && settlement.task_pda;
  });
  let checked = 0;
  for (const entry of entries) {
    const settlement = entry.settlement || {};
    const result = await rpcCall(options.solanaRpcUrl, "getAccountInfo", [
      settlement.task_pda,
      {
        commitment: options.minConfirmation,
        encoding: "base64",
      },
    ]);
    const value = result && result.value;
    assert(value, `Solana task account ${settlement.task_pda} not found`);
    assert(value.owner === settlement.program_id, `Solana task account ${settlement.task_pda} owner mismatch`);
    assert(Array.isArray(value.data) && value.data[1] === "base64", `Solana task account ${settlement.task_pda} must return base64 data`);
    const decoded = core.decodeSolanaTaskAccountBase64(value.data[0], {
      programId: value.owner,
      taskPda: settlement.task_pda,
    });
    assert(decoded.task_hash === entry.task_hash, `Solana task account ${settlement.task_pda} task_hash mismatch`);
    if (entry.live_account) {
      assert(decoded.status === entry.live_account.status, `Solana task account ${settlement.task_pda} status mismatch`);
      if (entry.live_account.worker) assert(decoded.worker === entry.live_account.worker, `Solana task account ${settlement.task_pda} worker mismatch`);
      if (entry.live_account.result_hash) assert(decoded.result_hash === entry.live_account.result_hash, `Solana task account ${settlement.task_pda} result_hash mismatch`);
    }
    checked += 1;
  }
  return { checked };
}

async function verifySolanaRpcEvidence(payload, options, rpcCall = defaultRpcCall) {
  if (!options.solanaRpcUrl) return null;
  assertOptionalHttpUrl(options.solanaRpcUrl, "solana RPC URL");
  const signatures = await verifySolanaSignatures(payload, options, rpcCall);
  const accounts = await verifySolanaAccounts(payload, options, rpcCall);
  return {
    rpc_url: options.solanaRpcUrl,
    signatures,
    accounts,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

async function expectRejectAsync(label, fn, pattern) {
  try {
    await fn();
  } catch (error) {
    if (pattern) assert(pattern.test(error.message), `${label} rejected for wrong reason: ${error.message}`);
    return error.message;
  }
  throw new Error(`${label} should have been rejected`);
}

function selfTestRpc(accountFixture, missingStatus = false) {
  return async (_rpcUrl, method, params) => {
    if (method === "getSignatureStatuses") {
      return {
        value: params[0].map(() => missingStatus ? null : {
          err: null,
          confirmationStatus: "confirmed",
        }),
      };
    }
    if (method === "getAccountInfo") {
      return {
        value: {
          owner: accountFixture.owner,
          data: [accountFixture.data_base64, "base64"],
          lamports: Number(accountFixture.lamports || 0),
        },
      };
    }
    throw new Error(`unexpected self-test RPC method ${method}`);
  };
}

async function runSelfTest() {
  const payload = readJson(DEFAULT_EVIDENCE);
  const accountFixture = readJson(DEFAULT_LIVE_ACCOUNT);
  const strictOptions = {
    requireWalletSend: true,
    requireVerifierIngestion: true,
    requireWorkerSubmission: true,
    requireLiveAccount: true,
    allowEmptyFeed: false,
    solanaRpcUrl: "http://127.0.0.1/mock-solana-rpc",
    minConfirmation: "confirmed",
  };
  const counts = validateEvidence(payload, strictOptions);
  const solanaRpc = await verifySolanaRpcEvidence(payload, strictOptions, selfTestRpc(accountFixture));

  const leakedToken = clone(payload);
  leakedToken.verifier.token = "plain-test-value";
  const rejectedToken = expectReject("leaked verifier token", () => validateEvidence(leakedToken, strictOptions), /redacted/);

  const missingWalletSend = clone(payload);
  missingWalletSend.wallet_submissions = {};
  missingWalletSend.solana.wallet_submission_count = 0;
  missingWalletSend.counts.wallet_submissions = 0;
  const rejectedWalletSend = expectReject("missing wallet send", () => validateEvidence(missingWalletSend, strictOptions), /wallet submission/);

  const mismatchedCount = clone(payload);
  mismatchedCount.counts.worker_submissions = 0;
  const rejectedCount = expectReject("mismatched count", () => validateEvidence(mismatchedCount, strictOptions), /counts\.worker_submissions/);

  const rejectedRpcStatus = await expectRejectAsync(
    "missing RPC signature status",
    () => verifySolanaRpcEvidence(payload, strictOptions, selfTestRpc(accountFixture, true)),
    /status missing/,
  );

  return {
    counts,
    solanaRpc,
    rejected: {
      leaked_token: rejectedToken,
      missing_wallet_send: rejectedWalletSend,
      mismatched_count: rejectedCount,
      missing_rpc_signature_status: rejectedRpcStatus,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    const result = await runSelfTest();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      evidence: DEFAULT_EVIDENCE,
      self_test: true,
      counts: result.counts,
      solana_rpc: result.solanaRpc,
      rejected: result.rejected,
      verifier_token: "redacted",
      no_new_dependencies: true,
    }, null, 2)}\n`);
    return;
  }

  const evidencePath = path.resolve(options.file);
  const payload = readJson(evidencePath);
  const counts = validateEvidence(payload, options);
  const solanaRpc = await verifySolanaRpcEvidence(payload, options);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    evidence: path.relative(process.cwd(), evidencePath),
    kind: payload.kind,
    generated_at: payload.generated_at,
    counts,
    strict_requirements: {
      wallet_send: options.requireWalletSend,
      verifier_ingestion: options.requireVerifierIngestion,
      worker_submission: options.requireWorkerSubmission,
      live_account: options.requireLiveAccount,
    },
    solana_rpc: solanaRpc,
    verifier_token: "redacted",
    no_new_dependencies: true,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`validate-private-beta-qa-evidence: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  validateEvidence,
  verifySolanaRpcEvidence,
};
