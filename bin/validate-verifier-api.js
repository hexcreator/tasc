#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const { createVerifierApi } = require("./tascverifier-api");

const TRUSTED_INDEX = "examples/index/solana.spl.live.index.json";
const WORKER_PROOF = "examples/submissions/summarize_url_spl.worker-submission.json";
const EXPECTED_RESULT_HASH = "sha256:0bdfacb7e0ec2c3241da82c7b812b1a0fa28945b47c7f8a6b113b4de3779776f";
const RECEIVED_AT = "2026-01-01T00:00:02.000Z";

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

function requestJson(port, method, path, body) {
  const payload = body === undefined ? null : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: payload ? {
        "content-type": "application/json",
        "content-length": String(payload.length),
      } : undefined,
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

async function main() {
  const trustedIndex = loadJson(TRUSTED_INDEX);
  const workerSubmission = loadJson(WORKER_PROOF);
  const server = createVerifierApi({
    entryFile: TRUSTED_INDEX,
    trustedContext: trustedIndex,
    ledger: [],
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
    assert(health.headers["access-control-allow-origin"] === "*", "CORS origin header mismatch");

    const options = await requestJson(port, "OPTIONS", "/v1/ingest");
    assert(options.statusCode === 204, "OPTIONS status mismatch");

    const wrongMethod = await requestJson(port, "GET", "/v1/ingest");
    assert(wrongMethod.statusCode === 405, "wrong method status mismatch");

    const missing = await requestJson(port, "POST", "/missing", "{}");
    assert(missing.statusCode === 404, "missing route status mismatch");

    const invalidJson = await requestJson(port, "POST", "/v1/ingest", "{not-json");
    assert(invalidJson.statusCode === 400, "invalid JSON status mismatch");
    assert(/invalid JSON/.test(invalidJson.body.error), "invalid JSON error mismatch");

    const accepted = await requestJson(port, "POST", "/v1/ingest", JSON.stringify({ submission: workerSubmission }));
    assert(accepted.statusCode === 200, "accepted status mismatch");
    assert(accepted.body.kind === "tasc.verifier.ingestion", "accepted kind mismatch");
    assert(accepted.body.accepted === true, "accepted flag mismatch");
    assert(accepted.body.received_at === RECEIVED_AT, "received_at mismatch");
    assert(accepted.body.attestation.verdict === "pass", "attestation verdict mismatch");
    assert(accepted.body.attestation.result_hash === EXPECTED_RESULT_HASH, "attestation result_hash mismatch");
    assert(accepted.body.settlement.attest.result_hash_bytes32 === `0x${EXPECTED_RESULT_HASH.slice("sha256:".length)}`, "attest bytes32 mismatch");

    const afterAcceptedHealth = await requestJson(port, "GET", "/health");
    assert(afterAcceptedHealth.body.ledger_size === 1, "ledger should record accepted result hash");

    const duplicate = await requestJson(port, "POST", "/v1/ingest", JSON.stringify(workerSubmission));
    assert(duplicate.statusCode === 422, "duplicate status mismatch");
    assert(duplicate.body.accepted === false, "duplicate accepted flag mismatch");
    assert(duplicate.body.attestation.verdict === "fail", "duplicate verdict mismatch");
    assert(duplicate.body.attestation.checks.some((check) => check.rule.op === "no_duplicate" && check.pass === false), "duplicate check mismatch");

    const tampered = {
      ...workerSubmission,
      inputs: { url: "https://example.invalid/not-the-task" },
    };
    const tamperedResponse = await requestJson(port, "POST", "/v1/ingest", JSON.stringify(tampered));
    assert(tamperedResponse.statusCode === 400, "tampered proof status mismatch");
    assert(/inputs/.test(tamperedResponse.body.error), "tampered proof error mismatch");

    const oversized = await requestJson(port, "POST", "/v1/ingest", JSON.stringify({
      submission: {
        ...workerSubmission,
        output: { markdown: "x".repeat(20 * 1024) },
      },
    }));
    assert(oversized.statusCode === 413, "oversized status mismatch");
    assert(/too large/.test(oversized.body.error), "oversized error mismatch");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      api: "bin/tascverifier-api.js",
      routes: ["GET /health", "POST /v1/ingest"],
      accepted: {
        result_hash: accepted.body.attestation.result_hash,
        result_hash_bytes32: accepted.body.settlement.attest.result_hash_bytes32,
      },
      rejected: {
        duplicate: duplicate.body.attestation.checks.find((check) => check.rule.op === "no_duplicate").actual,
        tampered_inputs: tamperedResponse.body.error,
        oversized: oversized.body.error,
        invalid_json: invalidJson.body.error,
      },
      no_new_dependencies: true,
    }, null, 2)}\n`);
  } finally {
    await close(server);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`validate-verifier-api: ${error.message}`);
    process.exit(1);
  });
}
