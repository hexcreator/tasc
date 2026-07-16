#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { validate: validateTimedPayout } = require("./validate-timed-payout-proof");
const { base58Decode, base58Encode } = require("./run-solana-devnet");
const {
  TASK_ACCOUNT_SIZE,
  decodeTaskAccount,
  encodeTaskAccount,
} = require("./tascsolana-program");
const {
  TOKEN_PROGRAM_ID,
  decodeTokenAccountData,
  encodeTokenAccount,
} = require("./tascsolana-spl");

const ROOT = path.resolve(__dirname, "..");
const TARGET_MS = 60_000;
const MIN_USDC_BASE_UNITS = 10_000_000n;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const TEST_NETWORK_RE = /(devnet|testnet|sepolia|local|mock|fixture|example)/i;
const CONFIRMATION_ORDER = {
  processed: 0,
  confirmed: 1,
  finalized: 2,
};

function usage() {
  console.error([
    "Usage:",
    "  node bin/validate-real-money-readiness.js plan [options]",
    "  node bin/validate-real-money-readiness.js validate [options]",
    "  node bin/validate-real-money-readiness.js --self-test",
    "",
    "Options:",
    "  --timed-proof <proof-summary.json>          devnet timed payout proof from npm run earn:devnet",
    "  --production-payout <evidence.json>         real-money payout evidence JSON",
    "  --production-rpc-url <url>                  Solana mainnet RPC URL for live verification",
    "  --expected-genesis-hash <hash>              expected mainnet genesis hash for the RPC",
    "  --min-confirmation <status>                 processed, confirmed, or finalized; default finalized",
    "  --allow-example                            validate example fixture schema without marking ready",
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

function parseArgs(argv) {
  const options = {
    command: "validate",
    timedProof: "",
    productionPayout: "",
    productionRpcUrl: "",
    expectedGenesisHash: "",
    minConfirmation: "finalized",
    allowExample: false,
    selfTest: false,
  };
  const args = [...argv];
  if (args[0] === "plan" || args[0] === "validate") options.command = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--timed-proof") {
      options.timedProof = args[++i] || "";
      if (!options.timedProof) usage();
    } else if (arg === "--production-payout") {
      options.productionPayout = args[++i] || "";
      if (!options.productionPayout) usage();
    } else if (arg === "--production-rpc-url") {
      options.productionRpcUrl = args[++i] || "";
      if (!options.productionRpcUrl) usage();
    } else if (arg === "--expected-genesis-hash") {
      options.expectedGenesisHash = args[++i] || "";
      if (!options.expectedGenesisHash) usage();
    } else if (arg === "--min-confirmation") {
      options.minConfirmation = args[++i] || "";
      if (!Object.prototype.hasOwnProperty.call(CONFIRMATION_ORDER, options.minConfirmation)) usage();
    } else if (arg === "--allow-example") {
      options.allowExample = true;
    } else if (arg === "--self-test") {
      options.selfTest = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  return options;
}

function assertString(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} is required`);
}

function assertIso(value, label) {
  assertString(value, label);
  assert(Number.isFinite(Date.parse(value)), `${label} must be an ISO timestamp`);
}

function assertBaseUnits(value, label) {
  assert(/^[0-9]+$/.test(String(value || "")), `${label} must be integer base units`);
  return BigInt(value);
}

function assertU64String(value, label) {
  assert(/^[0-9]+$/.test(String(value || "")), `${label} must be a u64 integer string`);
  const parsed = BigInt(value);
  assert(parsed >= 0n && parsed <= ((1n << 64n) - 1n), `${label} exceeds u64`);
  return String(value);
}

function assertBytes32(value, label) {
  assertString(value, label);
  assert(/^0x[a-fA-F0-9]{64}$/.test(value), `${label} must be bytes32 hex`);
  return value.toLowerCase();
}

function assertSolanaAddress(value, label) {
  assertString(value, label);
  assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value), `${label} must be a Solana base58 address`);
  const decoded = base58Decode(value);
  assert(decoded.length === 32, `${label} must decode to 32 bytes`);
  return value;
}

function assertSignature(value, label) {
  assertString(value, label);
  assert(/^[1-9A-HJ-NP-Za-km-z]{40,100}$/.test(value), `${label} must look like a Solana signature`);
}

function assertHttpUrl(value, label) {
  assertString(value, label);
  const url = new URL(value);
  assert(url.protocol === "http:" || url.protocol === "https:", `${label} must be http(s)`);
}

function validateProductionPayout(payload, options = {}) {
  assert(payload && typeof payload === "object", "production payout evidence must be a JSON object");
  assert(payload.kind === "tasc.production_payout.evidence", "production payout evidence kind mismatch");
  assert(payload.version === "0.1", "production payout evidence version mismatch");
  assertIso(payload.generated_at, "generated_at");

  const exampleOnly = payload.example_only === true;
  if (exampleOnly) {
    assert(options.allowExample === true, "example production payout evidence requires --allow-example");
    assert(payload.real_money === false, "example production payout evidence must not set real_money true");
  } else {
    assert(payload.real_money === true, "real_money must be true for production readiness");
  }

  const network = payload.network || {};
  assert(network.chain === "solana", "network.chain must be solana for this readiness gate");
  assertString(network.cluster, "network.cluster");
  assert(network.network_type === "mainnet", "network.network_type must be mainnet");
  assert(!TEST_NETWORK_RE.test(network.cluster), "production payout network must not be devnet/testnet/local/example");

  const token = payload.token || {};
  assert(token.symbol === "USDC", "token.symbol must be USDC");
  assert(token.decimals === 6, "token.decimals must be 6");
  assert(token.production_asset === true, "token.production_asset must be true");
  if (exampleOnly) assertString(token.mint, "token.mint");
  else assertSolanaAddress(token.mint, "token.mint");

  const amount = payload.amount || {};
  assert(amount.display === "10 USDC", "amount.display must be 10 USDC");
  const baseUnits = assertBaseUnits(amount.base_units, "amount.base_units");
  assert(baseUnits >= MIN_USDC_BASE_UNITS, "amount.base_units must be at least 10000000");

  const settlement = payload.settlement || {};
  if (exampleOnly) {
    assertString(settlement.program_id, "settlement.program_id");
    assertString(settlement.task_hash, "settlement.task_hash");
    assertString(settlement.buyer, "settlement.buyer");
    assertString(settlement.worker, "settlement.worker");
    assertString(settlement.verifier, "settlement.verifier");
    assertString(settlement.deadline_unix, "settlement.deadline_unix");
    assertString(settlement.nonce, "settlement.nonce");
    assertString(settlement.result_hash, "settlement.result_hash");
  } else {
    assertSolanaAddress(settlement.program_id, "settlement.program_id");
    assertBytes32(settlement.task_hash, "settlement.task_hash");
    assertSolanaAddress(settlement.buyer, "settlement.buyer");
    assertSolanaAddress(settlement.worker, "settlement.worker");
    assertSolanaAddress(settlement.verifier, "settlement.verifier");
    assertU64String(settlement.deadline_unix, "settlement.deadline_unix");
    assertU64String(settlement.nonce, "settlement.nonce");
    assertBytes32(settlement.result_hash, "settlement.result_hash");
    assert(settlement.result_hash !== ZERO_BYTES32, "settlement.result_hash must not be zero for release evidence");
  }
  assert(settlement.completed_status === "Released", "settlement.completed_status must be Released");
  assert(settlement.action === "release", "settlement.action must be release");
  if (exampleOnly) {
    assertString(settlement.task_account, "settlement.task_account");
    assertString(settlement.vault_token_account, "settlement.vault_token_account");
    assertString(settlement.destination_token_account, "settlement.destination_token_account");
  } else {
    assertSolanaAddress(settlement.task_account, "settlement.task_account");
    assertSolanaAddress(settlement.vault_token_account, "settlement.vault_token_account");
    assertSolanaAddress(settlement.destination_token_account, "settlement.destination_token_account");
  }
  assert(settlement.destination_role === "worker", "settlement.destination_role must be worker");
  assertBaseUnits(settlement.vault_balance_after, "settlement.vault_balance_after");
  assert(settlement.vault_balance_after === "0", "settlement vault must be empty after release");
  const destinationBalance = assertBaseUnits(settlement.destination_balance_after, "settlement.destination_balance_after");
  assert(destinationBalance >= baseUnits, "worker destination must hold at least the released amount");

  const timing = payload.timing || {};
  assert(timing.target_ms === TARGET_MS, "timing.target_ms must be 60000");
  assert(Number.isInteger(timing.claim_to_release_ms), "timing.claim_to_release_ms must be integer");
  assert(Number.isInteger(timing.claim_to_completed_index_ms), "timing.claim_to_completed_index_ms must be integer");
  assert(timing.claim_to_release_ms >= 0, "timing.claim_to_release_ms must be nonnegative");
  assert(timing.claim_to_completed_index_ms >= timing.claim_to_release_ms, "completed-index timing should be >= release timing");
  assert(timing.claim_to_release_ms <= TARGET_MS, "claim-to-release exceeded 60 seconds");
  assert(timing.claim_to_completed_index_ms <= TARGET_MS, "claim-to-completed-index exceeded 60 seconds");
  assert(timing.under_60s_to_release_confirmation === true, "release under_60s flag must be true");
  assert(timing.under_60s_to_completed_index === true, "completed-index under_60s flag must be true");

  const signatures = payload.signatures || {};
  assertSignature(signatures.fund, "signatures.fund");
  assertSignature(signatures.claim, "signatures.claim");
  assertSignature(signatures.attest, "signatures.attest");
  assertSignature(signatures.release, "signatures.release");

  return {
    ok: true,
    schema_valid: true,
    real_money_ready: !exampleOnly,
    example_only: exampleOnly,
    network: {
      chain: network.chain,
      cluster: network.cluster,
      network_type: network.network_type,
    },
    token: {
      symbol: token.symbol,
      mint: token.mint,
      decimals: token.decimals,
      production_asset: token.production_asset,
    },
    amount: {
      display: amount.display,
      base_units: amount.base_units,
    },
    settlement: {
      program_id: settlement.program_id,
      completed_status: settlement.completed_status,
      action: settlement.action,
      task_hash: settlement.task_hash,
      task_account: settlement.task_account,
      buyer: settlement.buyer,
      worker: settlement.worker,
      verifier: settlement.verifier,
      deadline_unix: settlement.deadline_unix,
      nonce: settlement.nonce,
      result_hash: settlement.result_hash,
      destination_token_account: settlement.destination_token_account,
      vault_balance_after: settlement.vault_balance_after,
      destination_balance_after: settlement.destination_balance_after,
    },
    timing: {
      claim_to_release_ms: timing.claim_to_release_ms,
      claim_to_completed_index_ms: timing.claim_to_completed_index_ms,
      target_ms: timing.target_ms,
      under_60s_to_release_confirmation: timing.under_60s_to_release_confirmation,
      under_60s_to_completed_index: timing.under_60s_to_completed_index,
    },
  };
}

function sameBytes32(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function confirmationStatusName(status) {
  if (!status) return "";
  if (status.confirmationStatus && Object.prototype.hasOwnProperty.call(CONFIRMATION_ORDER, status.confirmationStatus)) {
    return status.confirmationStatus;
  }
  if (status.confirmations === null) return "finalized";
  if (Number.isInteger(status.confirmations)) return "confirmed";
  return "";
}

function assertConfirmationAtLeast(status, minimum, label) {
  const actual = confirmationStatusName(status);
  assert(actual, `${label} confirmation status is missing`);
  assert(CONFIRMATION_ORDER[actual] >= CONFIRMATION_ORDER[minimum], `${label} confirmation ${actual} is below ${minimum}`);
}

async function defaultRpcCall(rpcUrl, method, params) {
  assert(typeof fetch === "function", "global fetch is required for Solana RPC verification");
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

function rpcHost(rpcUrl) {
  return new URL(rpcUrl).host;
}

function signatureList(payload) {
  const signatures = payload.signatures || {};
  return [
    ["fund", signatures.fund],
    ["claim", signatures.claim],
    ["attest", signatures.attest],
    ["release", signatures.release],
  ];
}

async function verifyProductionSignatures(payload, options, rpcCall) {
  const signatures = signatureList(payload);
  const values = signatures.map(([, signature]) => signature);
  const result = await rpcCall(options.productionRpcUrl, "getSignatureStatuses", [
    values,
    { searchTransactionHistory: true },
  ]);
  const statuses = result && Array.isArray(result.value) ? result.value : [];
  assert(statuses.length === values.length, "production RPC signature status count mismatch");
  const checked = {};
  signatures.forEach(([label, signature], index) => {
    const status = statuses[index];
    assert(status, `production RPC status missing for ${label} signature ${signature}`);
    assert(!status.err, `production ${label} transaction has error ${JSON.stringify(status.err)}`);
    assertConfirmationAtLeast(status, options.minConfirmation, `production ${label} transaction`);
    checked[label] = {
      signature,
      confirmation_status: confirmationStatusName(status),
    };
  });
  return {
    checked: signatures.length,
    minimum_confirmation: options.minConfirmation,
    signatures: checked,
  };
}

async function fetchTaskAccount(rpcUrl, pubkey, expectedOwner, options, rpcCall) {
  const result = await rpcCall(rpcUrl, "getAccountInfo", [
    pubkey,
    {
      commitment: options.minConfirmation,
      encoding: "base64",
    },
  ]);
  const value = result && result.value;
  assert(value, `production task account ${pubkey} not found`);
  assert(value.owner === expectedOwner, `production task account ${pubkey} must be owned by deployed program`);
  assert(Array.isArray(value.data) && value.data[1] === "base64", `production task account ${pubkey} must return base64 data`);
  const raw = Buffer.from(value.data[0], "base64");
  assert(raw.length === TASK_ACCOUNT_SIZE, `production task account ${pubkey} must be ${TASK_ACCOUNT_SIZE} bytes`);
  return {
    pubkey,
    owner: value.owner,
    decoded: decodeTaskAccount(raw, {
      programId: expectedOwner,
      taskPda: pubkey,
    }),
  };
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
  return {
    pubkey,
    owner: value.owner,
    decoded: decodeTokenAccountData(value.data[0]),
  };
}

async function verifyProductionTokenAccounts(payload, options, rpcCall) {
  const settlement = payload.settlement || {};
  const token = payload.token || {};
  const amount = payload.amount || {};
  const vault = await fetchTokenAccount(options.productionRpcUrl, settlement.vault_token_account, options, rpcCall);
  const destination = await fetchTokenAccount(options.productionRpcUrl, settlement.destination_token_account, options, rpcCall);
  assert(vault.decoded.mint === token.mint, "production vault token account mint mismatch");
  assert(destination.decoded.mint === token.mint, "production destination token account mint mismatch");
  assert(vault.decoded.amount === settlement.vault_balance_after, "production vault token account balance mismatch");
  assert(destination.decoded.amount === settlement.destination_balance_after, "production destination token account balance mismatch");
  assert(BigInt(destination.decoded.amount) >= BigInt(amount.base_units), "production destination token account does not hold released amount");
  return {
    checked: 2,
    token_program_id: TOKEN_PROGRAM_ID,
    token_mint: token.mint,
    vault_token_account: {
      pubkey: vault.pubkey,
      amount: vault.decoded.amount,
    },
    destination_token_account: {
      pubkey: destination.pubkey,
      amount: destination.decoded.amount,
    },
  };
}

async function verifyProductionTaskAccount(payload, options, rpcCall) {
  const settlement = payload.settlement || {};
  const token = payload.token || {};
  const amount = payload.amount || {};
  const account = await fetchTaskAccount(
    options.productionRpcUrl,
    settlement.task_account,
    settlement.program_id,
    options,
    rpcCall,
  );
  const decoded = account.decoded;
  assert(decoded.status === "Released", "production task account status must be Released");
  assert(sameBytes32(decoded.task_hash, settlement.task_hash), "production task account task_hash mismatch");
  assert(decoded.buyer === settlement.buyer, "production task account buyer mismatch");
  assert(decoded.worker === settlement.worker, "production task account worker mismatch");
  assert(decoded.verifier === settlement.verifier, "production task account verifier mismatch");
  assert(decoded.token_mint === token.mint, "production task account token_mint mismatch");
  assert(decoded.vault === settlement.vault_token_account, "production task account vault mismatch");
  assert(decoded.amount === amount.base_units, "production task account amount mismatch");
  assert(decoded.deadline_unix === settlement.deadline_unix, "production task account deadline_unix mismatch");
  assert(decoded.nonce === settlement.nonce, "production task account nonce mismatch");
  assert(sameBytes32(decoded.result_hash, settlement.result_hash), "production task account result_hash mismatch");
  assert(decoded.result_hash !== ZERO_BYTES32, "production task account result_hash must not be zero");
  return {
    checked: 1,
    program_id: settlement.program_id,
    task_account: {
      pubkey: account.pubkey,
      owner: account.owner,
      status: decoded.status,
      task_hash: decoded.task_hash,
      buyer: decoded.buyer,
      worker: decoded.worker,
      verifier: decoded.verifier,
      token_mint: decoded.token_mint,
      vault_token_account: decoded.vault,
      amount: decoded.amount,
      deadline_unix: decoded.deadline_unix,
      nonce: decoded.nonce,
      result_hash: decoded.result_hash,
      updated_slot: decoded.updated_slot,
    },
  };
}

async function verifyProductionRpc(payload, options = {}, rpcCall = defaultRpcCall) {
  assertHttpUrl(options.productionRpcUrl, "production RPC URL");
  assertString(options.expectedGenesisHash, "expected genesis hash");
  const genesisHash = await rpcCall(options.productionRpcUrl, "getGenesisHash", []);
  assert(genesisHash === options.expectedGenesisHash, "production RPC genesis hash mismatch");
  const signatures = await verifyProductionSignatures(payload, options, rpcCall);
  const taskAccount = await verifyProductionTaskAccount(payload, options, rpcCall);
  const tokenAccounts = await verifyProductionTokenAccounts(payload, options, rpcCall);
  return {
    ok: true,
    rpc_host: rpcHost(options.productionRpcUrl),
    rpc_url_printed: false,
    genesis_hash: genesisHash,
    minimum_confirmation: options.minConfirmation,
    signatures,
    task_account: taskAccount,
    token_accounts: tokenAccounts,
  };
}

async function validateReadiness(options = {}) {
  const missing = [];
  let timedProof = null;
  let productionPayout = null;
  let productionRpc = null;
  let productionPayload = null;

  if (options.timedProof) {
    timedProof = validateTimedPayout(path.resolve(options.timedProof));
  } else {
    missing.push("timed devnet payout proof from npm run earn:devnet");
  }

  if (options.productionPayout) {
    productionPayload = loadJson(options.productionPayout);
    productionPayout = validateProductionPayout(productionPayload, {
      allowExample: options.allowExample,
    });
    if (!productionPayout.real_money_ready) {
      missing.push("non-example real-money payout evidence");
    } else if (!options.productionRpcUrl || !options.expectedGenesisHash) {
      missing.push("live mainnet RPC verification");
    } else {
      productionRpc = await verifyProductionRpc(productionPayload, options, options.rpcCall || defaultRpcCall);
    }
  } else {
    missing.push("real USDC production payout evidence");
  }

  const ready = Boolean(timedProof && productionPayout && productionPayout.real_money_ready && productionRpc);
  return {
    ok: true,
    kind: "tasc.real_money.readiness",
    version: "0.1",
    ready_for_goal: ready,
    goal: "make $10 in less than a minute",
    timed_devnet_proof: timedProof
      ? {
        ok: true,
        proof_summary: timedProof.proof_summary,
        claim_to_completed_index_ms: timedProof.timing.claim_to_completed_index_ms,
        under_60s_to_completed_index: timedProof.timing.under_60s_to_completed_index,
      }
      : null,
    production_payout: productionPayout,
    production_rpc: productionRpc,
    missing,
    next_required_evidence: ready ? [] : [
      "mainnet production asset funding evidence",
      "mainnet RPC genesis hash verification",
      "mainnet worker claim signature",
      "mainnet verifier attest signature",
      "mainnet release signature",
      "released mainnet task account owned by deployed program",
      "post-release vault balance of 0",
      "post-release worker USDC balance >= 10000000 base units",
      "claim-to-release and claim-to-completed-index timing <= 60000ms",
    ],
    no_new_dependencies: true,
  };
}

async function plan(options = {}) {
  const result = await validateReadiness({
    ...options,
    productionRpcUrl: "",
    expectedGenesisHash: "",
  });
  return {
    ...result,
    mode: "plan",
    sends_transactions: false,
    calls_rpc: false,
    writes_files: false,
    production_schema_example: "examples/private-beta/production-payout-evidence.example.json",
    commands: {
      devnet_timed_proof: "GLOBAL_TASC_ALLOW_SOLANA_DEVNET_PROOF=1 npm run earn:devnet",
      validate_timed_proof: "npm run validate:timed-payout -- examples/solana-devnet/proofs/<run-id>/proof-summary.json",
      init_production_capture: "npm run real:capture:init -- --signed-intent .tascverifier/production-intent/production-intent.signature.json --program-id <program-id> --token-mint <mainnet-usdc-mint> --worker <worker-wallet> --destination-token-account <worker-token-account>",
      record_production_evidence: "npm run real:capture:record -- --fund-signature <fund-sig> --task-account <task-account> --vault-token-account <vault-token-account>",
      build_production_payout: "npm run real:capture:payout -- --production-rpc-url <mainnet-rpc-url>",
      validate_readiness: "npm run real:readiness -- --timed-proof examples/solana-devnet/proofs/<run-id>/proof-summary.json --production-payout .tascverifier/production-payout-evidence.json --production-rpc-url <mainnet-rpc-url> --expected-genesis-hash <mainnet-genesis-hash>",
    },
  };
}

function sampleAddress(byte) {
  return base58Encode(Buffer.alloc(32, byte));
}

function sampleProductionEvidence(overrides = {}) {
  return {
    kind: "tasc.production_payout.evidence",
    version: "0.1",
    generated_at: "2026-01-01T00:00:00.000Z",
    example_only: false,
    real_money: true,
    network: {
      chain: "solana",
      cluster: "solana-mainnet-beta",
      network_type: "mainnet",
    },
    token: {
      symbol: "USDC",
      decimals: 6,
      mint: "3RP5BZZnumXgV2ivCQSYkfDwRWuqpphcKJGBRzVH1TFx",
      production_asset: true,
    },
    amount: {
      display: "10 USDC",
      base_units: "10000000",
    },
    settlement: {
      program_id: sampleAddress(8),
      completed_status: "Released",
      action: "release",
      task_hash: "0x7a65571d274b9d680d14bb05e2a5c736e7f2a2edb7fe0cc235f0fcdc7f81e465",
      task_account: "9h2CPTQfhpQWD3fddC5tdcfMfLCJ4WtudZU8avAiDdCH",
      buyer: sampleAddress(18),
      worker: sampleAddress(19),
      verifier: sampleAddress(20),
      deadline_unix: "1800000000",
      nonce: "9001",
      result_hash: "0x0bdfacb7e0ec2c3241da82c7b812b1a0fa28945b47c7f8a6b113b4de3779776f",
      vault_token_account: "Bu8kBFdxE6RwFbnz7cyLZDs7ixDrN2AabEPhWk24uE3u",
      destination_role: "worker",
      destination_token_account: "8LRqfMkLZnEwaQecoExQ3P8D9rrzNKvAiYqSLN8cHtFx",
      vault_balance_after: "0",
      destination_balance_after: "10000000",
    },
    timing: {
      target_ms: 60000,
      claim_to_release_ms: 12000,
      claim_to_completed_index_ms: 12500,
      under_60s_to_release_confirmation: true,
      under_60s_to_completed_index: true,
    },
    signatures: {
      fund: "5nHkQn7MxzWzW8vYzYdB9YxQn7MxzWzW8vYzYdB9YxQn7MxzWzW8vYzYdB9YxQ",
      claim: "4nHkQn7MxzWzW8vYzYdB9YxQn7MxzWzW8vYzYdB9YxQn7MxzWzW8vYzYdB9Yx",
      attest: "3nHkQn7MxzWzW8vYzYdB9YxQn7MxzWzW8vYzYdB9YxQn7MxzWzW8vYzYdB9",
      release: "2nHkQn7MxzWzW8vYzYdB9YxQn7MxzWzW8vYzYdB9YxQn7MxzWzW8vYzYd",
    },
    ...overrides,
  };
}

function sampleTimedProof(dir) {
  const evidence = {
    claimable_index_file: path.join(dir, "release.claimable.index.json"),
    completed_index_file: path.join(dir, "release.completed.index.json"),
    settlement_file: path.join(dir, "release.settlement.live.json"),
    release_file: path.join(dir, "release.release.live.json"),
  };
  for (const file of Object.values(evidence)) writeJson(file, { ok: true });
  const summary = {
    ok: true,
    kind: "tasc.solana-devnet.proof",
    no_new_dependencies: true,
    key_material_printed: false,
    rpc_url_printed: false,
    run_id: "readiness_self_test",
    timed_payout: {
      ok: true,
      branch: "release",
      task_hash: "0x7a65571d274b9d680d14bb05e2a5c736e7f2a2edb7fe0cc235f0fcdc7f81e465",
      task_account: "9h2CPTQfhpQWD3fddC5tdcfMfLCJ4WtudZU8avAiDdCH",
      claim_signature: "3at56Z3EKnGcv139GE52M8boknakiTRWVE5xTLnqhn4nSMTsbNV8rM8FpXSxyVEUEB5utF5hTe9uki1x5aofJwZn",
      attest_signature: "4LzrzMhcW9c4hpPpe1iDzHPYt8wY24vNMMS51VbpYM5NeNR4NQ3c3FFFA56WRAyP2bw3wUhhqiNp8RVWSdk71d6U",
      release_signature: "eckKGmhTLQ2RCG3MTwvywKxQQdZvWfTWXoRyrp47dYz1p81F2itERfpDZUakkZKsKS9gCXPF7Q6sjx4CWqNekYa",
      payout: {
        display_reward: "10 USDC",
        amount: "10000000",
        token_mint: "3RP5BZZnumXgV2ivCQSYkfDwRWuqpphcKJGBRzVH1TFx",
        destination_role: "worker",
        completed_status: "Released",
        settlement_action: "release",
        vault_balance_after: "0",
        destination_balance_after: "10000000",
      },
      timing: {
        target_ms: 60000,
        live_deadline: "60s",
        claim_to_release_ms: 4669,
        claim_to_completed_index_ms: 4751,
        under_60s_to_release_confirmation: true,
        under_60s_to_completed_index: true,
      },
      evidence,
    },
  };
  const summaryFile = path.join(dir, "proof-summary.json");
  writeJson(summaryFile, summary);
  return summaryFile;
}

function selfTestProductionRpc(payload, expectedGenesisHash, options = {}) {
  const token = payload.token || {};
  const settlement = payload.settlement || {};
  return async (_rpcUrl, method, params) => {
    if (method === "getGenesisHash") return options.badGenesis ? "wrong-genesis-hash" : expectedGenesisHash;
    if (method === "getSignatureStatuses") {
      return {
        value: params[0].map(() => options.missingStatus ? null : {
          err: null,
          confirmationStatus: options.confirmationStatus || "finalized",
        }),
      };
    }
    if (method === "getAccountInfo") {
      const pubkey = params[0];
      if (pubkey === settlement.task_account) {
        const taskData = encodeTaskAccount({
          status: options.taskStatus || "Released",
          task_hash: settlement.task_hash,
          buyer: settlement.buyer,
          worker: settlement.worker,
          verifier: settlement.verifier,
          token_mint: token.mint,
          vault: options.badTaskVault ? settlement.destination_token_account : settlement.vault_token_account,
          amount: payload.amount.base_units,
          deadline_unix: settlement.deadline_unix,
          nonce: settlement.nonce,
          result_hash: options.badTaskResult ? `0x${"00".repeat(32)}` : settlement.result_hash,
          created_slot: "10",
          updated_slot: "20",
        });
        return {
          value: {
            owner: options.badTaskOwner ? sampleAddress(44) : settlement.program_id,
            data: [
              taskData.toString("base64"),
              "base64",
            ],
          },
        };
      }
      let amount = null;
      if (pubkey === settlement.vault_token_account) amount = options.nonzeroVault ? "1" : settlement.vault_balance_after;
      if (pubkey === settlement.destination_token_account) amount = options.shortDestination ? "9999999" : settlement.destination_balance_after;
      assert(amount !== null, `unexpected production self-test token account ${pubkey}`);
      return {
        value: {
          owner: TOKEN_PROGRAM_ID,
          data: [
            encodeTokenAccount({
              pubkey,
              mint: token.mint,
              owner: "BfRmLmH7ksPRCRxNBi7c8SspN7zKoyuAPKrJMDL5uQCJ",
              amount,
            }).toString("base64"),
            "base64",
          ],
        },
      };
    }
    throw new Error(`unexpected production self-test RPC method ${method}`);
  };
}

async function selfTest() {
  fs.mkdirSync(path.join(ROOT, ".tascverifier"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, ".tascverifier", "real-readiness-"));
  const timedProofFile = sampleTimedProof(dir);
  const realFile = path.join(dir, "production-payout.real.json");
  const exampleFile = path.join(dir, "production-payout.example.json");
  const devnetFile = path.join(dir, "production-payout.devnet.json");
  const smallAmountFile = path.join(dir, "production-payout.small.json");
  writeJson(realFile, sampleProductionEvidence());
  writeJson(exampleFile, sampleProductionEvidence({ example_only: true, real_money: false }));
  writeJson(devnetFile, sampleProductionEvidence({
    network: {
      chain: "solana",
      cluster: "solana-devnet",
      network_type: "mainnet",
    },
  }));
  writeJson(smallAmountFile, sampleProductionEvidence({
    amount: {
      display: "10 USDC",
      base_units: "9999999",
    },
  }));

  const productionPayload = loadJson(realFile);
  const expectedGenesisHash = "mainnet-self-test-genesis-hash";
  const ready = await validateReadiness({
    timedProof: timedProofFile,
    productionPayout: realFile,
    productionRpcUrl: "http://127.0.0.1/mock-mainnet-rpc",
    expectedGenesisHash,
    minConfirmation: "finalized",
    rpcCall: selfTestProductionRpc(productionPayload, expectedGenesisHash),
  });
  assert(ready.ready_for_goal === true, "real evidence plus RPC should mark readiness true");
  assert(ready.production_rpc.task_account.task_account.status === "Released", "ready proof should include released task account");
  const missingProduction = await validateReadiness({ timedProof: timedProofFile });
  assert(missingProduction.ready_for_goal === false, "missing production evidence should not be ready");
  const missingRpc = await validateReadiness({ timedProof: timedProofFile, productionPayout: realFile });
  assert(missingRpc.ready_for_goal === false, "real evidence without RPC should not be ready");
  assert(missingRpc.missing.includes("live mainnet RPC verification"), "missing RPC should be reported");
  const example = await validateReadiness({ timedProof: timedProofFile, productionPayout: exampleFile, allowExample: true });
  assert(example.ready_for_goal === false, "example fixture should not be ready");
  assert(example.production_payout.schema_valid === true, "example fixture schema should validate");

  let rejectedDevnet = false;
  try {
    await validateReadiness({ timedProof: timedProofFile, productionPayout: devnetFile });
  } catch {
    rejectedDevnet = true;
  }
  assert(rejectedDevnet, "devnet production payout evidence should be rejected");

  let rejectedSmallAmount = false;
  try {
    await validateReadiness({ timedProof: timedProofFile, productionPayout: smallAmountFile });
  } catch {
    rejectedSmallAmount = true;
  }
  assert(rejectedSmallAmount, "underfunded production payout evidence should be rejected");

  let rejectedBadGenesis = false;
  try {
    await validateReadiness({
      timedProof: timedProofFile,
      productionPayout: realFile,
      productionRpcUrl: "http://127.0.0.1/mock-mainnet-rpc",
      expectedGenesisHash,
      minConfirmation: "finalized",
      rpcCall: selfTestProductionRpc(productionPayload, expectedGenesisHash, { badGenesis: true }),
    });
  } catch {
    rejectedBadGenesis = true;
  }
  assert(rejectedBadGenesis, "bad genesis hash should be rejected");

  let rejectedShortDestination = false;
  try {
    await validateReadiness({
      timedProof: timedProofFile,
      productionPayout: realFile,
      productionRpcUrl: "http://127.0.0.1/mock-mainnet-rpc",
      expectedGenesisHash,
      minConfirmation: "finalized",
      rpcCall: selfTestProductionRpc(productionPayload, expectedGenesisHash, { shortDestination: true }),
    });
  } catch {
    rejectedShortDestination = true;
  }
  assert(rejectedShortDestination, "short destination balance should be rejected");

  let rejectedTaskOwner = false;
  try {
    await validateReadiness({
      timedProof: timedProofFile,
      productionPayout: realFile,
      productionRpcUrl: "http://127.0.0.1/mock-mainnet-rpc",
      expectedGenesisHash,
      minConfirmation: "finalized",
      rpcCall: selfTestProductionRpc(productionPayload, expectedGenesisHash, { badTaskOwner: true }),
    });
  } catch {
    rejectedTaskOwner = true;
  }
  assert(rejectedTaskOwner, "wrong task owner should be rejected");

  let rejectedTaskStatus = false;
  try {
    await validateReadiness({
      timedProof: timedProofFile,
      productionPayout: realFile,
      productionRpcUrl: "http://127.0.0.1/mock-mainnet-rpc",
      expectedGenesisHash,
      minConfirmation: "finalized",
      rpcCall: selfTestProductionRpc(productionPayload, expectedGenesisHash, { taskStatus: "Passed" }),
    });
  } catch {
    rejectedTaskStatus = true;
  }
  assert(rejectedTaskStatus, "non-released task status should be rejected");

  return {
    ok: true,
    self_test: true,
    ready_case: ready.ready_for_goal,
    missing_production_ready: missingProduction.ready_for_goal,
    missing_rpc_ready: missingRpc.ready_for_goal,
    example_schema_valid: example.production_payout.schema_valid,
    rejected_devnet: rejectedDevnet,
    rejected_underfunded: rejectedSmallAmount,
    rejected_bad_genesis: rejectedBadGenesis,
    rejected_short_destination: rejectedShortDestination,
    rejected_task_owner: rejectedTaskOwner,
    rejected_task_status: rejectedTaskStatus,
    no_new_dependencies: true,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    process.stdout.write(`${JSON.stringify(await selfTest(), null, 2)}\n`);
    return;
  }
  const result = options.command === "plan" ? await plan(options) : await validateReadiness(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`validate-real-money-readiness: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  plan,
  validateProductionPayout,
  validateReadiness,
};
