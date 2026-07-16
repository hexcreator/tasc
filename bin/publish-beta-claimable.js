#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  DEFAULT_RPC_URL,
  base58Encode,
  keypairForRole,
  mergedEnv,
} = require("./run-solana-devnet");
const { SYSTEM_PROGRAM_ID, sendSpl } = require("./run-solana-fund");
const { createSolanaIntent, signSolanaIntent } = require("./tascsolana");
const splSetup = require("./run-solana-spl-setup");
const fundingScan = require("./scan-solana-live");
const { admit } = require("./tascindex");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_ENV_FILE = ".env.solana-devnet.local";
const DEFAULT_OUT_ROOT = "examples/solana-devnet/claimable";
const DEFAULT_PUBLISH_DIR = "web/feed";
const DEFAULT_PUBLIC_PREFIX = "feed";
const DEFAULT_PROGRAM_KEYPAIR = "build/solana/global_tasc_solana_program-keypair.json";
const DEFAULT_DEVNET_PROGRAM_ID = "FAqKhKke5pZr4TK6kXq9aKR98hWFy19SMQG9eGfXQrRM";
const DEFAULT_INPUTS = { url: "https://docs.cdp.coinbase.com/x402/welcome" };
const DEFAULT_DEADLINE = "60s";
const DEFAULT_MINT_AMOUNT = "10000000";
const ALLOW_ENV = "GLOBAL_TASC_ALLOW_BETA_CLAIMABLE_PUBLISH";
const SUBGUARDS = {
  GLOBAL_TASC_ALLOW_SOLANA_SPL_SETUP: "1",
  GLOBAL_TASC_ALLOW_SOLANA_SPL_FUND: "1",
};

