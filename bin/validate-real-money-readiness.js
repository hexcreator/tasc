#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { validate: validateTimedPayout } = require("./validate-timed-payout-proof");

const ROOT = path.resolve(__dirname, "..");
const TARGET_MS = 60_000;
const MIN_USDC_BASE_UNITS = 10_000_000n;
const TEST_NETWORK_RE = /(devnet|testnet|sepolia|local|mock|fixture|example)/i;

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

function assertSignature(value, label) {
  assertString(value, label);
  assert(/^[1-9A-HJ-NP-Za-km-z]{40,100}$/.test(value), `${label} must look like a Solana signature`);
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
  assertString(token.mint, "token.mint");

  const amount = payload.amount || {};
  assert(amount.display === "10 USDC", "amount.display must be 10 USDC");
  const baseUnits = assertBaseUnits(amount.base_units, "amount.base_units");
  assert(baseUnits >= MIN_USDC_BASE_UNITS, "amount.base_units must be at least 10000000");

  const settlement = payload.settlement || {};
  assert(settlement.completed_status === "Released", "settlement.completed_status must be Released");
  assert(settlement.action === "release", "settlement.action must be release");
  assertString(settlement.task_account, "settlement.task_account");
  assertString(settlement.vault_token_account, "settlement.vault_token_account");
  assertString(settlement.destination_token_account, "settlement.destination_token_account");
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
      completed_status: settlement.completed_status,
      action: settlement.action,
      task_account: settlement.task_account,
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

function validateReadiness(options = {}) {
  const missing = [];
  let timedProof = null;
  let productionPayout = null;

  if (options.timedProof) {
    timedProof = validateTimedPayout(path.resolve(options.timedProof));
  } else {
    missing.push("timed devnet payout proof from npm run earn:devnet");
  }

  if (options.productionPayout) {
    productionPayout = validateProductionPayout(loadJson(options.productionPayout), {
      allowExample: options.allowExample,
    });
    if (!productionPayout.real_money_ready) {
      missing.push("non-example real-money payout evidence");
    }
  } else {
    missing.push("real USDC production payout evidence");
  }

  const ready = Boolean(timedProof && productionPayout && productionPayout.real_money_ready);
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
    missing,
    next_required_evidence: ready ? [] : [
      "mainnet production asset funding evidence",
      "mainnet worker claim signature",
      "mainnet verifier attest signature",
      "mainnet release signature",
      "post-release vault balance of 0",
      "post-release worker USDC balance >= 10000000 base units",
      "claim-to-release and claim-to-completed-index timing <= 60000ms",
    ],
    no_new_dependencies: true,
  };
}

function plan(options = {}) {
  const result = validateReadiness(options);
  return {
    ...result,
    mode: "plan",
    sends_transactions: false,
    writes_files: false,
    production_schema_example: "examples/private-beta/production-payout-evidence.example.json",
    commands: {
      devnet_timed_proof: "GLOBAL_TASC_ALLOW_SOLANA_DEVNET_PROOF=1 npm run earn:devnet",
      validate_timed_proof: "npm run validate:timed-payout -- examples/solana-devnet/proofs/<run-id>/proof-summary.json",
      validate_readiness: "npm run real:readiness -- --timed-proof examples/solana-devnet/proofs/<run-id>/proof-summary.json --production-payout <production-payout-evidence.json>",
    },
  };
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
      mint: "USDCMainnetMintAddressReplaceWithVerifiedMint111",
      production_asset: true,
    },
    amount: {
      display: "10 USDC",
      base_units: "10000000",
    },
    settlement: {
      completed_status: "Released",
      action: "release",
      task_account: "TaskAccountMainnet1111111111111111111111111111",
      vault_token_account: "VaultTokenMainnet11111111111111111111111111",
      destination_role: "worker",
      destination_token_account: "WorkerTokenMainnet111111111111111111111111",
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

function selfTest() {
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

  const ready = validateReadiness({ timedProof: timedProofFile, productionPayout: realFile });
  assert(ready.ready_for_goal === true, "real evidence should mark readiness true");
  const missingProduction = validateReadiness({ timedProof: timedProofFile });
  assert(missingProduction.ready_for_goal === false, "missing production evidence should not be ready");
  const example = validateReadiness({ timedProof: timedProofFile, productionPayout: exampleFile, allowExample: true });
  assert(example.ready_for_goal === false, "example fixture should not be ready");
  assert(example.production_payout.schema_valid === true, "example fixture schema should validate");

  let rejectedDevnet = false;
  try {
    validateReadiness({ timedProof: timedProofFile, productionPayout: devnetFile });
  } catch {
    rejectedDevnet = true;
  }
  assert(rejectedDevnet, "devnet production payout evidence should be rejected");

  let rejectedSmallAmount = false;
  try {
    validateReadiness({ timedProof: timedProofFile, productionPayout: smallAmountFile });
  } catch {
    rejectedSmallAmount = true;
  }
  assert(rejectedSmallAmount, "underfunded production payout evidence should be rejected");

  return {
    ok: true,
    self_test: true,
    ready_case: ready.ready_for_goal,
    missing_production_ready: missingProduction.ready_for_goal,
    example_schema_valid: example.production_payout.schema_valid,
    rejected_devnet: rejectedDevnet,
    rejected_underfunded: rejectedSmallAmount,
    no_new_dependencies: true,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    process.stdout.write(`${JSON.stringify(selfTest(), null, 2)}\n`);
    return;
  }
  const result = options.command === "plan" ? plan(options) : validateReadiness(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-real-money-readiness: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  plan,
  validateProductionPayout,
  validateReadiness,
};
