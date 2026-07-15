#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ENV_FILE = ".env.solana-devnet.local";
const ALLOW_ENV = "GLOBAL_TASC_ALLOW_SOLANA_DEPLOY";
const PROGRAM_SO = "build/solana/global_tasc_solana_program.so";
const PROGRAM_KEYPAIR = "build/solana/global_tasc_solana_program-keypair.json";
const DEFAULT_PAYER_KEYPAIR = path.join(os.homedir(), ".config", "solana", "id.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
    ...options,
  });
  return {
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error ? result.error.message : null,
  };
}

function commandExists(command) {
  return run("which", [command]).status === 0;
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

function publicKeyFor(keypair) {
  if (!commandExists("solana-keygen") || !fs.existsSync(keypair)) return null;
  const result = run("solana-keygen", ["pubkey", keypair]);
  return result.status === 0 ? result.stdout : null;
}

function deployArgs(rpcUrl, payerKeypair) {
  return [
    "program",
    "deploy",
    PROGRAM_SO,
    "--program-id",
    PROGRAM_KEYPAIR,
    "--keypair",
    payerKeypair,
    "--url",
    rpcUrl,
    "--output",
    "json",
  ];
}

function readiness(env) {
  const rpcUrl = env.SOLANA_DEVNET_RPC_URL || "devnet";
  const payerKeypair = env.SOLANA_DEVNET_PAYER_KEYPAIR || DEFAULT_PAYER_KEYPAIR;
  const missing = [];

  if (!commandExists("solana")) missing.push("solana CLI not found");
  if (!fs.existsSync(PROGRAM_SO)) missing.push(`${PROGRAM_SO} not found; run npm run solana:build-sbf`);
  if (!fs.existsSync(PROGRAM_KEYPAIR)) missing.push(`${PROGRAM_KEYPAIR} not found; run npm run solana:build-sbf`);
  if (!fs.existsSync(payerKeypair)) missing.push(`${payerKeypair} payer keypair not found`);

  return {
    ready: missing.length === 0,
    missing,
    rpc_url_configured: Boolean(env.SOLANA_DEVNET_RPC_URL),
    rpc_value_printed: false,
    payer_keypair: payerKeypair,
    payer_address: publicKeyFor(payerKeypair),
    program_artifact: PROGRAM_SO,
    program_keypair: PROGRAM_KEYPAIR,
    program_id: publicKeyFor(PROGRAM_KEYPAIR),
    deploy_guard: `${ALLOW_ENV}=1`,
    command_preview: `solana ${deployArgs("<SOLANA_DEVNET_RPC_URL_OR_DEVNET>", payerKeypair).join(" ")}`,
    rpcUrl,
    payerKeypair,
  };
}

function printPlan(state) {
  const { rpcUrl, payerKeypair, ...safeState } = state;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: "plan",
    ...safeState,
    next: state.ready
      ? `Set ${ALLOW_ENV}=1 and run npm run solana:deploy only after approving a devnet deploy.`
      : "Resolve missing prerequisites first.",
  }, null, 2)}\n`);
}

function deploy(state, env) {
  assert(state.ready, `not ready to deploy: ${state.missing.join("; ")}`);
  assert(env[ALLOW_ENV] === "1", `refusing to deploy without ${ALLOW_ENV}=1`);

  fs.chmodSync(PROGRAM_KEYPAIR, 0o600);
  const result = run("solana", deployArgs(state.rpcUrl, state.payerKeypair), {
    env: {
      ...process.env,
      ...env,
    },
  });
  assert(result.status === 0, `solana deploy failed: ${result.stderr || result.stdout || result.error || "unknown error"}`);

  let solanaOutput = null;
  if (result.stdout) {
    try {
      solanaOutput = JSON.parse(result.stdout);
    } catch {
      solanaOutput = { raw: result.stdout };
    }
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: "deploy",
    program_artifact: PROGRAM_SO,
    program_id: state.program_id,
    payer_address: state.payer_address,
    rpc_value_printed: false,
    solana_output: solanaOutput,
  }, null, 2)}\n`);
}

function main() {
  const mode = process.argv[2] || "plan";
  assert(["plan", "deploy"].includes(mode), "usage: deploy-solana-program.js <plan|deploy>");

  const env = { ...loadEnvFile(ENV_FILE), ...process.env };
  const state = readiness(env);
  if (mode === "plan") {
    printPlan(state);
    return;
  }
  deploy(state, env);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`deploy-solana-program: ${error.message}`);
    process.exit(1);
  }
}
