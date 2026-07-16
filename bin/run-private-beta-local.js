#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { createVerifierApi } = require("./tascverifier-api");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_WEB_PORT = 8767;
const DEFAULT_VERIFIER_PORT = 8790;
const DEFAULT_ENTRY = "examples/index/solana.spl.live.index.json";
const DEFAULT_LEDGER = "examples/ledger.json";
const DEFAULT_LEDGER_OUT = ".tascverifier/ledger.json";
const DEFAULT_ARTIFACT_DIR = ".tascverifier/artifacts";
const ALLOWED_TOP_LEVELS = new Set(["assets", "docs", "examples", "web"]);

function usage() {
  console.error([
    "Usage:",
    "  node bin/run-private-beta-local.js plan [options]",
    "  node bin/run-private-beta-local.js serve [options]",
    "",
    "Options:",
    "  --host <host>                 default 127.0.0.1",
    "  --web-port <port>             default 8767; use 0 for ephemeral",
    "  --verifier-port <port>        default 8790; use 0 for ephemeral",
    "  --entry <index.json>          trusted verifier index",
    "  --ledger <ledger.json>        duplicate ledger seed",
    "  --ledger-out <ledger.json>    verifier duplicate ledger output",
    "  --artifact-dir <dir>          verifier ingestion artifacts",
    "  --token <token>               bearer token; otherwise env or generated",
    "  --token-env <ENV>             token environment variable; default TASC_VERIFIER_API_TOKEN",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parsePort(value, label) {
  const port = Number(value);
  assert(Number.isInteger(port) && port >= 0 && port <= 65535, `${label} must be a valid TCP port`);
  return port;
}

function resolveFromRoot(file) {
  const resolved = path.resolve(ROOT, file);
  assert(resolved.startsWith(`${ROOT}${path.sep}`) || resolved === ROOT, `${file} must stay inside repo root`);
  return resolved;
}

function resolveWritablePath(file) {
  return path.isAbsolute(file) ? path.resolve(file) : resolveFromRoot(file);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "plan" && command !== "serve") usage();
  const options = {
    command,
    host: DEFAULT_HOST,
    webPort: DEFAULT_WEB_PORT,
    verifierPort: DEFAULT_VERIFIER_PORT,
    entryFile: DEFAULT_ENTRY,
    ledgerFile: DEFAULT_LEDGER,
    ledgerOut: DEFAULT_LEDGER_OUT,
    artifactDir: DEFAULT_ARTIFACT_DIR,
    token: null,
    tokenEnv: "TASC_VERIFIER_API_TOKEN",
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--host") {
      options.host = rest[++i];
      if (!options.host) usage();
    } else if (arg === "--web-port") {
      options.webPort = parsePort(rest[++i], "web port");
    } else if (arg === "--verifier-port") {
      options.verifierPort = parsePort(rest[++i], "verifier port");
    } else if (arg === "--entry") {
      options.entryFile = rest[++i];
      if (!options.entryFile) usage();
    } else if (arg === "--ledger") {
      options.ledgerFile = rest[++i];
      if (!options.ledgerFile) usage();
    } else if (arg === "--ledger-out") {
      options.ledgerOut = rest[++i];
      if (!options.ledgerOut) usage();
    } else if (arg === "--artifact-dir") {
      options.artifactDir = rest[++i];
      if (!options.artifactDir) usage();
    } else if (arg === "--token") {
      options.token = rest[++i];
      if (!options.token) usage();
    } else if (arg === "--token-env") {
      options.tokenEnv = rest[++i];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(options.tokenEnv || ""))) usage();
    } else {
      usage();
    }
  }

  return options;
}

function tokenForOptions(options) {
  return options.token || process.env[options.tokenEnv] || crypto.randomBytes(24).toString("hex");
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".md") return "text/markdown; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  return "application/octet-stream";
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function localConfigPayload(config) {
  return {
    kind: "tasc.private_beta.local_config",
    version: "0.1",
    verifier: {
      apiUrl: `http://${config.host}:${config.verifierPort}`,
      token: config.token,
    },
    trusted_index: config.entryFile,
    verifier_ledger: config.ledgerOut,
    verifier_artifacts: config.artifactDir,
  };
}

function staticPathFromUrl(url) {
  if (url.pathname === "/") return { redirect: "/web/index.html" };
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const normalized = path.normalize(`/${decoded}`).replace(/^\/+/, "");
  const topLevel = normalized.split(path.sep)[0];
  if (!ALLOWED_TOP_LEVELS.has(topLevel)) return null;
  const file = path.resolve(ROOT, normalized);
  if (!file.startsWith(`${ROOT}${path.sep}`)) return null;
  return { file };
}