function usage() {
  console.error([
    "Usage:",
    "  node bin/publish-beta-claimable.js plan [options]",
    "  node bin/publish-beta-claimable.js run [options]",
    "",
    "Options:",
    "  --env <file>               default .env.solana-devnet.local",
    "  --out-dir <dir>            supporting artifact dir; default examples/solana-devnet/claimable/<run-id>",
    "  --publish-dir <dir>        static feed dir; default web/feed",
    "  --public-prefix <path>     path used in claimable-feed.json; default feed",
    "  --run-id <id>              stable run id for artifact names",
    "  --program-id <address>     deployed program id",
    "  --deadline <duration>      task work window; default 60s",
    "  --mint-amount <amount>     devnet SPL base units minted for the active task; default 10000000",
    "  --input name=value         task input; defaults to the x402 docs URL",
    "",
    `run is live devnet only and refuses to send without ${ALLOW_ENV}=1.`,
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

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function sha256Hex(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function resolveInsideRoot(file, label) {
  const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(ROOT, file);
  assert(resolved === ROOT || resolved.startsWith(`${ROOT}${path.sep}`), `${label} must stay inside repo root`);
  return resolved;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function defaultRunId() {
  return `claimable_${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
}

function safeName(value) {
  const raw = String(value || defaultRunId()).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const collapsed = raw.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const prefixed = /^[a-z_]/.test(collapsed) ? collapsed : `claimable_${collapsed}`;
  return prefixed || defaultRunId();
}

function publicPath(prefix, name) {
  return `${String(prefix || "").replace(/^\/+|\/+$/g, "")}/${name}`.replace(/^\/+/, "");
}

function parseOptions(rest) {
  const options = {
    envFile: DEFAULT_ENV_FILE,
    outDir: null,
    publishDir: DEFAULT_PUBLISH_DIR,
    publicPrefix: DEFAULT_PUBLIC_PREFIX,
    runId: null,
    programId: null,
    deadline: DEFAULT_DEADLINE,
    mintAmount: DEFAULT_MINT_AMOUNT,
    inputs: { ...DEFAULT_INPUTS },
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--env") options.envFile = rest[++i];
    else if (arg === "--out-dir") options.outDir = rest[++i];
    else if (arg === "--publish-dir") options.publishDir = rest[++i];
    else if (arg === "--public-prefix") options.publicPrefix = rest[++i];
    else if (arg === "--run-id") options.runId = rest[++i];
    else if (arg === "--program-id") options.programId = rest[++i];
    else if (arg === "--deadline") options.deadline = rest[++i];
    else if (arg === "--mint-amount") options.mintAmount = rest[++i];
    else if (arg === "--input") {
      const [name, ...valueParts] = String(rest[++i] || "").split("=");
      if (!name || valueParts.length === 0) throw new Error("--input must use name=value");
      options.inputs[name] = valueParts.join("=");
    } else usage();
  }
  return options;
}

function pathsForOptions(options = {}) {
  const runId = safeName(options.runId || defaultRunId());
  const outDir = options.outDir || path.join(DEFAULT_OUT_ROOT, runId);
  const file = (name) => path.join(outDir, `${name}.json`);
  const taskFile = (name) => path.join(outDir, `${name}.tasc`);
  return {
    runId,
    outDir,
    file,
    taskFile,
  };
}

function taskSource(name, deadline) {
  return [
    `tasc ${name} {`,
    "  version \"0.1\"",
    "  reward 10 USDC",
    `  deadline ${deadline}`,
    "",
    "  input url string",
    "  output markdown string",
    "",
    "  verify {",
    "    min_words 120",
    "    contains_citation input.url",
    "    no_duplicate worker",
    "  }",
    "",
    "  payout {",
    "    pass -> worker",
    "    timeout -> buyer",
    "    dispute -> reviewers(3)",
    "  }",
    "}",
    "",
  ].join("\n");
}

function addressFromKeypairFile(file) {
  if (!fs.existsSync(file)) return null;
  const parsed = loadJson(file);
  assert(Array.isArray(parsed) && parsed.length === 64, `${file} must be a 64-byte Solana keypair`);
  return base58Encode(Buffer.from(parsed.slice(32)));
}

function resolveProgramId(options = {}, env = {}) {
  return options.programId
    || env.GLOBAL_TASC_SOLANA_PROGRAM_ID
    || addressFromKeypairFile(DEFAULT_PROGRAM_KEYPAIR)
    || DEFAULT_DEVNET_PROGRAM_ID;
}

function verifierAddress(env) {
  if (env.GLOBAL_TASC_SOLANA_VERIFIER_ADDRESS) return env.GLOBAL_TASC_SOLANA_VERIFIER_ADDRESS;
  return keypairForRole(env, "verifier").address;
}

function writeSignedTask(input) {
  const { env, name, deadline, now, outDir, programId, tokenMint, inputs } = input;
  const buyer = keypairForRole(env, "buyer");
  const taskFile = path.join(outDir, `${name}.tasc`);
  writeText(taskFile, taskSource(name, deadline));
  const { intent } = createSolanaIntent(taskFile, {
    buyer: buyer.address,
    verifier: verifierAddress(env),
    programId,
    tokenMint,
    now,
    inputs,
  });
  const signed = signSolanaIntent(intent, buyer);
  const intentFile = path.join(outDir, `${name}.intent.json`);
  const signatureFile = path.join(outDir, `${name}.signature.json`);
  writeJson(intentFile, intent);
  writeJson(signatureFile, signed);
  return {
    task_file: taskFile,
    intent_file: intentFile,
    signature_file: signatureFile,
    task_hash: intent.message.task_hash,
    deadline_unix: intent.message.deadline_unix,
  };
}

function enableSubguards() {
  for (const [key, value] of Object.entries(SUBGUARDS)) process.env[key] = value;
}

function plan(rawOptions = {}) {
  const options = { ...rawOptions };
  const paths = pathsForOptions(options);
  const outDir = resolveInsideRoot(paths.outDir, "out dir");
  const publishDir = resolveInsideRoot(options.publishDir || DEFAULT_PUBLISH_DIR, "publish dir");
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE, {});
  return {
    ok: true,
    mode: "plan",
    sends_transactions: false,
    guard_for_live_run: `${ALLOW_ENV}=1`,
    subguards_enabled_by_run: Object.keys(SUBGUARDS),
    no_new_dependencies: true,
    env_file: path.resolve(options.envFile || DEFAULT_ENV_FILE),
    rpc_host: new URL(env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL).host,
    rpc_url_printed: false,
    output_dir: path.relative(ROOT, outDir),
    output_dir_gitignored: path.relative(ROOT, outDir).startsWith(DEFAULT_OUT_ROOT),
    publish_dir: path.relative(ROOT, publishDir),
    claimable_feed_file: path.relative(ROOT, path.join(publishDir, "claimable-feed.json")),
    claimable_index_file: path.relative(ROOT, path.join(publishDir, "active.claimable.index.json")),
    public_claimable_index_file: publicPath(options.publicPrefix || DEFAULT_PUBLIC_PREFIX, "active.claimable.index.json"),
    task_deadline: options.deadline || DEFAULT_DEADLINE,
    mint_amount: String(options.mintAmount || DEFAULT_MINT_AMOUNT),
    live_run_writes: [
      "fresh setup and active .tasc files",
      "signed Solana intents",
      "SPL setup transaction evidence",
      "SPL fund transaction evidence",
      "read-only funding scan evidence",
      "claimable index JSON",
      "web/feed/claimable-feed.json",
    ],
    live_run_leaves_task_status: "Funded",
    key_material_printed: false,
  };
}

function writeClaimableFeed(input) {
  const { publishDir, publicPrefix, index, sourceIndexFile, runId, generatedAt, active } = input;
  const activeIndexName = "active.claimable.index.json";
  const summaryName = "claimable-feed.json";
  const activeIndexFile = path.join(publishDir, activeIndexName);
  const summaryFile = path.join(publishDir, summaryName);
  writeJson(activeIndexFile, index);
  const summary = {
    ok: true,
    kind: "tasc.solana-devnet.proof",
    version: "0.1",
    mode: "static-claimable-feed",
    generated_at: generatedAt,
    generated_by: "bin/publish-beta-claimable.js",
    run_id: runId,
    static_feed: {
      public_prefix: publicPrefix,
      files: [
        {
          branch: "active",
          role: "claimable",
          source: path.relative(ROOT, sourceIndexFile),
          path: publicPath(publicPrefix, activeIndexName),
          sha256: sha256Hex(activeIndexFile),
          bytes: fs.statSync(activeIndexFile).size,
          entries: index.entries.length,
          statuses: Array.from(new Set(index.entries.map((entry) => entry.status))).sort(),
        },
      ],
      no_secrets: true,
      no_new_dependencies: true,
    },
    branches: {
      active: {
        claimable_index_file: publicPath(publicPrefix, activeIndexName),
      },
    },
    active_task: active,
  };
  writeJson(summaryFile, summary);
  return { activeIndexFile, summaryFile, summary };
}

async function run(rawOptions = {}) {
  const options = { ...rawOptions };
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE);
  assert(env[ALLOW_ENV] === "1", `refusing live publish without ${ALLOW_ENV}=1`);
  enableSubguards();

  const paths = pathsForOptions(options);
  const outDir = resolveInsideRoot(paths.outDir, "out dir");
  const publishDir = resolveInsideRoot(options.publishDir || DEFAULT_PUBLISH_DIR, "publish dir");
  const programId = resolveProgramId(options, env);
  const setupNow = nowUnix();

  const setupSigned = writeSignedTask({
    env,
    name: `${paths.runId}_setup`,
    deadline: "10m",
    now: setupNow,
    outDir,
    programId,
    tokenMint: SYSTEM_PROGRAM_ID,
    inputs: options.inputs || DEFAULT_INPUTS,
  });
  const setupFile = paths.file("setup.live");
  const setup = await splSetup.send({
    envFile: options.envFile || DEFAULT_ENV_FILE,
    signedFile: setupSigned.signature_file,
    out: setupFile,
    mintAmount: String(options.mintAmount || DEFAULT_MINT_AMOUNT),
  });

  const activeSigned = writeSignedTask({
    env,
    name: `${paths.runId}_active`,
    deadline: options.deadline || DEFAULT_DEADLINE,
    now: nowUnix(),
    outDir,
    programId,
    tokenMint: setup.mint,
    inputs: options.inputs || DEFAULT_INPUTS,
  });
  const fundFile = paths.file("active.fund-spl.live");
  const fund = await sendSpl({
    envFile: options.envFile || DEFAULT_ENV_FILE,
    signedFile: activeSigned.signature_file,
    splSetupFile: setupFile,
    out: fundFile,
  });

  const accountFile = paths.file("active.task-account.live");
  const fundingFile = paths.file("active.funding.live");
  await fundingScan.scan({
    envFile: options.envFile || DEFAULT_ENV_FILE,
    signedFile: activeSigned.signature_file,
    accountOut: accountFile,
    out: fundingFile,
    signature: fund.signature,
    instructionIndex: fund.fund_instruction_index,
    confirmationStatus: fund.confirmation_status,
    custodyAccount: fund.vault_token_account,
    custodyInstructionIndex: fund.transfer_instruction_index,
    custodyDecimals: fund.token_decimals,
  });

  const indexFile = paths.file("active.claimable.index");
  const admitted = admit(activeSigned.signature_file, fundingFile, indexFile);
  assert(admitted.index.entries.length === 1, "active claimable index should contain one entry");
  const activeEntry = admitted.index.entries[0];
  assert(activeEntry.status === "claimable", "active task must be claimable");

  const published = writeClaimableFeed({
    publishDir,
    publicPrefix: options.publicPrefix || DEFAULT_PUBLIC_PREFIX,
    index: admitted.index,
    sourceIndexFile: indexFile,
    runId: paths.runId,
    generatedAt: new Date().toISOString(),
    active: {
      task_hash: activeEntry.task_hash,
      task_account: activeEntry.settlement.task_pda,
      vault: activeEntry.settlement.vault,
      amount: activeEntry.amount,
      deadline_unix: activeEntry.deadline_unix,
      token_mint: activeEntry.token_mint,
      funding_signature: activeEntry.funding.signature,
    },
  });

  return {
    ok: true,
    mode: "run",
    sends_transactions: true,
    run_id: paths.runId,
    out_dir: path.relative(ROOT, outDir),
    claimable_feed_file: path.relative(ROOT, published.summaryFile),
    claimable_index_file: path.relative(ROOT, published.activeIndexFile),
    setup_signature: setup.signature,
    fund_signature: fund.signature,
    task_hash: activeEntry.task_hash,
    task_account: activeEntry.settlement.task_pda,
    vault: activeEntry.settlement.vault,
    deadline_unix: activeEntry.deadline_unix,
    amount: activeEntry.amount,
    status: activeEntry.status,
    key_material_printed: false,
    no_new_dependencies: true,
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(plan(options), null, 2)}\n`);
    return;
  }
  if (command === "run") {
    process.stdout.write(`${JSON.stringify(await run(options), null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`publish-beta-claimable: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  ALLOW_ENV,
  plan,
  run,
  writeClaimableFeed,
};
