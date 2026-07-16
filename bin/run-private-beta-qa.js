#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  validateEvidence,
  verifySolanaRpcEvidence,
} = require("./validate-private-beta-qa-evidence");

const DEFAULT_RPC_HINT = "https://api.devnet.solana.com";
const CONFIRMATION_ORDER = new Set(["processed", "confirmed", "finalized"]);

function usage() {
  console.error([
    "Usage:",
    "  node bin/run-private-beta-qa.js",
    "  node bin/run-private-beta-qa.js <evidence.json> --solana-rpc-url <url> [options]",
    "",
    "Options:",
    "  --solana-rpc-url <url>       Solana RPC URL for signature/account verification",
    "  --min-confirmation <status>  processed, confirmed, or finalized; default confirmed",
    "  --offline                    schema-only local check; not a final wallet QA pass",
    "  --help                       show this help",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expandHome(file) {
  if (file === "~") return os.homedir();
  if (typeof file === "string" && file.startsWith("~/")) return path.join(os.homedir(), file.slice(2));
  return file;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseArgs(argv) {
  const options = {
    file: "",
    solanaRpcUrl: process.env.SOLANA_RPC_URL || "",
    minConfirmation: "confirmed",
    offline: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    else if (arg === "--solana-rpc-url") {
      options.solanaRpcUrl = argv[++i] || "";
      if (!options.solanaRpcUrl) usage();
    } else if (arg === "--min-confirmation") {
      options.minConfirmation = argv[++i] || "";
      if (!CONFIRMATION_ORDER.has(options.minConfirmation)) usage();
    } else if (arg === "--offline" || arg === "--skip-solana-rpc") {
      options.offline = true;
    } else if (!options.file) {
      options.file = arg;
    } else {
      usage();
    }
  }

  return options;
}

function runbook(options) {
  const rpcUrl = options.solanaRpcUrl || DEFAULT_RPC_HINT;
  return {
    ok: true,
    kind: "tasc.private_beta.qa_runbook",
    start_command: "npm run beta:local",
    final_validation_command: [
      "npm run beta:qa -- ~/Downloads/tasc-private-beta-qa.json",
      `--solana-rpc-url ${rpcUrl}`,
      `--min-confirmation ${options.minConfirmation}`,
    ].join(" "),
    offline_schema_check_command: "npm run beta:qa -- ~/Downloads/tasc-private-beta-qa.json --offline",
    wallet_qa_steps: [
      "Start the local beta session and open the printed app_url in a browser with Phantom or Solflare on devnet.",
      "Load Devnet Proof, connect the expected role wallet, refresh live Solana status, and enable guarded wallet sends.",
      "Capture the worker proof, submit it to the verifier API, then use the verifier result for attest and release/refund.",
      "Wait for the readiness panel to show strict QA evidence ready, then export the QA evidence JSON.",
      "Run the final validation command against the exported JSON before counting the wallet QA pass.",
    ],
    final_requires: {
      wallet_send: true,
      verifier_ingestion: true,
      worker_submission: true,
      live_account: true,
      solana_rpc: true,
    },
    no_new_dependencies: true,
  };
}

async function validateQaEvidence(options) {
  assert(options.file, "evidence file is required");
  const evidencePath = path.resolve(expandHome(options.file));
  assert(fs.existsSync(evidencePath), `evidence file not found: ${options.file}`);
  if (!options.offline) {
    assert(
      options.solanaRpcUrl,
      "--solana-rpc-url is required for a final private beta wallet QA pass; use --offline only for local schema checks",
    );
  }

  const payload = readJson(evidencePath);
  const strictOptions = {
    requireWalletSend: true,
    requireVerifierIngestion: true,
    requireWorkerSubmission: true,
    requireLiveAccount: true,
    allowEmptyFeed: false,
    solanaRpcUrl: options.offline ? "" : options.solanaRpcUrl,
    minConfirmation: options.minConfirmation,
  };
  const counts = validateEvidence(payload, strictOptions);
  const solanaRpc = options.offline ? null : await verifySolanaRpcEvidence(payload, strictOptions);

  return {
    ok: true,
    kind: "tasc.private_beta.qa_validation",
    evidence: path.relative(process.cwd(), evidencePath),
    mode: options.offline ? "offline_schema_check" : "final_wallet_qa",
    ready_for_private_beta_wallet_qa: !options.offline,
    generated_at: payload.generated_at,
    counts,
    strict_requirements: {
      wallet_send: true,
      verifier_ingestion: true,
      worker_submission: true,
      live_account: true,
      solana_rpc: !options.offline,
      minimum_confirmation: options.minConfirmation,
    },
    solana_rpc: solanaRpc,
    verifier_token: "redacted",
    no_new_dependencies: true,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.file ? await validateQaEvidence(options) : runbook(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`run-private-beta-qa: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runbook,
  validateQaEvidence,
};