function createStaticServer(localConfig) {
  return http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "method not allowed\n", { "content-type": "text/plain; charset=utf-8" });
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/web/tasc-local-config.json") {
      const body = `${JSON.stringify(localConfig || { kind: "tasc.private_beta.local_config", unavailable: true }, null, 2)}\n`;
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        res.end();
        return;
      }
      send(res, 200, body, { "content-type": "application/json; charset=utf-8" });
      return;
    }
    const target = staticPathFromUrl(url);
    if (target && target.redirect) {
      res.writeHead(302, { location: target.redirect, "cache-control": "no-store" });
      res.end();
      return;
    }
    if (!target || !target.file || !fs.existsSync(target.file) || !fs.statSync(target.file).isFile()) {
      send(res, 404, "not found\n", { "content-type": "text/plain; charset=utf-8" });
      return;
    }
    const headers = { "content-type": contentType(target.file) };
    if (req.method === "HEAD") {
      res.writeHead(200, { "cache-control": "no-store", ...headers });
      res.end();
      return;
    }
    send(res, 200, fs.readFileSync(target.file), headers);
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sessionSummary(config) {
  return {
    kind: "tasc.private_beta.local_session",
    app_url: `http://${config.host}:${config.webPort}/web/index.html`,
    verifier_api_url: `http://${config.host}:${config.verifierPort}`,
    local_config_url: `http://${config.host}:${config.webPort}/web/tasc-local-config.json`,
    verifier_bearer_token: config.token,
    trusted_index: config.entryFile,
    verifier_ledger: config.ledgerOut,
    verifier_artifacts: config.artifactDir,
    wallet_qa_steps: [
      "Open app_url in a browser with Phantom or Solflare on devnet.",
      "Load Devnet Proof.",
      "Confirm the Verifier API panel auto-filled from local_config_url; enter verifier_api_url and verifier_bearer_token manually only if needed.",
      "Connect the role wallet, refresh Solana status, enable wallet sends, and submit the prompted role action.",
      "Capture worker proof, submit it to the verifier API, then use the returned attest hash for verifier attest and release/refund.",
    ],
  };
}

async function startPrivateBetaSession(rawOptions = {}) {
  const token = tokenForOptions(rawOptions);
  const entryFile = resolveFromRoot(rawOptions.entryFile || DEFAULT_ENTRY);
  const ledgerFile = resolveFromRoot(rawOptions.ledgerFile || DEFAULT_LEDGER);
  const ledgerOut = resolveWritablePath(rawOptions.ledgerOut || DEFAULT_LEDGER_OUT);
  const artifactDir = resolveWritablePath(rawOptions.artifactDir || DEFAULT_ARTIFACT_DIR);
  const host = rawOptions.host || DEFAULT_HOST;

  const verifierServer = createVerifierApi({
    entryFile,
    ledgerFile,
    ledgerOut,
    artifactDir,
    authToken: token,
  });
  const verifierPort = await listen(verifierServer, rawOptions.verifierPort ?? DEFAULT_VERIFIER_PORT, host);
  const provisionalConfig = {
    host,
    webPort: rawOptions.webPort ?? DEFAULT_WEB_PORT,
    verifierPort,
    token,
    entryFile: path.relative(ROOT, entryFile),
    ledgerOut: path.relative(ROOT, ledgerOut),
    artifactDir: path.relative(ROOT, artifactDir),
  };
  const staticServer = createStaticServer(localConfigPayload(provisionalConfig));
  let webPort = null;
  try {
    webPort = await listen(staticServer, rawOptions.webPort ?? DEFAULT_WEB_PORT, host);
  } catch (error) {
    await closeServer(verifierServer);
    throw error;
  }

  const config = {
    host,
    webPort,
    verifierPort,
    token,
    entryFile: path.relative(ROOT, entryFile),
    ledgerOut: path.relative(ROOT, ledgerOut),
    artifactDir: path.relative(ROOT, artifactDir),
  };

  return {
    config,
    staticServer,
    verifierServer,
    summary: sessionSummary(config),
    async close() {
      await Promise.all([closeServer(staticServer), closeServer(verifierServer)]);
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "plan") {
    const token = options.token || process.env[options.tokenEnv] || `<generated by serve if ${options.tokenEnv} is unset>`;
    process.stdout.write(`${JSON.stringify(sessionSummary({
      host: options.host,
      webPort: options.webPort,
      verifierPort: options.verifierPort,
      token,
      entryFile: options.entryFile,
      ledgerOut: options.ledgerOut,
      artifactDir: options.artifactDir,
    }), null, 2)}\n`);
    return;
  }

  const session = await startPrivateBetaSession(options);
  process.stdout.write(`${JSON.stringify(session.summary, null, 2)}\n`);
  process.stderr.write("Private beta local session running. Press Ctrl-C to stop.\n");

  const shutdown = async () => {
    try {
      await session.close();
      process.exit(0);
    } catch (error) {
      console.error(`shutdown failed: ${error.message}`);
      process.exit(1);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`run-private-beta-local: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  createStaticServer,
  parseArgs,
  sessionSummary,
  startPrivateBetaSession,
};
