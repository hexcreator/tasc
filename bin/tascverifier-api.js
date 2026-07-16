#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const { entriesFromTrustedContext, ingestWorkerSubmissionProof } = require("./tascverifier-service");
const { readLedger } = require("./tascverify");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BYTES = 256 * 1024;

function usage() {
  console.error([
    "Usage:",
    "  node bin/tascverifier-api.js serve --entry <index-or-entry.json> [--ledger ledger.json] [--host 127.0.0.1] [--port 8787] [--max-bytes n]",
    "",
    "Routes:",
    "  GET  /health",
    "  POST /v1/ingest",
  ].join("\n"));
  process.exit(1);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "serve") usage();
  const options = {
    entryFile: null,
    ledgerFile: null,
    host: DEFAULT_HOST,
    port: process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT,
    maxBytes: DEFAULT_MAX_BYTES,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--entry") {
      options.entryFile = rest[++i];
      if (!options.entryFile) usage();
    } else if (arg === "--ledger") {
      options.ledgerFile = rest[++i];
      if (!options.ledgerFile) usage();
    } else if (arg === "--host") {
      options.host = rest[++i];
      if (!options.host) usage();
    } else if (arg === "--port") {
      options.port = Number(rest[++i]);
      if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) usage();
    } else if (arg === "--max-bytes") {
      options.maxBytes = Number(rest[++i]);
      if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1024) usage();
    } else {
      usage();
    }
  }

  if (!options.entryFile) usage();
  return options;
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendNoContent(res) {
  res.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  });
  res.end();
}

function errorStatus(error) {
  if (Number.isInteger(error.statusCode)) return error.statusCode;
  if (/json/i.test(error.message)) return 400;
  if (/too large/i.test(error.message)) return 413;
  if (/verdict|duplicate/i.test(error.message)) return 422;
  return 400;
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        const error = new Error("request body too large");
        error.statusCode = 413;
        reject(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function submissionFromPayload(payload) {
  if (payload && payload.kind === "tasc.worker.submission") return payload;
  if (payload && payload.submission && payload.submission.kind === "tasc.worker.submission") return payload.submission;
  throw new Error("request body must be tasc.worker.submission or { submission }");
}

function createVerifierApi(options) {
  const trustedContext = options.trustedContext || loadJson(options.entryFile);
  const trustedEntries = entriesFromTrustedContext(trustedContext);
  const ledger = new Set(options.ledger || readLedger(options.ledgerFile));
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const entryFile = options.entryFile || null;
  const now = options.now || (() => new Date().toISOString());

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "OPTIONS") {
      sendNoContent(res);
      return;
    }

    if (url.pathname === "/health") {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        service: "tasc.verifier.api",
        version: "0.1",
        trusted_entries: trustedEntries.length,
        ledger_size: ledger.size,
      });
      return;
    }

    if (url.pathname !== "/v1/ingest") {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }

    try {
      const body = await readRequestBody(req, maxBytes);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        const error = new Error("invalid JSON request body");
        error.statusCode = 400;
        throw error;
      }
      const submission = submissionFromPayload(payload);
      const result = ingestWorkerSubmissionProof(submission, trustedContext, {
        entryFile,
        ledger: Array.from(ledger),
        receivedAt: now(),
      });
      if (result.accepted) ledger.add(result.attestation.result_hash);
      sendJson(res, result.accepted ? 200 : 422, result);
    } catch (error) {
      sendJson(res, errorStatus(error), {
        ok: false,
        error: error.message,
      });
    }
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = createVerifierApi(options);
  server.listen(options.port, options.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    process.stderr.write(`tasc verifier API listening on http://${options.host}:${port}\n`);
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`tascverifier-api: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  createVerifierApi,
  parseArgs,
};
