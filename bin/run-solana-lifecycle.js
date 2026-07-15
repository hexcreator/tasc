#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { taskHashToBytes32 } = require("./tascintent");
const { verifyCompiledTask } = require("./tascverify");
const { compile } = require("./tasclang");
const {
  DEFAULT_RPC_URL,
  assertBase58Address,
  encodeSignedTransaction,
  keypairForRole,
  mergedEnv,
  pollSignature,
  rpcCall,
  signSolanaMessage,
} = require("./run-solana-devnet");
const { fundAddresses, compileLegacyMessage } = require("./run-solana-fund");
const { encodeInstruction } = require("./tascsolana-program");
const { verifySignedSolanaIntent } = require("./tascsolana");

const DEFAULT_ENV_FILE = ".env.solana-devnet.local";
const DEFAULT_SIGNED_INTENT = "examples/solana-devnet/summarize_url_spl.signature.json";
const DEFAULT_SUBMISSION = "examples/submissions/summarize_url.pass.md";
const DEFAULT_LEDGER = "examples/ledger.json";
const DEFAULT_INPUT = "url=https://docs.cdp.coinbase.com/x402/welcome";
const PLACEHOLDER_SIGNER = "11111111111111111111111111111111";
const ALLOW = {
  claim: "GLOBAL_TASC_ALLOW_SOLANA_CLAIM",
  attest: "GLOBAL_TASC_ALLOW_SOLANA_ATTEST",
  release: "GLOBAL_TASC_ALLOW_SOLANA_RELEASE",
  refund: "GLOBAL_TASC_ALLOW_SOLANA_REFUND",
};

