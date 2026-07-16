#!/usr/bin/env node

const net = require("net");
const publishClaimable = require("./publish-beta-claimable");
const { sessionSummary, startPrivateBetaSession } = require("./run-private-beta-local");

const ACTIVE_INDEX_FILE = "web/feed/active.claimable.index.json";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_WEB_PORT = 8767;
const DEFAULT_VERIFIER_PORT = 8790;
const DEFAULT_LEDGER = "examples/ledger.json";
const DEFAULT_LEDGER_OUT = ".tascverifier/ledger.json";
const DEFAULT_ARTIFACT_DIR = ".tascverifier/artifacts";
const DEFAULT_TOKEN_ENV = "TASC_VERIFIER_API_TOKEN";
const QA_COMMAND = "npm run beta:qa -- ~/Downloads/tasc-private-beta-qa.json --solana-rpc-url https://api.devnet.solana.com";

function usage() {
  console.error([
    "Usage:",
    "  node bin/run-private-beta-session.js plan [options]",
    "  node bin/run-private-beta-session.js run [options]",
    "",
    "Local session options:",
    "  --host <host>                 default 127.0.0.1",
    "  --web-port <port>             default 8767; use 0 for ephemeral",
    "  --verifier-port <port>        default 8790; use 0 for ephemeral",
    "  --ledger <ledger.json>        duplicate ledger seed",
    "  --ledger-out <ledger.json>    verifier duplicate ledger output",
    "  --artifact-dir <dir>          verifier ingestion artifacts",
    "  --token <token>               bearer token; otherwise env or generated",
    "  --token-env <ENV>             token environment variable; default TASC_VERIFIER_API_TOKEN",
    "",
    "Claimable publish options:",
    "  --env <file>                  default .env.solana-devnet.local",
    "  --out-dir <dir>               supporting artifact dir",
    "  --publish-dir <dir>           static feed dir; default web/feed",
    "  --public-prefix <path>        path used in claimable-feed.json; default feed",
    "  --run-id <id>                 stable run id for artifact names",
    "  --program-id <address>        deployed program id",
    "  --deadline <duration>         task work window; default 60s",
    "  --mint-amount <amount>        devnet SPL base units minted for the active task",
    "  --input name=value            task input; defaults to the x402 docs URL",
    "",
    `run is live devnet only and refuses to publish without ${publishClaimable.ALLOW_ENV}=1.`,
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
  if (command !== "plan" && command !== "run") usage();
  const options = {
    command,
    host: DEFAULT_HOST,
    webPort: DEFAULT_WEB_PORT,
    verifierPort: DEFAULT_VERIFIER_PORT,
    ledgerFile: DEFAULT_LEDGER,
    ledgerOut: DEFAULT_LEDGER_OUT,
    artifactDir: DEFAULT_ARTIFACT_DIR,
    token: null,
    tokenEnv: DEFAULT_TOKEN_ENV,
    envFile: undefined,
    outDir: undefined,
    publishDir: undefined,
    publicPrefix: undefined,
    runId: undefined,
    programId: undefined,
    deadline: undefined,
    mintAmount: undefined,
    inputs: undefined,
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
    } else if (arg === "--env") {
      options.envFile = rest[++i];
      if (!options.envFile) usage();
    } else if (arg === "--out-dir") {
      options.outDir = rest[++i];
      if (!options.outDir) usage();
    } else if (arg === "--publish-dir") {
      options.publishDir = rest[++i];
      if (!options.publishDir) usage();
    } else if (arg === "--public-prefix") {
      options.publicPrefix = rest[++i];
      if (!options.publicPrefix) usage();
    } else if (arg === "--run-id") {
      options.runId = rest[++i];
      if (!options.runId) usage();
    } else if (arg === "--program-id") {
      options.programId = rest[++i];
      if (!options.programId) usage();
    } else if (arg === "--deadline") {
      options.deadline = rest[++i];
      if (!options.deadline) usage();
    } else if (arg === "--mint-amount") {
      options.mintAmount = rest[++i];
      if (!options.mintAmount) usage();
    } else if (arg === "--input") {
      const [name, ...valueParts] = String(rest[++i] || "").split("=");
      if (!name || valueParts.length === 0) throw new Error("--input must use name=value");
      options.inputs = options.inputs || {};
      options.inputs[name] = valueParts.join("=");
    } else {
      usage();
    }
  }

  return options;
}

function publishOptions(options = {}) {
  return {
    envFile: options.envFile,
    outDir: options.outDir,
    publishDir: options.publishDir,
    publicPrefix: options.publicPrefix,
    runId: options.runId,
    programId: options.programId,
    deadline: options.deadline,
    mintAmount: options.mintAmount,
    inputs: options.inputs,
  };
}

function sessionOptions(options = {}, entryFile = ACTIVE_INDEX_FILE) {
  return {
    host: options.host || DEFAULT_HOST,
    webPort: options.webPort ?? DEFAULT_WEB_PORT,
    verifierPort: options.verifierPort ?? DEFAULT_VERIFIER_PORT,
    entryFile,
    ledgerFile: options.ledgerFile || DEFAULT_LEDGER,
    ledgerOut: options.ledgerOut || DEFAULT_LEDGER_OUT,
    artifactDir: options.artifactDir || DEFAULT_ARTIFACT_DIR,
    token: options.token || null,
    tokenEnv: options.tokenEnv || DEFAULT_TOKEN_ENV,
  };
}

function walletQaSteps() {
  return [
    "Open app_url in a browser with Phantom or Solflare on devnet.",
    "Click Load Hosted Feed so the app imports web/feed/claimable-feed.json and its active claimable index.",
    "Confirm the Verifier API panel auto-filled from local_config_url; enter verifier_api_url and verifier_bearer_token manually only if needed.",
    "Connect the role wallet, refresh Solana status, enable wallet sends, and submit the prompted role action.",
    "Capture worker proof, submit it to the verifier API, then use the returned attest hash for verifier attest and release/refund.",
    `Export QA evidence and validate it with: ${QA_COMMAND}`,
  ];
}

function withActiveWalletSteps(summary) {
  return {
    ...summary,
    wallet_qa_steps: walletQaSteps(),
  };
}

function localSummary(options, entryFile) {
  const token = options.token
    || process.env[options.tokenEnv || DEFAULT_TOKEN_ENV]
    || `<generated by run if ${options.tokenEnv || DEFAULT_TOKEN_ENV} is unset>`;
  return withActiveWalletSteps(sessionSummary({
    host: options.host || DEFAULT_HOST,
    webPort: options.webPort ?? DEFAULT_WEB_PORT,
    verifierPort: options.verifierPort ?? DEFAULT_VERIFIER_PORT,
    token,
    entryFile,
    ledgerOut: options.ledgerOut || DEFAULT_LEDGER_OUT,
    artifactDir: options.artifactDir || DEFAULT_ARTIFACT_DIR,
  }));
}

function operatorSteps(summary) {
  return [
    `When ready to spend devnet transactions, run: ${publishClaimable.ALLOW_ENV}=1 npm run beta:session`,
    `Open ${summary.app_url}`,
    "Click Load Hosted Feed.",
    "Connect Phantom or Solflare on devnet.",
    "Refresh Solana status, enable wallet sends, then claim, submit proof, attest, and release/refund.",
    `Export QA evidence and validate it with: ${QA_COMMAND}`,
  ];
}

function preflightPort(host, port, label) {
  if (port === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} port ${port} is not available on ${host}: ${error.message}`));
    };
    server.once("error", fail);
    server.listen(port, host, () => {
      server.off("error", fail);
      server.close((error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

async function preflightLocalPorts(options) {
  const host = options.host || DEFAULT_HOST;
  const webPort = options.webPort ?? DEFAULT_WEB_PORT;
  const verifierPort = options.verifierPort ?? DEFAULT_VERIFIER_PORT;
  assert(webPort === 0 || verifierPort === 0 || webPort !== verifierPort, "web and verifier ports must differ");
  await preflightPort(host, webPort, "web");
  await preflightPort(host, verifierPort, "verifier");
}

function assertLiveGuard(env = process.env) {
  assert(env[publishClaimable.ALLOW_ENV] === "1", `refusing live publish without ${publishClaimable.ALLOW_ENV}=1`);
}

function plan(rawOptions = {}) {
  const options = {
    host: DEFAULT_HOST,
    webPort: DEFAULT_WEB_PORT,
    verifierPort: DEFAULT_VERIFIER_PORT,
    ledgerFile: DEFAULT_LEDGER,
    ledgerOut: DEFAULT_LEDGER_OUT,
    artifactDir: DEFAULT_ARTIFACT_DIR,
    tokenEnv: DEFAULT_TOKEN_ENV,
    ...rawOptions,
  };
  const activePublish = publishClaimable.plan(publishOptions(options));
  const trustedIndex = activePublish.claimable_index_file || ACTIVE_INDEX_FILE;
  const localSession = localSummary(options, trustedIndex);
  return {
    ok: true,
    mode: "plan",
    sends_transactions: false,
    guard_for_live_run: activePublish.guard_for_live_run,
    no_new_dependencies: true,
    active_publish: activePublish,
    local_session: localSession,
    verifier_trusted_index: trustedIndex,
    app_action: "Load Hosted Feed",
    run_sequence: [
      "preflight localhost web/verifier ports",
      "publish fresh active claimable feed",
      "start localhost static app",
      "start localhost verifier API",
      "trust the freshly published active claimable index",
    ],
    command_path: {
      plan: "npm run beta:session:plan",
      live: `${publishClaimable.ALLOW_ENV}=1 npm run beta:session`,
      qa: QA_COMMAND,
    },
    operator_steps: operatorSteps(localSession),
  };
}

async function run(rawOptions = {}) {
  const options = {
    host: DEFAULT_HOST,
    webPort: DEFAULT_WEB_PORT,
    verifierPort: DEFAULT_VERIFIER_PORT,
    ledgerFile: DEFAULT_LEDGER,
    ledgerOut: DEFAULT_LEDGER_OUT,
    artifactDir: DEFAULT_ARTIFACT_DIR,
    tokenEnv: DEFAULT_TOKEN_ENV,
    ...rawOptions,
  };
  assertLiveGuard();
  await preflightLocalPorts(options);
  const activePublish = await publishClaimable.run(publishOptions(options));
  const trustedIndex = activePublish.claimable_index_file || ACTIVE_INDEX_FILE;
  const session = await startPrivateBetaSession(sessionOptions(options, trustedIndex));
  const localSession = withActiveWalletSteps(session.summary);
  return {
    activePublish,
    session,
    summary: {
      ok: true,
      mode: "run",
      sends_transactions: true,
      guard_for_live_run: `${publishClaimable.ALLOW_ENV}=1`,
      no_new_dependencies: true,
      active_publish: activePublish,
      local_session: localSession,
      verifier_trusted_index: trustedIndex,
      app_action: "Load Hosted Feed",
      command_path: {
        qa: QA_COMMAND,
      },
      operator_steps: operatorSteps(localSession),
    },
    async close() {
      await session.close();
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "plan") {
    process.stdout.write(`${JSON.stringify(plan(options), null, 2)}\n`);
    return;
  }

  const started = await run(options);
  process.stdout.write(`${JSON.stringify(started.summary, null, 2)}\n`);
  process.stderr.write("Private beta active session running. Press Ctrl-C to stop.\n");

  const shutdown = async () => {
    try {
      await started.close();
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
    console.error(`run-private-beta-session: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  ACTIVE_INDEX_FILE,
  QA_COMMAND,
  parseArgs,
  assertLiveGuard,
  plan,
  preflightLocalPorts,
  run,
};
