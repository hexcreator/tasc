#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  buildArtifact: buildProductionFundTransaction,
  validateArtifact: validateProductionFundTransaction,
} = require("./build-production-fund-transaction");
const {
  buildArtifact: buildProductionLifecycleTransaction,
  validateArtifact: validateProductionLifecycleTransaction,
} = require("./build-production-lifecycle-transaction");
const { buildEvidence } = require("./build-production-payout-evidence");
const { validateProductionPayout } = require("./validate-real-money-readiness");
const { verifySignedSolanaIntent } = require("./tascsolana");
const { base58Decode, base58Encode } = require("./run-solana-devnet");
const { TOKEN_PROGRAM_ID, encodeTokenAccount } = require("./tascsolana-spl");
const {
  DEFAULT_ENV_FILE,
  PRODUCTION_ENV,
  envMetadata,
  withProductionEnv,
} = require("./production-env");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_CAPTURE = ".tascverifier/production-run-capture.json";
const DEFAULT_PAYOUT = ".tascverifier/production-payout-evidence.json";
const DEFAULT_SIGNED_INTENT = ".tascverifier/production-intent/production-intent.signature.json";
const DEFAULT_CLUSTER = "solana-mainnet-beta";
const DEFAULT_AMOUNT_BASE_UNITS = "10000000";
const TARGET_MS = 60_000;
const TEST_NETWORK_RE = /(devnet|testnet|sepolia|local|mock|fixture|example)/i;

