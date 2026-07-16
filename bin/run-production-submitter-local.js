#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8777;
const ALLOWED_TOP_LEVELS = new Set(["assets", "docs", "examples", "web"]);

function usage() {
  console.error([
    "Usage:",
    "  node bin/run-production-submitter-local.js plan [options]",
    "  node bin/run-production-submitter-local.js serve [options]",
    "",
    "Options:",
    "  --host <host>       default 127.0.0.1",
    "  --port <port>       default 8777; use 0 for ephemeral",
    "",
    "This server only serves safe static files for web/production-run.html.",
    "It never reads env files, never accepts private keys, never calls RPC, and never sends transactions.",
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

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "plan" && command !== "serve") usage();
  const options = {
    command,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--host") {
      options.host = rest[++i];
      if (!options.host) usage();
    } else if (arg === "--port") {
      options.port = parsePort(rest[++i], "port");
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
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
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function staticPathFromUrl(url) {
  if (url.pathname === "/") return { redirect: "/web/production-run.html" };
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

function createProductionSubmitterServer() {
  return http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "method not allowed\n", { "content-type": "text/plain; charset=utf-8" });
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
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
      res.writeHead(200, { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
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

function summary(config) {
  const baseUrl = `http://${config.host}:${config.port}`;
  return {
    ok: true,
    kind: "tasc.production_submitter.local_session",
    version: "0.1",
    production_submitter_url: `${baseUrl}/web/production-run.html`,
    root_url: baseUrl,
    host: config.host,
    port: config.port,
    serves: [
      "web/production-run.html",
      "web/production-run.js",
      "web/tasc-web-core.js",
      "web/styles.css",
    ],
    restricted_paths: [
      ".env*",
      ".tascverifier/",
      "package.json",
      "package-lock.json",
      "node_modules/",
    ],
    operator_steps: [
      "Open production_submitter_url in a browser with Phantom or Solflare on Solana mainnet.",
      "Paste or select a generated .tascverifier/production-*.json transaction artifact.",
      "Enter the mainnet RPC URL in the page; it stays in the browser and is not served by this process.",
      "Connect the required role wallet and confirm it matches the artifact signer.",
      "Enable production wallet sends only after reviewing the artifact summary.",
      "Submit and run the generated npm run real:capture:record command.",
    ],
    sends_transactions: false,
    accepts_private_keys: false,
    calls_rpc: false,
    reads_env_files: false,
    full_rpc_url_persisted: false,
    no_new_dependencies: true,
  };
}

async function startProductionSubmitter(rawOptions = {}) {
  const host = rawOptions.host || DEFAULT_HOST;
  const requestedPort = rawOptions.port ?? DEFAULT_PORT;
  const server = createProductionSubmitterServer();
  const port = await listen(server, requestedPort, host);
  const config = { host, port };
  return {
    config,
    server,
    summary: summary(config),
    async close() {
      await closeServer(server);
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "plan") {
    process.stdout.write(`${JSON.stringify(summary({
      host: options.host,
      port: options.port,
    }), null, 2)}\n`);
    return;
  }

  const session = await startProductionSubmitter(options);
  process.stdout.write(`${JSON.stringify(session.summary, null, 2)}\n`);
  process.stderr.write("Production submitter local server running. Press Ctrl-C to stop.\n");

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
    console.error(`run-production-submitter-local: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  createProductionSubmitterServer,
  parseArgs,
  startProductionSubmitter,
  staticPathFromUrl,
  summary,
};
