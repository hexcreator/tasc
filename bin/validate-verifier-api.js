#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { createVerifierApi } = require("./tascverifier-api");

const TRUSTED_INDEX = "examples/index/solana.spl.live.index.json";
const WORKER_PROOF = "examples/submissions/summarize_url_spl.worker-submission.json";
const EXPECTED_RESULT_HASH = "sha256:0bdfacb7e0ec2c3241da82c7b812b1a0fa28945b47c7f8a6b113b4de3779776f";
const RECEIVED_AT = "2026-01-01T00:00:02.000Z";
const AUTH_TOKEN = "test-verifier-token";
const AUTH_ENV = "TASC_VERIFIER_API_TEST_TOKEN";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestJson(port, method, route, body, extraHeaders = {}) {
  const payload = body === undefined ? null : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: route,
      headers: {
        ...extraHeaders,
        ...(payload ? {
        "content-type": "application/json",
        "content-length": String(payload.length),
        } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        if (text.trim()) json = JSON.parse(text);
        resolve({ statusCode: res.statusCode, headers: res.headers, body: json, text });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function authHeaders() {
  return { authorization: `Bearer ${AUTH_TOKEN}` };
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
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
  const trustedIndex = loadJson(TRUSTED_INDEX);
  const workerSubmission = loadJson(WORKER_PROOF);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tasc-verifier-api-"));
  const artifactDir = path.join(tempDir, "artifacts");
  const ledgerOut = path.join(tempDir, "ledger.json");
  delete process.env.TASC_VERIFIER_API_MISSING_TOKEN;
  const missingEnvError = expectReject("missing auth env", () => createVerifierApi({
    entryFile: TRUSTED_INDEX,
    trustedContext: trustedIndex,
    authTokenEnv: "TASC_VERIFIER_API_MISSING_TOKEN",
  }), /missing auth token env/);
  process.env[AUTH_ENV] = AUTH_TOKEN;
  const server = createVerifierApi({
    entryFile: TRUSTED_INDEX,
    trustedContext: trustedIndex,
    ledger: [],
    ledgerOut,
    artifactDir,
    authTokenEnv: AUTH_ENV,
    maxBytes: 16 * 1024,
    now: () => RECEIVED_AT,
  });

  const port = await listen(server);
  try {
    const health = await requestJson(port, "GET", "/health");
    assert(health.statusCode === 200, "health status mismatch");
    assert(health.body.ok === true, "health ok mismatch");
    assert(health.body.service === "tasc.verifier.api", "health service mismatch");
    assert(health.body.trusted_entries === 1, "health trusted entry count mismatch");
    assert(health.body.ledger_size === 0, "initial ledger size mismatch");
    assert(health.body.auth_required === true, "health auth_required mismatch");
    assert(health.body.artifact_persistence === true, "health artifact persistence mismatch");
    assert(health.body.persistent_ledger === true, "health persistent ledger mismatch");
    assert(health.headers["access-control-allow-origin"] === "*", "CORS origin header mismatch");

    const options = await requestJson(port, "OPTIONS", "/v1/ingest");
    assert(options.statusCode === 204, "OPTIONS status mismatch");

    const wrongMethod = await requestJson(port, "GET", "/v1/ingest");
    assert(wrongMethod.statusCode === 405, "wrong method status mismatch");

    const missing = await requestJson(port, "POST", "/missing", "{}");
    assert(missing.statusCode === 404, "missing route status mismatch");

    const invalidJson = await requestJson(port, "POST", "/v1/ingest", "{not-json");
    assert(invalidJson.statusCode === 401, "unauthenticated invalid JSON should be rejected before parsing");

    const wrongToken = await requestJson(port, "POST", "/v1/ingest", JSON.stringify({ submission: workerSubmission }), { authorization: "Bearer wrong" });
    assert(wrongToken.statusCode === 401, "wrong token status mismatch");
    assert(/bearer token/.test(wrongToken.body.error), "wrong token error mismatch");

    const invalidJsonAuthed = await requestJson(port, "POST", "/v1/ingest", "{not-json", authHeaders());
    assert(invalidJsonAuthed.statusCode === 400, "invalid JSON status mismatch");
    assert(/invalid JSON/.test(invalidJsonAuthed.body.error), "invalid JSON error mismatch");

    const accepted = await requestJson(port, "POST", "/v1/ingest", JSON.stringify({ submission: workerSubmission }), authHeaders());
    assert(accepted.statusCode === 200, "accepted status mismatch");
    assert(accepted.body.kind === "tasc.verifier.ingestion", "accepted kind mismatch");
    assert(accepted.body.accepted === true, "accepted flag mismatch");
    assert(accepted.body.received_at === RECEIVED_AT, "received_at mismatch");
    assert(accepted.body.attestation.verdict === "pass", "attestation verdict mismatch");
    assert(accepted.body.attestation.result_hash === EXPECTED_RESULT_HASH, "attestation result_hash mismatch");
    assert(accepted.body.settlement.attest.result_hash_bytes32 === `0x${EXPECTED_RESULT_HASH.slice("sha256:".length)}`, "attest bytes32 mismatch");
    assert(accepted.body.artifact && accepted.body.artifact.path, "accepted artifact path missing");
    assert(fs.existsSync(accepted.body.artifact.path), "accepted artifact file missing");

    const afterAcceptedHealth = await requestJson(port, "GET", "/health");
    assert(afterAcceptedHealth.body.ledger_size === 1, "ledger should record accepted result hash");
    const writtenLedger = loadJson(ledgerOut);
    assert(writtenLedger.kind === "tasc.verifier.ledger", "ledger kind mismatch");
    assert(writtenLedger.result_hashes.includes(EXPECTED_RESULT_HASH), "persistent ledger missing result hash");
    assert(listJsonFiles(artifactDir).length === 1, "accepted artifact count mismatch");

    const duplicate = await requestJson(port, "POST", "/v1/ingest", JSON.stringify(workerSubmission), authHeaders());
    assert(duplicate.statusCode === 422, "duplicate status mismatch");
    assert(duplicate.body.accepted === false, "duplicate accepted flag mismatch");
    assert(duplicate.body.attestation.verdict === "fail", "duplicate verdict mismatch");
    assert(duplicate.body.attestation.checks.some((check) => check.rule.op === "no_duplicate" && check.pass === false), "duplicate check mismatch");
    assert(duplicate.body.artifact && fs.existsSync(duplicate.body.artifact.path), "duplicate artifact file missing");
    assert(listJsonFiles(artifactDir).length === 2, "duplicate artifact count mismatch");

    const tampered = {
      ...workerSubmission,
      inputs: { url: "https://example.invalid/not-the-task" },
    };
    const tamperedResponse = await requestJson(port, "POST", "/v1/ingest", JSON.stringify(tampered), authHeaders());
    assert(tamperedResponse.statusCode === 400, "tampered proof status mismatch");
    assert(/inputs/.test(tamperedResponse.body.error), "tampered proof error mismatch");

    const oversized = await requestJson(port, "POST", "/v1/ingest", JSON.stringify({
      submission: {
        ...workerSubmission,
        output: { markdown: "x".repeat(20 * 1024) },
      },
    }), authHeaders());
    assert(oversized.statusCode === 413, "oversized status mismatch");
    assert(/too large/.test(oversized.body.error), "oversized error mismatch");

    await close(server);

    const restartedServer = createVerifierApi({
      entryFile: TRUSTED_INDEX,
      trustedContext: trustedIndex,
      ledgerOut,
      artifactDir,
      authTokenEnv: AUTH_ENV,
      maxBytes: 16 * 1024,
      now: () => RECEIVED_AT,
    });
    const restartedPort = await listen(restartedServer);
    try {
      const restartedHealth = await requestJson(restartedPort, "GET", "/health");
      assert(restartedHealth.body.ledger_size === 1, "restarted ledger size mismatch");
      const duplicateAfterRestart = await requestJson(restartedPort, "POST", "/v1/ingest", JSON.stringify(workerSubmission), authHeaders());
      assert(duplicateAfterRestart.statusCode === 422, "duplicate after restart status mismatch");
      assert(duplicateAfterRestart.body.attestation.verdict === "fail", "duplicate after restart verdict mismatch");
    } finally {
      await close(restartedServer);
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      api: "bin/tascverifier-api.js",
      routes: ["GET /health", "POST /v1/ingest"],
      auth_required: true,
      accepted: {
        result_hash: accepted.body.attestation.result_hash,
        result_hash_bytes32: accepted.body.settlement.attest.result_hash_bytes32,
        artifact: accepted.body.artifact.path,
      },
      rejected: {
        duplicate: duplicate.body.attestation.checks.find((check) => check.rule.op === "no_duplicate").actual,
        tampered_inputs: tamperedResponse.body.error,
        oversized: oversized.body.error,
        invalid_json: invalidJsonAuthed.body.error,
        unauthorized: wrongToken.body.error,
        missing_auth_env: missingEnvError,
      },
      persistent_ledger: ledgerOut,
      artifact_count: listJsonFiles(artifactDir).length,
      no_new_dependencies: true,
    }, null, 2)}\n`);
  } finally {
    if (server.listening) await close(server);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`validate-verifier-api: ${error.message}`);
    process.exit(1);
  });
}