function usage() {
  console.error([
    "Usage:",
    "  node bin/record-production-run-capture.js plan [options]",
    "  node bin/record-production-run-capture.js init [options]",
    "  node bin/record-production-run-capture.js record [options]",
    "  node bin/record-production-run-capture.js validate [options]",
    "  node bin/record-production-run-capture.js payout [options]",
    "  node bin/record-production-run-capture.js --self-test",
    "",
    "Options:",
    "  --env <file>                              production env file; default .env.solana-mainnet.local",
    "  --capture <file>                          capture file; default .tascverifier/production-run-capture.json",
    "  --out <file>                              payout evidence output for payout command",
    "  --signed-intent <file>                    signed production intent",
    "  --transaction <file>                      production fund/lifecycle transaction artifact for record",
    "  --signature <signature>                   wallet signature returned for --transaction",
    "  --program-id <address>                    expected deployed mainnet program id",
    "  --token-mint <address>                    expected mainnet USDC mint",
    "  --worker <address>                        worker wallet",
    "  --destination-token-account <address>     worker destination USDC token account",
    "  --result-hash <0xbytes32>                 verifier result hash",
    "  --task-account <address>                  production task account",
    "  --vault-token-account <address>           production vault token account",
    "  --fund-signature <signature>              mainnet fund transaction signature",
    "  --claim-signature <signature>             mainnet claim transaction signature",
    "  --attest-signature <signature>            mainnet attest transaction signature",
    "  --release-signature <signature>           mainnet release transaction signature",
    "  --claim-started-at <iso>                  claim send/start timestamp",
    "  --release-confirmed-at <iso>              release confirmation timestamp",
    "  --completed-indexed-at <iso>              completed index publication timestamp",
    "  --claim-to-release-ms <n>                 explicit claim-to-release duration",
    "  --claim-to-completed-index-ms <n>         explicit claim-to-completed-index duration",
    "  --vault-balance-after <n>                 post-release vault balance; default read by payout RPC",
    "  --destination-balance-after <n>           post-release worker balance; default read by payout RPC",
    "  --production-rpc-url <url>                optional RPC for payout token balance reads only",
    "  --min-confirmation <status>               processed, confirmed, or finalized; default finalized",
    "  --generated-at <iso>                      generated_at timestamp for init/payout",
    "",
    "This recorder never accepts private keys and never sends transactions.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    command: "plan",
    envFile: DEFAULT_ENV_FILE,
    capture: DEFAULT_CAPTURE,
    out: DEFAULT_PAYOUT,
    signedIntent: DEFAULT_SIGNED_INTENT,
    transaction: "",
    signature: "",
    programId: "",
    tokenMint: "",
    worker: "",
    destinationTokenAccount: "",
    resultHash: "",
    taskAccount: "",
    vaultTokenAccount: "",
    fundSignature: "",
    claimSignature: "",
    attestSignature: "",
    releaseSignature: "",
    claimStartedAt: "",
    releaseConfirmedAt: "",
    completedIndexedAt: "",
    claimToReleaseMs: "",
    claimToCompletedIndexMs: "",
    vaultBalanceAfter: "",
    destinationBalanceAfter: "",
    productionRpcUrl: "",
    minConfirmation: "finalized",
    generatedAt: "",
    selfTest: false,
  };
  const args = [...argv];
  if (["plan", "init", "record", "validate", "payout"].includes(args[0])) options.command = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = requireValue(args, ++i, arg);
    else if (arg === "--capture") options.capture = requireValue(args, ++i, arg);
    else if (arg === "--out") options.out = requireValue(args, ++i, arg);
    else if (arg === "--signed-intent") options.signedIntent = requireValue(args, ++i, arg);
    else if (arg === "--transaction") options.transaction = requireValue(args, ++i, arg);
    else if (arg === "--signature") options.signature = requireValue(args, ++i, arg);
    else if (arg === "--program-id") options.programId = requireValue(args, ++i, arg);
    else if (arg === "--token-mint") options.tokenMint = requireValue(args, ++i, arg);
    else if (arg === "--worker") options.worker = requireValue(args, ++i, arg);
    else if (arg === "--destination-token-account") options.destinationTokenAccount = requireValue(args, ++i, arg);
    else if (arg === "--result-hash") options.resultHash = requireValue(args, ++i, arg);
    else if (arg === "--task-account") options.taskAccount = requireValue(args, ++i, arg);
    else if (arg === "--vault-token-account") options.vaultTokenAccount = requireValue(args, ++i, arg);
    else if (arg === "--fund-signature") options.fundSignature = requireValue(args, ++i, arg);
    else if (arg === "--claim-signature") options.claimSignature = requireValue(args, ++i, arg);
    else if (arg === "--attest-signature") options.attestSignature = requireValue(args, ++i, arg);
    else if (arg === "--release-signature") options.releaseSignature = requireValue(args, ++i, arg);
    else if (arg === "--claim-started-at") options.claimStartedAt = requireValue(args, ++i, arg);
    else if (arg === "--release-confirmed-at") options.releaseConfirmedAt = requireValue(args, ++i, arg);
    else if (arg === "--completed-indexed-at") options.completedIndexedAt = requireValue(args, ++i, arg);
    else if (arg === "--claim-to-release-ms") options.claimToReleaseMs = requireValue(args, ++i, arg);
    else if (arg === "--claim-to-completed-index-ms") options.claimToCompletedIndexMs = requireValue(args, ++i, arg);
    else if (arg === "--vault-balance-after") options.vaultBalanceAfter = requireValue(args, ++i, arg);
    else if (arg === "--destination-balance-after") options.destinationBalanceAfter = requireValue(args, ++i, arg);
    else if (arg === "--production-rpc-url") options.productionRpcUrl = requireValue(args, ++i, arg);
    else if (arg === "--min-confirmation") options.minConfirmation = requireValue(args, ++i, arg);
    else if (arg === "--generated-at") options.generatedAt = requireValue(args, ++i, arg);
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  return options;
}

function optionsWithEnv(options = {}) {
  return withProductionEnv(options, {
    productionRpcUrl: PRODUCTION_ENV.rpcUrl,
    programId: PRODUCTION_ENV.programId,
    tokenMint: PRODUCTION_ENV.tokenMint,
    worker: PRODUCTION_ENV.worker,
    destinationTokenAccount: PRODUCTION_ENV.workerUsdc,
  });
}

function requireValue(args, index, label) {
  const value = args[index] || "";
  if (!value) throw new Error(`${label} requires a value`);
  return value;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function rel(file) {
  if (!file) return "";
  return path.relative(ROOT, path.resolve(file));
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
  const text = String(value || "");
  assert(/^[0-9]+$/.test(text), `${label} must be integer base units`);
  return text;
}

function assertDuration(value, label) {
  const text = String(value || "");
  assert(/^[0-9]+$/.test(text), `${label} must be a nonnegative integer`);
  const parsed = Number(text);
  assert(Number.isSafeInteger(parsed), `${label} exceeds safe integer range`);
  assert(parsed <= TARGET_MS, `${label} exceeded 60000ms`);
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
  const text = assertString(value, label);
  const url = new URL(text);
  assert(url.protocol === "http:" || url.protocol === "https:", `${label} must be http(s)`);
  return text;
}

function readSignedIntent(file, expected = {}) {
  const signedIntentFile = path.resolve(assertString(file, "signed_intent"));
  const signed = loadJson(signedIntentFile);
  const verified = verifySignedSolanaIntent(signed);
  assert(verified.ok === true, "signed production intent signature is invalid");
  const message = signed.intent && signed.intent.message || {};
  assert(message.cluster === DEFAULT_CLUSTER, "signed intent must target solana-mainnet-beta");
  assert(message.amount === DEFAULT_AMOUNT_BASE_UNITS, "signed intent amount must be exactly 10000000");
  if (expected.programId) assert(message.program_id === expected.programId, "signed intent program_id mismatch");
  if (expected.tokenMint) assert(message.token_mint === expected.tokenMint, "signed intent token_mint mismatch");
  return {
    file: rel(signedIntentFile),
    intent_hash: signed.intent_hash || null,
    signer: verified.signer,
    program_id: assertSolanaAddress(message.program_id, "signed intent program_id"),
    task_hash: assertBytes32(message.task_hash, "signed intent task_hash"),
    buyer: assertSolanaAddress(message.buyer, "signed intent buyer"),
    verifier: assertSolanaAddress(message.verifier, "signed intent verifier"),
    token_mint: assertSolanaAddress(message.token_mint, "signed intent token_mint"),
    amount_base_units: String(message.amount),
    deadline_unix: String(message.deadline_unix),
    nonce: String(message.nonce),
  };
}

function blankCapture(generatedAt) {
  return {
    kind: "tasc.production_run.capture",
    version: "0.1",
    generated_at: generatedAt,
    updated_at: generatedAt,
    goal: "make $10 in less than a minute",
    network: {
      chain: "solana",
      cluster: DEFAULT_CLUSTER,
      network_type: "mainnet",
    },
    signed_intent: null,
    role_accounts: {
      worker: "",
      destination_token_account: "",
    },
    settlement_inputs: {
      result_hash: "",
      task_account: "",
      vault_token_account: "",
    },
    signatures: {
      fund: "",
      claim: "",
      attest: "",
      release: "",
    },
    timing: {
      target_ms: TARGET_MS,
      claim_started_at: "",
      release_confirmed_at: "",
      completed_indexed_at: "",
      claim_to_release_ms: null,
      claim_to_completed_index_ms: null,
    },
    balances: {
      vault_balance_after: "",
      destination_balance_after: "",
    },
    source: {
      built_by: "bin/record-production-run-capture.js",
      sends_transactions: false,
      accepts_private_keys: false,
      key_material_printed: false,
      rpc_url_printed: false,
      full_rpc_url_persisted: false,
      no_new_dependencies: true,
    },
  };
}

function updateTiming(capture, options) {
  if (options.claimStartedAt) capture.timing.claim_started_at = assertIso(options.claimStartedAt, "claim_started_at");
  if (options.releaseConfirmedAt) capture.timing.release_confirmed_at = assertIso(options.releaseConfirmedAt, "release_confirmed_at");
  if (options.completedIndexedAt) capture.timing.completed_indexed_at = assertIso(options.completedIndexedAt, "completed_indexed_at");
  if (options.claimToReleaseMs) capture.timing.claim_to_release_ms = assertDuration(options.claimToReleaseMs, "claim_to_release_ms");
  if (options.claimToCompletedIndexMs) {
    capture.timing.claim_to_completed_index_ms = assertDuration(options.claimToCompletedIndexMs, "claim_to_completed_index_ms");
  }
  if (capture.timing.claim_started_at && capture.timing.release_confirmed_at) {
    capture.timing.claim_to_release_ms = Date.parse(capture.timing.release_confirmed_at) - Date.parse(capture.timing.claim_started_at);
    assert(capture.timing.claim_to_release_ms >= 0, "release_confirmed_at must be after claim_started_at");
    assert(capture.timing.claim_to_release_ms <= TARGET_MS, "claim-to-release exceeded 60000ms");
  }
  if (capture.timing.claim_started_at && capture.timing.completed_indexed_at) {
    capture.timing.claim_to_completed_index_ms = Date.parse(capture.timing.completed_indexed_at) - Date.parse(capture.timing.claim_started_at);
    assert(capture.timing.claim_to_completed_index_ms >= 0, "completed_indexed_at must be after claim_started_at");
    assert(capture.timing.claim_to_completed_index_ms <= TARGET_MS, "claim-to-completed-index exceeded 60000ms");
  }
  if (capture.timing.claim_to_release_ms !== null && capture.timing.claim_to_completed_index_ms !== null) {
    assert(
      capture.timing.claim_to_completed_index_ms >= capture.timing.claim_to_release_ms,
      "claim_to_completed_index_ms must be >= claim_to_release_ms",
    );
  }
}

function validateTiming(timing) {
  if (timing.claim_started_at) assertIso(timing.claim_started_at, "claim_started_at");
  if (timing.release_confirmed_at) assertIso(timing.release_confirmed_at, "release_confirmed_at");
  if (timing.completed_indexed_at) assertIso(timing.completed_indexed_at, "completed_indexed_at");
  if (timing.claim_started_at && timing.release_confirmed_at) {
    const derived = Date.parse(timing.release_confirmed_at) - Date.parse(timing.claim_started_at);
    assert(derived >= 0, "release_confirmed_at must be after claim_started_at");
    assert(derived <= TARGET_MS, "claim-to-release exceeded 60000ms");
    if (timing.claim_to_release_ms !== null) {
      assert(Number(timing.claim_to_release_ms) === derived, "claim_to_release_ms must match claim/release timestamps");
    }
  }
  if (timing.claim_started_at && timing.completed_indexed_at) {
    const derived = Date.parse(timing.completed_indexed_at) - Date.parse(timing.claim_started_at);
    assert(derived >= 0, "completed_indexed_at must be after claim_started_at");
    assert(derived <= TARGET_MS, "claim-to-completed-index exceeded 60000ms");
    if (timing.claim_to_completed_index_ms !== null) {
      assert(Number(timing.claim_to_completed_index_ms) === derived, "claim_to_completed_index_ms must match claim/completed timestamps");
    }
  }
  if (timing.claim_to_release_ms !== null && timing.claim_to_completed_index_ms !== null) {
    assert(
      Number(timing.claim_to_completed_index_ms) >= Number(timing.claim_to_release_ms),
      "claim_to_completed_index_ms must be >= claim_to_release_ms",
    );
  }
}

function applyOptions(capture, options) {
  if (options.worker) capture.role_accounts.worker = assertSolanaAddress(options.worker, "worker");
  if (options.destinationTokenAccount) {
    capture.role_accounts.destination_token_account = assertSolanaAddress(options.destinationTokenAccount, "destination_token_account");
  }
  if (options.resultHash) capture.settlement_inputs.result_hash = assertBytes32(options.resultHash, "result_hash");
  if (options.taskAccount) capture.settlement_inputs.task_account = assertSolanaAddress(options.taskAccount, "task_account");
  if (options.vaultTokenAccount) capture.settlement_inputs.vault_token_account = assertSolanaAddress(options.vaultTokenAccount, "vault_token_account");
  if (options.fundSignature) capture.signatures.fund = assertSolanaSignature(options.fundSignature, "fund_signature");
  if (options.claimSignature) capture.signatures.claim = assertSolanaSignature(options.claimSignature, "claim_signature");
  if (options.attestSignature) capture.signatures.attest = assertSolanaSignature(options.attestSignature, "attest_signature");
  if (options.releaseSignature) capture.signatures.release = assertSolanaSignature(options.releaseSignature, "release_signature");
  if (options.vaultBalanceAfter) capture.balances.vault_balance_after = assertBaseUnits(options.vaultBalanceAfter, "vault_balance_after");
  if (options.destinationBalanceAfter) {
    capture.balances.destination_balance_after = assertBaseUnits(options.destinationBalanceAfter, "destination_balance_after");
  }
  updateTiming(capture, options);
}

function assertCaptureIntentMatches(capture, artifact) {
  assert(capture.signed_intent, "capture must be initialized with signed production intent before recording a transaction artifact");
  const signed = capture.signed_intent;
  assert(artifact.cluster === DEFAULT_CLUSTER, "transaction artifact cluster must be solana-mainnet-beta");
  assert(artifact.network_type === "mainnet", "transaction artifact network_type must be mainnet");
  assert(artifact.program_id === signed.program_id, "transaction artifact program_id does not match capture");
  assert(artifact.token && artifact.token.mint === signed.token_mint, "transaction artifact token mint does not match capture");
  assert(artifact.amount && artifact.amount.base_units === signed.amount_base_units, "transaction artifact amount does not match capture");
  assert(artifact.buyer === signed.buyer, "transaction artifact buyer does not match capture");
  assert(artifact.verifier === signed.verifier, "transaction artifact verifier does not match capture");
  if (artifact.intent_hash && signed.intent_hash) {
    assert(artifact.intent_hash === signed.intent_hash, "transaction artifact intent_hash does not match capture");
  }
}

function signatureForPhase(options, phase) {
  const specific = {
    fund: options.fundSignature,
    claim: options.claimSignature,
    attest: options.attestSignature,
    release: options.releaseSignature,
  }[phase] || "";
  if (options.signature && specific) {
    assert(options.signature === specific, `--signature and --${phase}-signature must match`);
  }
  return assertSolanaSignature(specific || options.signature, `${phase}_signature`);
}

function setOrAssert(existing, incoming, label) {
  const checked = assertString(incoming, label);
  if (existing) {
    assert(existing === checked, `${label} mismatch`);
    return existing;
  }
  return checked;
}

function loadTransactionArtifact(file) {
  const resolved = path.resolve(assertString(file, "transaction"));
  const artifact = loadJson(resolved);
  if (artifact.kind === "tasc.production_fund_transaction") {
    validateProductionFundTransaction(artifact);
    return {
      file: rel(resolved),
      artifact,
      phase: "fund",
      kind: artifact.kind,
    };
  }
  if (artifact.kind === "tasc.production_lifecycle_transaction") {
    const validation = validateProductionLifecycleTransaction(artifact);
    return {
      file: rel(resolved),
      artifact,
      phase: validation.action,
      kind: artifact.kind,
    };
  }
  throw new Error("transaction artifact must be tasc.production_fund_transaction or tasc.production_lifecycle_transaction");
}

function applyTransactionArtifact(capture, options) {
  if (!options.transaction) return null;
  const loaded = loadTransactionArtifact(options.transaction);
  const artifact = loaded.artifact;
  assertCaptureIntentMatches(capture, artifact);
  const signature = signatureForPhase(options, loaded.phase);

  if (loaded.phase === "fund") {
    capture.settlement_inputs.task_account = setOrAssert(capture.settlement_inputs.task_account, artifact.task_account, "task_account");
    capture.settlement_inputs.vault_token_account = setOrAssert(
      capture.settlement_inputs.vault_token_account,
      artifact.vault_token_account,
      "vault_token_account",
    );
    capture.signatures.fund = setOrAssert(capture.signatures.fund, signature, "fund_signature");
  } else {
    capture.settlement_inputs.task_account = setOrAssert(capture.settlement_inputs.task_account, artifact.task_account, "task_account");
    if (loaded.phase === "claim") {
      capture.role_accounts.worker = setOrAssert(capture.role_accounts.worker, artifact.signer, "worker");
      capture.signatures.claim = setOrAssert(capture.signatures.claim, signature, "claim_signature");
      if (!options.claimStartedAt && !capture.timing.claim_started_at) {
        capture.timing.claim_started_at = assertIso(options.generatedAt || capture.updated_at, "claim_started_at");
      }
    }
    if (loaded.phase === "attest") {
      assert(artifact.signer === capture.signed_intent.verifier, "attest transaction signer must match capture verifier");
      capture.settlement_inputs.result_hash = setOrAssert(
        capture.settlement_inputs.result_hash,
        artifact.instruction.result_hash,
        "result_hash",
      );
      capture.signatures.attest = setOrAssert(capture.signatures.attest, signature, "attest_signature");
    }
    if (loaded.phase === "release") {
      assert(artifact.settlement, "release transaction artifact must include settlement");
      capture.role_accounts.worker = setOrAssert(capture.role_accounts.worker, artifact.signer, "worker");
      capture.role_accounts.destination_token_account = setOrAssert(
        capture.role_accounts.destination_token_account,
        artifact.settlement.destination_token_account,
        "destination_token_account",
      );
      capture.settlement_inputs.vault_token_account = setOrAssert(
        capture.settlement_inputs.vault_token_account,
        artifact.settlement.vault_token_account,
        "vault_token_account",
      );
      capture.signatures.release = setOrAssert(capture.signatures.release, signature, "release_signature");
    }
  }

  return {
    file: loaded.file,
    kind: loaded.kind,
    phase: loaded.phase,
    signature,
  };
}

function missingForPayout(capture) {
  const missing = [];
  if (!capture.signed_intent) missing.push("signed production intent");
  if (!capture.role_accounts.worker) missing.push("worker wallet");
  if (!capture.role_accounts.destination_token_account) missing.push("worker destination token account");
  if (!capture.settlement_inputs.result_hash) missing.push("result hash");
  if (!capture.settlement_inputs.task_account) missing.push("task account");
  if (!capture.settlement_inputs.vault_token_account) missing.push("vault token account");
  ["fund", "claim", "attest", "release"].forEach((name) => {
    if (!capture.signatures[name]) missing.push(`${name} signature`);
  });
  if (capture.timing.claim_to_release_ms === null) missing.push("claim-to-release timing");
  if (capture.timing.claim_to_completed_index_ms === null) missing.push("claim-to-completed-index timing");
  return missing;
}

function validateCapture(capture, options = {}) {
  assert(capture && typeof capture === "object", "capture must be a JSON object");
  assert(capture.kind === "tasc.production_run.capture", "capture kind mismatch");
  assert(capture.version === "0.1", "capture version mismatch");
  assertIso(capture.generated_at, "generated_at");
  assertIso(capture.updated_at, "updated_at");
  assert(capture.goal === "make $10 in less than a minute", "goal mismatch");
  assert(capture.network && capture.network.chain === "solana", "network.chain must be solana");
  assert(capture.network.cluster === DEFAULT_CLUSTER, "network.cluster must be solana-mainnet-beta");
  assert(!TEST_NETWORK_RE.test(capture.network.cluster), "capture cluster must not be devnet/testnet/local/example");
  if (capture.signed_intent) {
    assertSolanaAddress(capture.signed_intent.program_id, "signed_intent.program_id");
    assertBytes32(capture.signed_intent.task_hash, "signed_intent.task_hash");
    assertSolanaAddress(capture.signed_intent.buyer, "signed_intent.buyer");
    assertSolanaAddress(capture.signed_intent.verifier, "signed_intent.verifier");
    assertSolanaAddress(capture.signed_intent.token_mint, "signed_intent.token_mint");
    assert(capture.signed_intent.amount_base_units === DEFAULT_AMOUNT_BASE_UNITS, "signed_intent.amount must be 10000000");
  }
  if (capture.role_accounts.worker) assertSolanaAddress(capture.role_accounts.worker, "worker");
  if (capture.role_accounts.destination_token_account) {
    assertSolanaAddress(capture.role_accounts.destination_token_account, "destination_token_account");
  }
  if (capture.settlement_inputs.result_hash) assertBytes32(capture.settlement_inputs.result_hash, "result_hash");
  if (capture.settlement_inputs.task_account) assertSolanaAddress(capture.settlement_inputs.task_account, "task_account");
  if (capture.settlement_inputs.vault_token_account) assertSolanaAddress(capture.settlement_inputs.vault_token_account, "vault_token_account");
  Object.entries(capture.signatures || {}).forEach(([name, signature]) => {
    if (signature) assertSolanaSignature(signature, `${name}_signature`);
  });
  if (capture.balances.vault_balance_after) assertBaseUnits(capture.balances.vault_balance_after, "vault_balance_after");
  if (capture.balances.destination_balance_after) assertBaseUnits(capture.balances.destination_balance_after, "destination_balance_after");
  if (capture.timing.claim_to_release_ms !== null) assertDuration(String(capture.timing.claim_to_release_ms), "claim_to_release_ms");
  if (capture.timing.claim_to_completed_index_ms !== null) {
    assertDuration(String(capture.timing.claim_to_completed_index_ms), "claim_to_completed_index_ms");
  }
  validateTiming(capture.timing);
  const missing = missingForPayout(capture);
  if (options.requireComplete) assert(missing.length === 0, `capture missing required payout fields: ${missing.join(", ")}`);
  return {
    ok: true,
    kind: "tasc.production_run.capture.validation",
    version: "0.1",
    complete_for_payout: missing.length === 0,
    missing,
    sends_transactions: false,
    accepts_private_keys: false,
    no_new_dependencies: true,
  };
}

function plan(options = {}) {
  const capture = options.capture || DEFAULT_CAPTURE;
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  return {
    ok: true,
    kind: "tasc.production_run.capture.plan",
    version: "0.1",
    default_capture: capture,
    default_payout: options.out || DEFAULT_PAYOUT,
    default_env_file: envFile,
    sends_transactions: false,
    accepts_private_keys: false,
    calls_rpc: false,
    writes_files: false,
    operator_flow: [
      `npm run real:capture:init -- --env ${envFile} --signed-intent .tascverifier/production-intent/production-intent.signature.json`,
      `npm run real:capture:record -- --transaction .tascverifier/production-fund-transaction.json --signature <fund-sig>`,
      `npm run real:capture:record -- --fund-signature <fund-sig> --task-account <task-account> --vault-token-account <vault-token-account>`,
      `npm run real:capture:record -- --transaction .tascverifier/production-lifecycle-claim.json --signature <claim-sig> --claim-started-at <iso>`,
      `npm run real:capture:record -- --claim-signature <claim-sig> --claim-started-at <iso>`,
      `npm run real:capture:record -- --transaction .tascverifier/production-lifecycle-attest.json --signature <attest-sig>`,
      `npm run real:capture:record -- --attest-signature <attest-sig> --result-hash <0x-result-hash>`,
      `npm run real:capture:record -- --transaction .tascverifier/production-lifecycle-release.json --signature <release-sig> --release-confirmed-at <iso> --completed-indexed-at <iso>`,
      `npm run real:capture:record -- --release-signature <release-sig> --release-confirmed-at <iso> --completed-indexed-at <iso>`,
      `npm run real:capture:payout -- --env ${envFile} --out ${options.out || DEFAULT_PAYOUT}`,
    ],
  };
}

function init(options = {}) {
  options = optionsWithEnv(options);
  const generatedAt = assertIso(options.generatedAt || new Date().toISOString(), "generated_at");
  const signedIntent = readSignedIntent(options.signedIntent, {
    programId: options.programId || "",
    tokenMint: options.tokenMint || "",
  });
  const capture = blankCapture(generatedAt);
  capture.signed_intent = signedIntent;
  applyOptions(capture, options);
  validateCapture(capture);
  const out = path.resolve(options.capture || DEFAULT_CAPTURE);
  writeJson(out, capture);
  return {
    ok: true,
    kind: "tasc.production_run.capture.init_result",
    version: "0.1",
    capture_file: rel(out),
    ...envMetadata(options.envFile, [
      PRODUCTION_ENV.programId,
      PRODUCTION_ENV.tokenMint,
      PRODUCTION_ENV.worker,
      PRODUCTION_ENV.workerUsdc,
    ]),
    complete_for_payout: missingForPayout(capture).length === 0,
    sends_transactions: false,
    accepts_private_keys: false,
    no_new_dependencies: true,
  };
}

function record(options = {}) {
  const file = path.resolve(options.capture || DEFAULT_CAPTURE);
  const capture = loadJson(file);
  validateCapture(capture);
  capture.updated_at = assertIso(options.generatedAt || new Date().toISOString(), "updated_at");
  const recordedFromTransaction = applyTransactionArtifact(capture, options);
  applyOptions(capture, options);
  validateCapture(capture);
  writeJson(file, capture);
  return {
    ok: true,
    kind: "tasc.production_run.capture.record_result",
    version: "0.1",
    capture_file: rel(file),
    recorded_from_transaction: recordedFromTransaction,
    complete_for_payout: missingForPayout(capture).length === 0,
    missing: missingForPayout(capture),
    sends_transactions: false,
    accepts_private_keys: false,
    no_new_dependencies: true,
  };
}

function evidenceOptionsFromCapture(capture, options = {}) {
  const signedIntentFile = capture.signed_intent && capture.signed_intent.file
    ? path.resolve(ROOT, capture.signed_intent.file)
    : "";
  return {
    envFile: options.envFile || DEFAULT_ENV_FILE,
    out: options.out || DEFAULT_PAYOUT,
    generatedAt: options.generatedAt || "",
    cluster: DEFAULT_CLUSTER,
    signedIntent: signedIntentFile,
    programId: capture.signed_intent.program_id,
    tokenMint: capture.signed_intent.token_mint,
    amountBaseUnits: capture.signed_intent.amount_base_units,
    worker: capture.role_accounts.worker,
    resultHash: capture.settlement_inputs.result_hash,
    taskAccount: capture.settlement_inputs.task_account,
    vaultTokenAccount: capture.settlement_inputs.vault_token_account,
    destinationTokenAccount: capture.role_accounts.destination_token_account,
    fundSignature: capture.signatures.fund,
    claimSignature: capture.signatures.claim,
    attestSignature: capture.signatures.attest,
    releaseSignature: capture.signatures.release,
    claimToReleaseMs: String(capture.timing.claim_to_release_ms),
    claimToCompletedIndexMs: String(capture.timing.claim_to_completed_index_ms),
    claimStartedAt: "",
    releaseConfirmedAt: "",
    completedIndexedAt: "",
    productionRpcUrl: options.productionRpcUrl || "",
    minConfirmation: options.minConfirmation || "finalized",
    vaultBalanceAfter: capture.balances.vault_balance_after,
    destinationBalanceAfter: capture.balances.destination_balance_after,
  };
}

async function payout(options = {}, rpcCall) {
  options = optionsWithEnv(options);
  if (options.productionRpcUrl) assertHttpUrl(options.productionRpcUrl, "production_rpc_url");
  const minConfirmation = options.minConfirmation || "finalized";
  assert(["processed", "confirmed", "finalized"].includes(minConfirmation), "min_confirmation must be processed, confirmed, or finalized");
  const file = path.resolve(options.capture || DEFAULT_CAPTURE);
  const capture = loadJson(file);
  const validation = validateCapture(capture, { requireComplete: true });
  const evidence = await buildEvidence(evidenceOptionsFromCapture(capture, { ...options, minConfirmation }), rpcCall);
  const out = path.resolve(options.out || DEFAULT_PAYOUT);
  writeJson(out, evidence);
  validateProductionPayout(evidence);
  return {
    ok: true,
    kind: "tasc.production_run.capture.payout_result",
    version: "0.1",
    capture_file: rel(file),
    evidence_file: rel(out),
    ...envMetadata(options.envFile, [PRODUCTION_ENV.rpcUrl]),
    capture_complete: validation.complete_for_payout,
    sends_transactions: false,
    accepts_private_keys: false,
    calls_rpc: Boolean(options.productionRpcUrl),
    rpc_host: options.productionRpcUrl ? new URL(options.productionRpcUrl).host : null,
    rpc_url_printed: false,
    no_new_dependencies: true,
  };
}

function mockPayoutRpc(input) {
  return async (_rpcUrl, method, params) => {
    if (method !== "getAccountInfo") throw new Error(`unexpected RPC method ${method}`);
    const pubkey = params[0];
    let amount = null;
    if (pubkey === input.vaultTokenAccount) amount = "0";
    if (pubkey === input.destinationTokenAccount) amount = DEFAULT_AMOUNT_BASE_UNITS;
    assert(amount !== null, `unexpected payout token account ${pubkey}`);
    return {
      value: {
        owner: TOKEN_PROGRAM_ID,
        data: [
          encodeTokenAccount({
            pubkey,
            mint: input.tokenMint,
            owner: input.worker,
            amount,
          }).toString("base64"),
          "base64",
        ],
      },
    };
  };
}

function sampleAddress(byte) {
  return base58Encode(Buffer.alloc(32, byte));
}

function sampleSignature(byte) {
  return base58Encode(Buffer.alloc(64, byte));
}

async function sampleSignedIntent(file, input) {
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
    verifier: input.verifier,
    programId: input.programId,
    tokenMint: input.tokenMint,
    inputs: { url: "https://docs.cdp.coinbase.com/x402/welcome" },
    now: "1800000000",
    nonce: "9001",
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
    buyer: buyer.address,
    signed_intent_file: file,
  };
}

async function selfTest() {
  fs.mkdirSync(path.join(ROOT, ".tascverifier"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, ".tascverifier", "production-run-capture-"));
  const captureFile = path.join(dir, "capture.json");
  const signedIntentFile = path.join(dir, "production-intent.signature.json");
  const programId = sampleAddress(31);
  const tokenMint = sampleAddress(32);
  const verifier = sampleAddress(33);
  const worker = sampleAddress(34);
  const destination = sampleAddress(35);
  const resultHash = `0x${"38".repeat(32)}`;
  const envFile = path.join(dir, ".env.solana-mainnet.local");
  fs.writeFileSync(envFile, [
    `${PRODUCTION_ENV.rpcUrl}=https://mainnet.example.com/sensitive/rpc?credential=env-do-not-store`,
    `${PRODUCTION_ENV.programId}=${programId}`,
    `${PRODUCTION_ENV.tokenMint}=${tokenMint}`,
    `${PRODUCTION_ENV.worker}=${worker}`,
    `${PRODUCTION_ENV.workerUsdc}=${destination}`,
    "",
  ].join("\n"));
  const previousProcessEnv = new Map(Object.values(PRODUCTION_ENV).map((key) => [key, process.env[key]]));
  Object.values(PRODUCTION_ENV).forEach((key) => delete process.env[key]);
  try {
  const signed = await sampleSignedIntent(signedIntentFile, { programId, tokenMint, verifier });
  const recentBlockhash = sampleAddress(36);
  const offlineEnvFile = path.join(dir, "offline-transaction-build.env");
  const fundTransactionFile = path.join(dir, "production-fund-transaction.json");
  const fundTransaction = await buildProductionFundTransaction({
    envFile: offlineEnvFile,
    signedIntent: signed.signed_intent_file,
    buyerUsdcTokenAccount: sampleAddress(37),
    recentBlockhash,
    taskRentLamports: "1",
    vaultTokenRentLamports: "1",
  });
  writeJson(fundTransactionFile, fundTransaction);
  const taskAccount = fundTransaction.task_account;
  const vault = fundTransaction.vault_token_account;
  const claimTransactionFile = path.join(dir, "production-lifecycle-claim.json");
  writeJson(claimTransactionFile, await buildProductionLifecycleTransaction({
    envFile: offlineEnvFile,
    action: "claim",
    signedIntent: signed.signed_intent_file,
    taskAccount,
    signer: worker,
    recentBlockhash,
  }));
  const attestTransactionFile = path.join(dir, "production-lifecycle-attest.json");
  writeJson(attestTransactionFile, await buildProductionLifecycleTransaction({
    envFile: offlineEnvFile,
    action: "attest",
    signedIntent: signed.signed_intent_file,
    taskAccount,
    signer: verifier,
    resultHash,
    verdict: "pass",
    recentBlockhash,
  }));
  const releaseTransactionFile = path.join(dir, "production-lifecycle-release.json");
  writeJson(releaseTransactionFile, await buildProductionLifecycleTransaction({
    envFile: offlineEnvFile,
    action: "release",
    signedIntent: signed.signed_intent_file,
    taskAccount,
    signer: worker,
    destinationTokenAccount: destination,
    recentBlockhash,
  }));
  const planResult = plan({ capture: captureFile });
  assert(planResult.sends_transactions === false, "plan must not send transactions");
  assert(planResult.writes_files === false, "plan must not write files");

  const initResult = init({
    envFile,
    capture: captureFile,
    signedIntent: signed.signed_intent_file,
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert(initResult.ok === true, "init should succeed");
  assert(fs.existsSync(captureFile), "init should write capture");

  record({
    capture: captureFile,
    transaction: fundTransactionFile,
    signature: sampleSignature(40),
    generatedAt: "2026-01-01T00:00:01.000Z",
  });
  record({
    capture: captureFile,
    transaction: claimTransactionFile,
    signature: sampleSignature(41),
    claimStartedAt: "2026-01-01T00:00:02.000Z",
    generatedAt: "2026-01-01T00:00:02.000Z",
  });
  record({
    capture: captureFile,
    transaction: attestTransactionFile,
    signature: sampleSignature(42),
    generatedAt: "2026-01-01T00:00:03.000Z",
  });
  const completed = record({
    capture: captureFile,
    transaction: releaseTransactionFile,
    signature: sampleSignature(43),
    releaseConfirmedAt: "2026-01-01T00:00:06.669Z",
    completedIndexedAt: "2026-01-01T00:00:06.751Z",
    vaultBalanceAfter: "0",
    destinationBalanceAfter: DEFAULT_AMOUNT_BASE_UNITS,
    generatedAt: "2026-01-01T00:00:07.000Z",
  });
  assert(completed.complete_for_payout === true, "capture should be complete");
  const capture = loadJson(captureFile);
  const validation = validateCapture(capture, { requireComplete: true });
  assert(validation.complete_for_payout === true, "validation should be complete");
  const payoutFile = path.join(dir, "production-payout-evidence.json");
  const payoutResult = await payout({
    envFile,
    capture: captureFile,
    out: payoutFile,
    generatedAt: "2026-01-01T00:00:08.000Z",
  }, mockPayoutRpc({
    tokenMint,
    worker,
    vaultTokenAccount: vault,
    destinationTokenAccount: destination,
  }));
  assert(payoutResult.ok === true, "payout should build");
  const evidence = loadJson(payoutFile);
  assert(evidence.settlement.buyer === signed.buyer, "payout evidence should keep signed buyer");
  assert(evidence.settlement.worker === worker, "payout evidence should keep worker");
  assert(evidence.settlement.task_account === taskAccount, "payout evidence should keep artifact task account");
  assert(evidence.settlement.vault_token_account === vault, "payout evidence should keep artifact vault account");
  assert(evidence.timing.claim_to_release_ms === 4669, "claim-to-release timing mismatch");
  assert(evidence.source.rpc_host === "mainnet.example.com", "payout should only persist RPC host");
  const payoutText = JSON.stringify(evidence);
  assert(!payoutText.includes("env-do-not-store"), "payout evidence must not store RPC query credential");
  assert(!payoutText.includes("/sensitive/rpc"), "payout evidence must not store full RPC path");

  let rejectedMismatchedArtifact = false;
  try {
    const mismatchedFile = path.join(dir, "production-lifecycle-attest-mismatch.json");
    const mismatched = loadJson(attestTransactionFile);
    mismatched.task_account = sampleAddress(44);
    writeJson(mismatchedFile, mismatched);
    record({
      capture: captureFile,
      transaction: mismatchedFile,
      signature: sampleSignature(45),
      generatedAt: "2026-01-01T00:00:09.000Z",
    });
  } catch {
    rejectedMismatchedArtifact = true;
  }
  assert(rejectedMismatchedArtifact, "mismatched transaction artifact should be rejected");

  let rejectedIncomplete = false;
  try {
    const incomplete = blankCapture("2026-01-01T00:00:00.000Z");
    validateCapture(incomplete, { requireComplete: true });
  } catch {
    rejectedIncomplete = true;
  }
  assert(rejectedIncomplete, "incomplete capture should be rejected");

  return {
    ok: true,
    self_test: true,
    plan_safe: true,
    init_capture: true,
    record_capture: true,
    record_from_transaction_artifacts: true,
    validate_capture: true,
    payout_from_capture: true,
    env_file_config: true,
    rejected_mismatched_transaction_artifact: true,
    rejected_incomplete_capture: true,
    sends_transactions: false,
    accepts_private_keys: false,
    no_new_dependencies: true,
  };
  } finally {
    Object.values(PRODUCTION_ENV).forEach((key) => {
      const value = previousProcessEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
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
  if (options.command === "init") {
    process.stdout.write(`${JSON.stringify(init(options), null, 2)}\n`);
    return;
  }
  if (options.command === "record") {
    process.stdout.write(`${JSON.stringify(record(options), null, 2)}\n`);
    return;
  }
  if (options.command === "validate") {
    process.stdout.write(`${JSON.stringify(validateCapture(loadJson(path.resolve(options.capture)), { requireComplete: true }), null, 2)}\n`);
    return;
  }
  if (options.command === "payout") {
    process.stdout.write(`${JSON.stringify(await payout(options), null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`record-production-run-capture: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  init,
  payout,
  plan,
  record,
  selfTest,
  validateCapture,
};