function usage() {
  console.error([
    "Usage:",
    "  node bin/run-solana-lifecycle.js plan-claim [signed-solana-intent.json] [--env file] [--task-account address] [--signer address]",
    "  node bin/run-solana-lifecycle.js send-claim [signed-solana-intent.json] [--env file] [--task-account address] [--out file]",
    "  node bin/run-solana-lifecycle.js plan-attest [signed-solana-intent.json] [--env file] [--task-account address] [--signer address] [--verdict pass|fail] [--result-hash 0x...]",
    "  node bin/run-solana-lifecycle.js send-attest [signed-solana-intent.json] [--env file] [--task-account address] [--verdict pass|fail] [--result-hash 0x...] [--out file]",
    "  node bin/run-solana-lifecycle.js plan-release [signed-solana-intent.json] [--env file] [--task-account address] [--signer address]",
    "  node bin/run-solana-lifecycle.js send-release [signed-solana-intent.json] [--env file] [--task-account address] [--out file]",
    "  node bin/run-solana-lifecycle.js plan-refund [signed-solana-intent.json] [--env file] [--task-account address] [--signer address]",
    "  node bin/run-solana-lifecycle.js send-refund [signed-solana-intent.json] [--env file] [--task-account address] [--out file]",
    "",
    "send-* commands are guarded by GLOBAL_TASC_ALLOW_SOLANA_<ACTION>=1.",
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

function parseOptions(rest) {
  const options = {
    envFile: DEFAULT_ENV_FILE,
    signedFile: DEFAULT_SIGNED_INTENT,
    taskAccount: null,
    signer: null,
    out: null,
    verdict: null,
    resultHash: null,
    submission: DEFAULT_SUBMISSION,
    ledger: DEFAULT_LEDGER,
    inputs: {},
  };
  const args = [...rest];
  if (args[0] && !args[0].startsWith("--")) options.signedFile = args.shift();
  const defaults = [DEFAULT_INPUT];
  for (const item of defaults) {
    const [name, ...valueParts] = item.split("=");
    options.inputs[name] = valueParts.join("=");
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = args[++i];
    else if (arg === "--task-account") options.taskAccount = args[++i];
    else if (arg === "--signer") options.signer = args[++i];
    else if (arg === "--out") options.out = args[++i];
    else if (arg === "--verdict") options.verdict = args[++i];
    else if (arg === "--result-hash") options.resultHash = args[++i];
    else if (arg === "--submission") options.submission = args[++i];
    else if (arg === "--ledger") options.ledger = args[++i];
    else if (arg === "--input") {
      const next = args[++i];
      const [name, ...valueParts] = String(next || "").split("=");
      assert(name && valueParts.length > 0, "--input must be name=value");
      options.inputs[name] = valueParts.join("=");
    } else usage();
  }
  return options;
}

function loadSignedIntent(file) {
  const signed = loadJson(file);
  const signatureCheck = verifySignedSolanaIntent(signed);
  assert(signatureCheck.ok, "signed Solana intent signature is invalid");
  return signed;
}

function resultHashFromLocalVerification(signed, options) {
  if (options.resultHash) return assertBytes32(options.resultHash, "result_hash");
  const compiled = compile(fs.readFileSync(signed.intent.task_file, "utf8"));
  const submission = fs.readFileSync(options.submission, "utf8");
  const attestation = verifyCompiledTask(compiled, submission, options.inputs, options.ledger);
  if (options.verdict) {
    assert(attestation.verdict === options.verdict, `local attestation verdict ${attestation.verdict} did not match --verdict ${options.verdict}`);
  }
  return taskHashToBytes32(attestation.result_hash);
}

function assertBytes32(value, label) {
  const raw = String(value || "").toLowerCase();
  assert(/^0x[a-f0-9]{64}$/.test(raw), `${label} must be bytes32 hex`);
  return raw;
}

function signerRoleForAction(action) {
  if (action === "claim") return "worker";
  if (action === "attest") return "verifier";
  if (action === "refund") return "buyer";
  return "worker";
}

function expectedSignerForPlan(action, signed) {
  if (action === "attest") return signed.intent.message.verifier;
  if (action === "refund") return signed.intent.message.buyer;
  return null;
}

function instructionForAction(action, signed, options = {}) {
  const message = signed.intent.message;
  const taskAccount = assertBase58Address(options.taskAccount || fundAddresses(message).task_account, "task_account");
  if (action === "attest") {
    const verdict = String(options.verdict || "pass").toLowerCase();
    assert(verdict === "pass" || verdict === "fail", "verdict must be pass or fail");
    return {
      name: "attest",
      task_account: taskAccount,
      data: encodeInstruction("attest", {
        verdict,
        result_hash: resultHashFromLocalVerification(signed, options),
      }),
      verdict,
    };
  }
  return {
    name: action,
    task_account: taskAccount,
    data: encodeInstruction(action),
  };
}

function accountMeta(pubkey, signer, writable) {
  return { pubkey, signer: Boolean(signer), writable: Boolean(writable) };
}

function buildLifecycleInstruction(action, signed, signerAddress, options = {}) {
  const message = signed.intent.message;
  const instruction = instructionForAction(action, signed, options);
  return {
    action,
    signer_role: signerRoleForAction(action),
    signer: signerAddress,
    program_id: message.program_id,
    task_account: instruction.task_account,
    accounts: [
      accountMeta(signerAddress, true, true),
      accountMeta(instruction.task_account, false, true),
    ],
    data: instruction.data,
    data_hex: `0x${instruction.data.toString("hex")}`,
    verdict: instruction.verdict || null,
  };
}

function planAction(action, options = {}) {
  const signed = loadSignedIntent(options.signedFile);
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE, {});
  let signerAddress = null;
  try {
    signerAddress = keypairForRole(env, signerRoleForAction(action)).address;
  } catch {
    signerAddress = env[`GLOBAL_TASC_SOLANA_${signerRoleForAction(action).toUpperCase()}_ADDRESS`] || null;
  }
  const explicitSigner = options.signer ? assertBase58Address(options.signer, "signer") : null;
  const intentSigner = expectedSignerForPlan(action, signed);
  const signerForPlan = explicitSigner || signerAddress || intentSigner || PLACEHOLDER_SIGNER;
  const signerSource = explicitSigner
    ? "option"
    : signerAddress
      ? "local_env"
      : intentSigner
        ? "signed_intent"
        : "placeholder";
  const instruction = buildLifecycleInstruction(action, signed, signerForPlan, options);
  return {
    ok: true,
    mode: `plan-${action}`,
    signed_intent: options.signedFile,
    env_file: path.resolve(options.envFile || DEFAULT_ENV_FILE),
    sends_transactions: false,
    guard_for_send: `${ALLOW[action]}=1`,
    cluster: signed.intent.message.cluster,
    program_id: signed.intent.message.program_id,
    task_account: instruction.task_account,
    signer_role: signerRoleForAction(action),
    local_signer: signerAddress,
    signer_for_plan: signerForPlan,
    signer_source: signerSource,
    signer_placeholder_used: signerSource === "placeholder",
    instruction: {
      name: instruction.action,
      data_hex: instruction.data_hex,
      accounts: instruction.accounts.map(({ pubkey, signer, writable }) => ({ pubkey, signer, writable })),
      verdict: instruction.verdict,
    },
    token_movement: action === "release" || action === "refund"
      ? "not yet: this transition updates task-account status; SPL vault transfer CPI is still the next protocol step"
      : "none",
  };
}

async function sendAction(action, options = {}) {
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE);
  const rpcUrl = env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL;
  const signed = loadSignedIntent(options.signedFile);
  const signer = keypairForRole(env, signerRoleForAction(action));
  assert(env[ALLOW[action]] === "1", `refusing to send without ${ALLOW[action]}=1`);
  const lifecycle = buildLifecycleInstruction(action, signed, signer.address, options);
  const latest = await rpcCall(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const compiled = compileLegacyMessage({
    payer: signer.address,
    recentBlockhash: latest.value.blockhash,
    instructions: [
      {
        name: action,
        programId: lifecycle.program_id,
        accounts: lifecycle.accounts,
        data: lifecycle.data,
      },
    ],
  });
  const signature = signSolanaMessage(compiled.message, signer.seed);
  const encoded = encodeSignedTransaction(compiled.message, signature);
  const txSignature = await rpcCall(rpcUrl, "sendTransaction", [
    encoded,
    {
      encoding: "base64",
      preflightCommitment: "confirmed",
    },
  ]);
  const status = await pollSignature(rpcUrl, txSignature);
  const result = {
    ok: true,
    mode: `send-${action}`,
    rpc_host: new URL(rpcUrl).host,
    cluster: signed.intent.message.cluster,
    program_id: lifecycle.program_id,
    task_account: lifecycle.task_account,
    signer_role: signerRoleForAction(action),
    signer: signer.address,
    instruction_data_hex: lifecycle.data_hex,
    signature: txSignature,
    confirmation_status: status ? status.confirmationStatus : "pending",
    token_movement: action === "release" || action === "refund" ? "not yet implemented" : "none",
    key_material_printed: false,
  };
  if (options.out) writeJson(options.out, result);
  return result;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  const match = /^(plan|send)-(claim|attest|release|refund)$/.exec(command || "");
  if (!match) usage();
  const [, mode, action] = match;
  if (mode === "plan") {
    process.stdout.write(`${JSON.stringify(planAction(action, options), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(await sendAction(action, options), null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`run-solana-lifecycle: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  ALLOW,
  buildLifecycleInstruction,
  instructionForAction,
  planAction,
  sendAction,
  signerRoleForAction,
};
