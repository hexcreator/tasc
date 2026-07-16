#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { base58Decode, base58Encode } = require("./run-solana-devnet");
const { verifySignedSolanaIntent } = require("./tascsolana");
const {
  TOKEN_PROGRAM_ID,
  decodeTokenAccountData,
  encodeTokenAccount,
} = require("./tascsolana-spl");
const { validateProductionPayout } = require("./validate-real-money-readiness");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = ".tascverifier/production-payout-evidence.json";
const DEFAULT_CLUSTER = "solana-mainnet-beta";
const DEFAULT_AMOUNT_BASE_UNITS = "10000000";
const TARGET_MS = 60_000;
const TEST_NETWORK_RE = /(devnet|testnet|sepolia|local|mock|fixture|example)/i;

function usage() {
  console.error([
    "Usage:",
    "  node bin/build-production-payout-evidence.js plan [options]",
    "  node bin/build-production-payout-evidence.js build [options]",
    "  node bin/build-production-payout-evidence.js --self-test",
    "",
    "Build options:",
    "  --out <file>                              output evidence file; default .tascverifier/production-payout-evidence.json",
    "  --generated-at <iso>                      evidence timestamp; default now",
    "  --cluster <name>                          Solana cluster; default solana-mainnet-beta",
    "  --signed-intent <file>                    signed production intent; fills program/task/buyer/verifier/deadline/nonce",
    "  --program-id <address>                    deployed mainnet Global Tasc program id",
    "  --token-mint <address>                    production USDC mint address",
    "  --amount-base-units <n>                   amount in 6-decimal USDC base units; default 10000000",
    "  --task-hash <0xbytes32>                   task hash from signed intent",
    "  --buyer <address>                         buyer wallet from signed intent",
    "  --worker <address>                        worker wallet that claimed and received release",
    "  --verifier <address>                      verifier wallet from signed intent",
    "  --deadline-unix <n>                       task deadline from signed intent",
    "  --nonce <n>                               task nonce from signed intent",
    "  --result-hash <0xbytes32>                 verifier result hash committed by attest",
    "  --task-account <address>                  production task account",
    "  --vault-token-account <address>           post-release vault token account",
    "  --destination-token-account <address>     worker destination token account",
    "  --fund-signature <signature>              mainnet fund transaction signature",
    "  --claim-signature <signature>             mainnet claim transaction signature",
    "  --attest-signature <signature>            mainnet attest transaction signature",
    "  --release-signature <signature>           mainnet release transaction signature",
    "  --claim-to-release-ms <n>                 measured claim start to release confirmation",
    "  --claim-to-completed-index-ms <n>         measured claim start to completed-index publication",
    "  --claim-started-at <iso>                  alternative timing source",
    "  --release-confirmed-at <iso>              alternative timing source",
    "  --completed-indexed-at <iso>              alternative timing source",
    "  --production-rpc-url <url>                optional mainnet RPC used only to read token balances",
    "  --min-confirmation <status>               commitment for balance reads; default finalized",
    "  --vault-balance-after <n>                 required without --production-rpc-url; must be 0",
    "  --destination-balance-after <n>           required without --production-rpc-url; must be >= 10000000",
    "",
    "This builder never accepts private keys and never sends transactions.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    command: "plan",
    out: DEFAULT_OUT,
    generatedAt: "",
    cluster: DEFAULT_CLUSTER,
    signedIntent: "",
    programId: "",
    tokenMint: "",
    amountBaseUnits: DEFAULT_AMOUNT_BASE_UNITS,
    taskHash: "",
    buyer: "",
    worker: "",
    verifier: "",
    deadlineUnix: "",
    nonce: "",
    resultHash: "",
    taskAccount: "",
    vaultTokenAccount: "",
    destinationTokenAccount: "",
    fundSignature: "",
    claimSignature: "",
    attestSignature: "",
    releaseSignature: "",
    claimToReleaseMs: "",
    claimToCompletedIndexMs: "",
    claimStartedAt: "",
    releaseConfirmedAt: "",
    completedIndexedAt: "",
    productionRpcUrl: "",
    minConfirmation: "finalized",
    vaultBalanceAfter: "",
    destinationBalanceAfter: "",
    selfTest: false,
  };
  const args = [...argv];
  if (args[0] === "plan" || args[0] === "build") options.command = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--out") options.out = requireValue(args, ++i, arg);
    else if (arg === "--generated-at") options.generatedAt = requireValue(args, ++i, arg);
    else if (arg === "--cluster") options.cluster = requireValue(args, ++i, arg);
    else if (arg === "--signed-intent") options.signedIntent = requireValue(args, ++i, arg);
    else if (arg === "--program-id") options.programId = requireValue(args, ++i, arg);
    else if (arg === "--token-mint") options.tokenMint = requireValue(args, ++i, arg);
    else if (arg === "--amount-base-units") options.amountBaseUnits = requireValue(args, ++i, arg);
    else if (arg === "--task-hash") options.taskHash = requireValue(args, ++i, arg);
    else if (arg === "--buyer") options.buyer = requireValue(args, ++i, arg);
    else if (arg === "--worker") options.worker = requireValue(args, ++i, arg);
    else if (arg === "--verifier") options.verifier = requireValue(args, ++i, arg);
    else if (arg === "--deadline-unix") options.deadlineUnix = requireValue(args, ++i, arg);
    else if (arg === "--nonce") options.nonce = requireValue(args, ++i, arg);
    else if (arg === "--result-hash") options.resultHash = requireValue(args, ++i, arg);
    else if (arg === "--task-account") options.taskAccount = requireValue(args, ++i, arg);
    else if (arg === "--vault-token-account") options.vaultTokenAccount = requireValue(args, ++i, arg);
    else if (arg === "--destination-token-account") options.destinationTokenAccount = requireValue(args, ++i, arg);
    else if (arg === "--fund-signature") options.fundSignature = requireValue(args, ++i, arg);
    else if (arg === "--claim-signature") options.claimSignature = requireValue(args, ++i, arg);
    else if (arg === "--attest-signature") options.attestSignature = requireValue(args, ++i, arg);
    else if (arg === "--release-signature") options.releaseSignature = requireValue(args, ++i, arg);
    else if (arg === "--claim-to-release-ms") options.claimToReleaseMs = requireValue(args, ++i, arg);
    else if (arg === "--claim-to-completed-index-ms") options.claimToCompletedIndexMs = requireValue(args, ++i, arg);
    else if (arg === "--claim-started-at") options.claimStartedAt = requireValue(args, ++i, arg);
    else if (arg === "--release-confirmed-at") options.releaseConfirmedAt = requireValue(args, ++i, arg);
    else if (arg === "--completed-indexed-at") options.completedIndexedAt = requireValue(args, ++i, arg);
    else if (arg === "--production-rpc-url") options.productionRpcUrl = requireValue(args, ++i, arg);
    else if (arg === "--min-confirmation") options.minConfirmation = requireValue(args, ++i, arg);
    else if (arg === "--vault-balance-after") options.vaultBalanceAfter = requireValue(args, ++i, arg);
    else if (arg === "--destination-balance-after") options.destinationBalanceAfter = requireValue(args, ++i, arg);
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  return options;
}

function requireValue(args, index, label) {
  const value = args[index] || "";
  if (!value) throw new Error(`${label} requires a value`);
  return value;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertString(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} is required`);
  return value;
}

function assertIso(value, label) {
  assertString(value, label);
  assert(Number.isFinite(Date.parse(value)), `${label} must be an ISO timestamp`);
  return value;
}

function assertBaseUnits(value, label) {
  const raw = String(value || "");
  assert(/^[0-9]+$/.test(raw), `${label} must be integer base units`);
  return BigInt(raw);
}

function assertExactTenUsdc(value, label) {
  const parsed = assertBaseUnits(value, label);
  assert(parsed === BigInt(DEFAULT_AMOUNT_BASE_UNITS), `${label} must be exactly 10000000 for the $10 MVP gate`);
  return parsed;
}

function assertU64(value, label) {
  const raw = String(value || "");
  assert(/^[0-9]+$/.test(raw), `${label} must be a u64 integer string`);
  const parsed = BigInt(raw);
  assert(parsed >= 0n && parsed <= ((1n << 64n) - 1n), `${label} exceeds u64`);
  return parsed;
}

function assertBytes32(value, label) {
  const text = assertString(value, label);
  assert(/^0x[a-fA-F0-9]{64}$/.test(text), `${label} must be bytes32 hex`);
  return text.toLowerCase();
}

function assertSolanaAddress(value, label) {
  const text = assertString(value, label);
  assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text), `${label} must be a Solana base58 address`);
  const decoded = base58Decode(text);
  assert(decoded.length === 32, `${label} must decode to 32 bytes`);
  return text;
}

function assertSolanaSignature(value, label) {
  const text = assertString(value, label);
  assert(/^[1-9A-HJ-NP-Za-km-z]{40,100}$/.test(text), `${label} must look like a Solana signature`);
  const decoded = base58Decode(text);
  assert(decoded.length === 64, `${label} must decode to a 64-byte Solana signature`);
  return text;
}

function assertHttpUrl(value, label) {
  const raw = assertString(value, label);
  const url = new URL(raw);
  assert(url.protocol === "http:" || url.protocol === "https:", `${label} must be http(s)`);
  return raw;
}

function rpcHost(rpcUrl) {
  return new URL(rpcUrl).host;
}

function readSignedIntent(file, cluster) {
  if (!file) return null;
  const signed = loadJson(path.resolve(file));
  const verified = verifySignedSolanaIntent(signed);
  assert(verified.ok === true, "signed_intent signature is invalid");
  const message = signed.intent && signed.intent.message || {};
  assert(message.cluster === cluster, "signed_intent cluster mismatch");
  return {
    signed_intent_hash: signed.intent_hash || null,
    signer: verified.signer,
    programId: message.program_id,
    taskHash: message.task_hash,
    buyer: message.buyer,
    verifier: message.verifier,
    tokenMint: message.token_mint,
    amountBaseUnits: String(message.amount),
    deadlineUnix: String(message.deadline_unix),
    nonce: String(message.nonce),
  };
}

function resolvedField(explicitValue, derivedValue, label) {
  if (explicitValue && derivedValue) {
    assert(String(explicitValue) === String(derivedValue), `${label} does not match signed_intent`);
  }
  return explicitValue || derivedValue || "";
}

function parseIntegerMs(value, label) {
  assert(/^[0-9]+$/.test(String(value || "")), `${label} must be a nonnegative integer`);
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed), `${label} exceeds safe integer range`);
  return parsed;
}

function deriveTiming(options) {
  let claimToReleaseMs;
  let claimToCompletedIndexMs;

  if (options.claimToReleaseMs || options.claimToCompletedIndexMs) {
    assert(options.claimToReleaseMs, "claim_to_release_ms is required when using explicit timing");
    assert(options.claimToCompletedIndexMs, "claim_to_completed_index_ms is required when using explicit timing");
    claimToReleaseMs = parseIntegerMs(options.claimToReleaseMs, "claim_to_release_ms");
    claimToCompletedIndexMs = parseIntegerMs(options.claimToCompletedIndexMs, "claim_to_completed_index_ms");
  } else {
    assert(options.claimStartedAt && options.releaseConfirmedAt && options.completedIndexedAt, "timing requires either explicit ms values or claim/release/completed ISO timestamps");
    const claimStartedAt = Date.parse(assertIso(options.claimStartedAt, "claim_started_at"));
    const releaseConfirmedAt = Date.parse(assertIso(options.releaseConfirmedAt, "release_confirmed_at"));
    const completedIndexedAt = Date.parse(assertIso(options.completedIndexedAt, "completed_indexed_at"));
    claimToReleaseMs = releaseConfirmedAt - claimStartedAt;
    claimToCompletedIndexMs = completedIndexedAt - claimStartedAt;
  }

  assert(Number.isInteger(claimToReleaseMs) && claimToReleaseMs >= 0, "claim_to_release_ms must be nonnegative");
  assert(Number.isInteger(claimToCompletedIndexMs) && claimToCompletedIndexMs >= claimToReleaseMs, "claim_to_completed_index_ms must be >= claim_to_release_ms");
  assert(claimToReleaseMs <= TARGET_MS, "claim-to-release exceeded 60 seconds");
  assert(claimToCompletedIndexMs <= TARGET_MS, "claim-to-completed-index exceeded 60 seconds");
  return {
    target_ms: TARGET_MS,
    claim_to_release_ms: claimToReleaseMs,
    claim_to_completed_index_ms: claimToCompletedIndexMs,
    under_60s_to_release_confirmation: true,
    under_60s_to_completed_index: true,
  };
}

async function defaultRpcCall(rpcUrl, method, params) {
  assert(typeof fetch === "function", "global fetch is required for Solana RPC balance reads");
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "Solana RPC error");
  return payload.result;
}

async function fetchTokenAccount(rpcUrl, pubkey, options, rpcCall) {
  const result = await rpcCall(rpcUrl, "getAccountInfo", [
    pubkey,
    {
      commitment: options.minConfirmation,
      encoding: "base64",
    },
  ]);
  const value = result && result.value;
  assert(value, `production token account ${pubkey} not found`);
  assert(value.owner === TOKEN_PROGRAM_ID, `production token account ${pubkey} must be owned by SPL Token Program`);
  assert(Array.isArray(value.data) && value.data[1] === "base64", `production token account ${pubkey} must return base64 data`);
  return decodeTokenAccountData(value.data[0]);
}

async function resolveBalances(options, rpcCall) {
  if (!options.productionRpcUrl) {
    assert(options.vaultBalanceAfter, "vault_balance_after is required without --production-rpc-url");
    assert(options.destinationBalanceAfter, "destination_balance_after is required without --production-rpc-url");
    return {
      vault_balance_after: String(assertBaseUnits(options.vaultBalanceAfter, "vault_balance_after")),
      destination_balance_after: String(assertBaseUnits(options.destinationBalanceAfter, "destination_balance_after")),
      source: {
        calls_rpc: false,
        rpc_host: null,
      },
    };
  }

  assertHttpUrl(options.productionRpcUrl, "production_rpc_url");
  const vault = await fetchTokenAccount(options.productionRpcUrl, options.vaultTokenAccount, options, rpcCall);
  const destination = await fetchTokenAccount(options.productionRpcUrl, options.destinationTokenAccount, options, rpcCall);
  assert(vault.mint === options.tokenMint, "vault token account mint does not match token_mint");
  assert(destination.mint === options.tokenMint, "destination token account mint does not match token_mint");
  if (options.vaultBalanceAfter) {
    assert(vault.amount === String(assertBaseUnits(options.vaultBalanceAfter, "vault_balance_after")), "vault balance from RPC does not match --vault-balance-after");
  }
  if (options.destinationBalanceAfter) {
    assert(destination.amount === String(assertBaseUnits(options.destinationBalanceAfter, "destination_balance_after")), "destination balance from RPC does not match --destination-balance-after");
  }
  return {
    vault_balance_after: vault.amount,
    destination_balance_after: destination.amount,
    source: {
      calls_rpc: true,
      rpc_host: rpcHost(options.productionRpcUrl),
    },
  };
}

async function buildEvidence(options, rpcCall = defaultRpcCall) {
  assert(options.cluster === DEFAULT_CLUSTER, `cluster must be ${DEFAULT_CLUSTER}`);
  assert(!TEST_NETWORK_RE.test(options.cluster), "cluster must not be devnet/testnet/local/example");
  const signedIntent = readSignedIntent(options.signedIntent, options.cluster);
  const programId = assertSolanaAddress(resolvedField(options.programId, signedIntent && signedIntent.programId, "program_id"), "program_id");
  const tokenMint = assertSolanaAddress(resolvedField(options.tokenMint, signedIntent && signedIntent.tokenMint, "token_mint"), "token_mint");
  const amountBaseUnits = assertExactTenUsdc(resolvedField(options.amountBaseUnits, signedIntent && signedIntent.amountBaseUnits, "amount_base_units"), "amount_base_units");
  const taskHash = assertBytes32(resolvedField(options.taskHash, signedIntent && signedIntent.taskHash, "task_hash"), "task_hash");
  const buyer = assertSolanaAddress(resolvedField(options.buyer, signedIntent && signedIntent.buyer, "buyer"), "buyer");
  const worker = assertSolanaAddress(options.worker, "worker");
  const verifier = assertSolanaAddress(resolvedField(options.verifier, signedIntent && signedIntent.verifier, "verifier"), "verifier");
  const deadlineUnix = String(assertU64(resolvedField(options.deadlineUnix, signedIntent && signedIntent.deadlineUnix, "deadline_unix"), "deadline_unix"));
  const nonce = String(assertU64(resolvedField(options.nonce, signedIntent && signedIntent.nonce, "nonce"), "nonce"));
  const resultHash = assertBytes32(options.resultHash, "result_hash");
  assertSolanaAddress(options.taskAccount, "task_account");
  assertSolanaAddress(options.vaultTokenAccount, "vault_token_account");
  assertSolanaAddress(options.destinationTokenAccount, "destination_token_account");
  assertSolanaSignature(options.fundSignature, "fund_signature");
  assertSolanaSignature(options.claimSignature, "claim_signature");
  assertSolanaSignature(options.attestSignature, "attest_signature");
  assertSolanaSignature(options.releaseSignature, "release_signature");
  assert(["processed", "confirmed", "finalized"].includes(options.minConfirmation), "min_confirmation must be processed, confirmed, or finalized");

  const timing = deriveTiming(options);
  const balances = await resolveBalances(options, rpcCall);
  const generatedAt = options.generatedAt || new Date().toISOString();
  assertIso(generatedAt, "generated_at");

  const evidence = {
    kind: "tasc.production_payout.evidence",
    version: "0.1",
    generated_at: generatedAt,
    example_only: false,
    real_money: true,
    network: {
      chain: "solana",
      cluster: options.cluster,
      network_type: "mainnet",
    },
    token: {
      symbol: "USDC",
      decimals: 6,
      mint: tokenMint,
      production_asset: true,
    },
    amount: {
      display: "10 USDC",
      base_units: String(amountBaseUnits),
    },
    settlement: {
      program_id: programId,
      completed_status: "Released",
      action: "release",
      task_hash: taskHash,
      task_account: options.taskAccount,
      buyer,
      worker,
      verifier,
      deadline_unix: deadlineUnix,
      nonce,
      result_hash: resultHash,
      vault_token_account: options.vaultTokenAccount,
      destination_role: "worker",
      destination_token_account: options.destinationTokenAccount,
      vault_balance_after: balances.vault_balance_after,
      destination_balance_after: balances.destination_balance_after,
    },
    timing,
    signatures: {
      fund: options.fundSignature,
      claim: options.claimSignature,
      attest: options.attestSignature,
      release: options.releaseSignature,
    },
    source: {
      built_by: "bin/build-production-payout-evidence.js",
      sends_transactions: false,
      accepts_private_keys: false,
      key_material_printed: false,
      rpc_url_printed: false,
      signed_intent_verified: Boolean(signedIntent),
      signed_intent_hash: signedIntent && signedIntent.signed_intent_hash,
      calls_rpc: balances.source.calls_rpc,
      rpc_host: balances.source.rpc_host,
      min_confirmation_for_balance_reads: options.minConfirmation,
    },
  };

  validateProductionPayout(evidence);
  return evidence;
}

async function build(options, rpcCall = defaultRpcCall) {
  const evidence = await buildEvidence(options, rpcCall);
  const out = path.resolve(options.out || DEFAULT_OUT);
  writeJson(out, evidence);
  return {
    ok: true,
    kind: "tasc.production_payout.build_result",
    version: "0.1",
    evidence_file: path.relative(ROOT, out),
    schema_valid: true,
    sends_transactions: false,
    accepts_private_keys: false,
    key_material_printed: false,
    rpc_url_printed: false,
    calls_rpc: evidence.source.calls_rpc,
    rpc_host: evidence.source.rpc_host,
    no_new_dependencies: true,
  };
}

function plan(options = {}) {
  return {
    ok: true,
    kind: "tasc.production_payout.plan",
    version: "0.1",
    goal: "build the non-example mainnet USDC payout artifact required by real:readiness",
    default_output: options.out || DEFAULT_OUT,
    sends_transactions: false,
    accepts_private_keys: false,
    key_material_printed: false,
    calls_rpc: false,
    writes_files: false,
    required_inputs: [
      "signed production intent, or explicit program/task/buyer/verifier/deadline/nonce fields",
      "worker wallet address",
      "verifier result hash from the pass attestation",
      "production USDC mint address",
      "mainnet task account",
      "vault token account after release",
      "worker destination token account after release",
      "fund, claim, attest, and release transaction signatures",
      "claim-to-release and claim-to-completed-index timings under 60000ms",
      "post-release vault and worker token balances, either from --production-rpc-url or explicit balance flags",
    ],
    commands: {
      build_with_rpc: "npm run real:payout:build -- --signed-intent .tascverifier/production-intent/production-intent.signature.json --program-id <program-id> --token-mint <mainnet-usdc-mint> --worker <worker-wallet> --result-hash <0x-result-hash> --task-account <task-account> --vault-token-account <vault-token-account> --destination-token-account <worker-token-account> --fund-signature <sig> --claim-signature <sig> --attest-signature <sig> --release-signature <sig> --claim-to-release-ms <ms> --claim-to-completed-index-ms <ms> --production-rpc-url <mainnet-rpc-url>",
      validate_goal_readiness: "npm run real:readiness -- --timed-proof examples/solana-devnet/proofs/<run-id>/proof-summary.json --production-payout .tascverifier/production-payout-evidence.json --production-rpc-url <mainnet-rpc-url> --expected-genesis-hash <mainnet-genesis-hash>",
    },
    notes: [
      "The RPC URL is only used for read-only SPL token balance checks and is never written to the evidence file.",
      "The builder refuses devnet/testnet/local clusters and exactly targets the 10 USDC MVP payout gate.",
      "Final signature status, genesis hash, and live balance verification still happen in real:readiness.",
    ],
  };
}

function sampleAddress(byte) {
  return base58Encode(Buffer.alloc(32, byte));
}

function sampleSignature(byte) {
  return base58Encode(Buffer.alloc(64, byte));
}

function sampleOptions(out) {
  return {
    command: "build",
    out,
    generatedAt: "2026-01-01T00:00:00.000Z",
    cluster: DEFAULT_CLUSTER,
    signedIntent: "",
    programId: sampleAddress(8),
    tokenMint: sampleAddress(9),
    amountBaseUnits: DEFAULT_AMOUNT_BASE_UNITS,
    taskHash: `0x${"18".repeat(32)}`,
    buyer: sampleAddress(18),
    worker: sampleAddress(19),
    verifier: sampleAddress(20),
    deadlineUnix: "1800000000",
    nonce: "9001",
    resultHash: `0x${"21".repeat(32)}`,
    taskAccount: sampleAddress(10),
    vaultTokenAccount: sampleAddress(11),
    destinationTokenAccount: sampleAddress(12),
    fundSignature: sampleSignature(13),
    claimSignature: sampleSignature(14),
    attestSignature: sampleSignature(15),
    releaseSignature: sampleSignature(16),
    claimToReleaseMs: "4669",
    claimToCompletedIndexMs: "4751",
    claimStartedAt: "",
    releaseConfirmedAt: "",
    completedIndexedAt: "",
    productionRpcUrl: "http://127.0.0.1/mock-mainnet-rpc",
    minConfirmation: "finalized",
    vaultBalanceAfter: "",
    destinationBalanceAfter: "",
  };
}

function mockRpcCall(options) {
  return async (_rpcUrl, method, params) => {
    if (method !== "getAccountInfo") throw new Error(`unexpected RPC method ${method}`);
    const pubkey = params[0];
    let amount = null;
    if (pubkey === options.vaultTokenAccount) amount = "0";
    if (pubkey === options.destinationTokenAccount) amount = DEFAULT_AMOUNT_BASE_UNITS;
    assert(amount !== null, `unexpected token account ${pubkey}`);
    return {
      value: {
        owner: TOKEN_PROGRAM_ID,
        data: [
          encodeTokenAccount({
            pubkey,
            mint: options.tokenMint,
            owner: sampleAddress(17),
            amount,
          }).toString("base64"),
          "base64",
        ],
      },
    };
  };
}

async function sampleSignedIntent(file, options) {
  const {
    buildUnsignedIntent,
    attachSignature,
  } = require("./build-production-intent");
  const {
    fixtureKeypair,
    signSolanaIntent,
  } = require("./tascsolana");
  const buyer = fixtureKeypair("buyer");
  const built = buildUnsignedIntent({
    taskFile: path.join(ROOT, "examples/summarize_url.tasc"),
    buyer: buyer.address,
    verifier: options.verifier,
    programId: options.programId,
    tokenMint: options.tokenMint,
    inputs: { url: "https://docs.cdp.coinbase.com/x402/welcome" },
    now: options.deadlineUnix,
    nonce: options.nonce,
    decimals: 6,
  });
  const unsignedFile = path.join(path.dirname(file), "production-intent.intent.json");
  writeJson(unsignedFile, built.intent);
  const intentForSigning = { ...built.intent };
  delete intentForSigning.signing;
  delete intentForSigning.network_type;
  const signedByFixture = signSolanaIntent(intentForSigning, buyer);
  attachSignature({
    intentFile: unsignedFile,
    signature: signedByFixture.signature,
    out: file,
  });
  return {
    signed_intent_file: file,
    buyer: buyer.address,
  };
}

async function selfTest() {
  fs.mkdirSync(path.join(ROOT, ".tascverifier"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, ".tascverifier", "production-payout-builder-"));
  const out = path.join(dir, "production-payout-evidence.json");
  const options = sampleOptions(out);
  const planResult = plan();
  assert(planResult.sends_transactions === false, "plan must not send transactions");
  assert(planResult.calls_rpc === false, "plan must not call RPC");
  assert(planResult.writes_files === false, "plan must not write files");

  const result = await build(options, mockRpcCall(options));
  assert(result.ok === true, "build should succeed");
  assert(fs.existsSync(out), "build should write evidence");
  const written = loadJson(out);
  assert(written.source.rpc_host === "127.0.0.1", "evidence should only keep RPC host");
  assert(!JSON.stringify(written).includes("/mock-mainnet-rpc"), "evidence must not store full RPC URL");
  validateProductionPayout(written);

  const manualBalances = await buildEvidence({
    ...options,
    productionRpcUrl: "",
    vaultBalanceAfter: "0",
    destinationBalanceAfter: DEFAULT_AMOUNT_BASE_UNITS,
  });
  assert(manualBalances.source.calls_rpc === false, "manual balance build should not call RPC");

  const signed = await sampleSignedIntent(path.join(dir, "production-intent.signature.json"), options);
  const signedIntentEvidence = await buildEvidence({
    ...options,
    signedIntent: signed.signed_intent_file,
    programId: "",
    tokenMint: "",
    taskHash: "",
    buyer: "",
    verifier: "",
    deadlineUnix: "",
    nonce: "",
    productionRpcUrl: "",
    vaultBalanceAfter: "0",
    destinationBalanceAfter: DEFAULT_AMOUNT_BASE_UNITS,
  });
  assert(signedIntentEvidence.source.signed_intent_verified === true, "signed intent should be verified");
  assert(signedIntentEvidence.settlement.buyer === signed.buyer, "signed intent should fill buyer");

  let rejectedDevnet = false;
  try {
    await buildEvidence({
      ...options,
      cluster: "solana-devnet",
    }, mockRpcCall(options));
  } catch {
    rejectedDevnet = true;
  }
  assert(rejectedDevnet, "devnet clusters should be rejected");

  let rejectedMissingBalance = false;
  try {
    await buildEvidence({
      ...options,
      productionRpcUrl: "",
    });
  } catch {
    rejectedMissingBalance = true;
  }
  assert(rejectedMissingBalance, "missing balances without RPC should be rejected");

  return {
    ok: true,
    self_test: true,
    builder_plan_safe: true,
    build_with_rpc_safe: true,
    build_without_rpc_safe: true,
    build_from_signed_intent_safe: true,
    rejected_devnet: rejectedDevnet,
    rejected_missing_balance: rejectedMissingBalance,
    no_new_dependencies: true,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    process.stdout.write(`${JSON.stringify(await selfTest(), null, 2)}\n`);
    return;
  }
  if (options.command === "plan") {
    process.stdout.write(`${JSON.stringify(plan(options), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(await build(options), null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`build-production-payout-evidence: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  build,
  buildEvidence,
  plan,
  selfTest,
};
