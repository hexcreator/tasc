#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, ContractFactory, Interface, getAddress, parseUnits } = require("ethers");
const { compile: compileSolidity } = require("./compile-solidity");
const { compile: compileTasc } = require("./tasclang");
const { verifyCompiledTask } = require("./tascverify");
const { taskHashToBytes32 } = require("./tascintent");

const DEFAULT_CHAIN_ID = 84532;
const TASC_ARTIFACT = "build/TascEscrow.json";
const MOCK_USDC_ARTIFACT = "build/MockUSDC.json";
const EXAMPLE_TASK = "examples/summarize_url.tasc";
const EXAMPLE_SUBMISSION = "examples/submissions/summarize_url.pass.md";
const EXAMPLE_LEDGER = "examples/ledger.json";
const EXAMPLE_INPUTS = { url: "https://docs.cdp.coinbase.com/x402/welcome" };
const DEFAULT_SCAN_CONFIRMATIONS = 6;

const ENV = {
  rpcUrl: "BASE_SEPOLIA_RPC_URL",
  buyerKey: "GLOBAL_TASC_BUYER_PRIVATE_KEY",
  workerKey: "GLOBAL_TASC_WORKER_PRIVATE_KEY",
  verifierKey: "GLOBAL_TASC_VERIFIER_PRIVATE_KEY",
  allowTx: "GLOBAL_TASC_ALLOW_TESTNET_TX",
  expectedChainId: "GLOBAL_TASC_EXPECTED_CHAIN_ID",
  amountUsdc: "GLOBAL_TASC_AMOUNT_USDC",
  deadlineSeconds: "GLOBAL_TASC_DEADLINE_SECONDS",
  handoffOut: "GLOBAL_TASC_HANDOFF_OUT",
  scanConfirmations: "GLOBAL_TASC_SCAN_CONFIRMATIONS",
};

function usage() {
  console.error([
    "Usage:",
    "  node bin/run-base-sepolia.js plan",
    "  node bin/run-base-sepolia.js flow [--handoff out.json]",
    "",
    "Private keys are read only from environment variables; never pass them as command arguments.",
  ].join("\n"));
  process.exit(1);
}

function requiredEnvForFlow() {
  return [ENV.rpcUrl, ENV.buyerKey, ENV.workerKey, ENV.verifierKey, ENV.allowTx];
}

function envValue(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function keyAddress(privateKey) {
  return new Wallet(privateKey).address;
}

function readConfig(env = process.env) {
  const expectedChainId = Number(envValue(env, ENV.expectedChainId) || DEFAULT_CHAIN_ID);
  const amountUsdc = envValue(env, ENV.amountUsdc) || "10";
  const deadlineSeconds = Number(envValue(env, ENV.deadlineSeconds) || "60");
  const scanConfirmations = Number(envValue(env, ENV.scanConfirmations) || DEFAULT_SCAN_CONFIRMATIONS);
  const missing = requiredEnvForFlow().filter((name) => !envValue(env, name));
  const allowTx = envValue(env, ENV.allowTx) === "1";

  const config = {
    rpcUrl: envValue(env, ENV.rpcUrl),
    expectedChainId,
    amountUsdc,
    deadlineSeconds,
    handoffOut: envValue(env, ENV.handoffOut),
    scanConfirmations,
    allowTx,
    missing,
    requiredEnv: requiredEnvForFlow(),
    optionalEnv: [ENV.expectedChainId, ENV.amountUsdc, ENV.deadlineSeconds, ENV.handoffOut, ENV.scanConfirmations],
    addresses: {},
  };

  for (const [role, name] of Object.entries({
    buyer: ENV.buyerKey,
    worker: ENV.workerKey,
    verifier: ENV.verifierKey,
  })) {
    const privateKey = envValue(env, name);
    if (privateKey) config.addresses[role] = keyAddress(privateKey);
  }

  return config;
}

function assertRunnableConfig(config) {
  if (config.missing.length > 0) {
    throw new Error(`Missing required environment variables: ${config.missing.join(", ")}`);
  }
  if (!config.allowTx) {
    throw new Error(`${ENV.allowTx}=1 is required before sending public testnet transactions`);
  }
  if (!Number.isInteger(config.expectedChainId) || config.expectedChainId <= 0) {
    throw new Error(`${ENV.expectedChainId} must be a positive integer`);
  }
  if (!Number.isInteger(config.deadlineSeconds) || config.deadlineSeconds <= 0) {
    throw new Error(`${ENV.deadlineSeconds} must be a positive integer`);
  }
  if (!Number.isInteger(config.scanConfirmations) || config.scanConfirmations <= 0) {
    throw new Error(`${ENV.scanConfirmations} must be a positive integer`);
  }
}

function plan(env = process.env) {
  const config = readConfig(env);
  return {
    kind: "tasc.base-sepolia.plan",
    network: {
      name: "Base Sepolia",
      expected_chain_id: config.expectedChainId,
      rpc_url_set: Boolean(config.rpcUrl),
    },
    safety: {
      sends_transactions: false,
      flow_requires: `${ENV.allowTx}=1`,
      private_keys_from_env_only: true,
      uses_mock_usdc: true,
    },
    required_env: config.requiredEnv,
    optional_env: config.optionalEnv,
    missing_env: config.missing,
    configured_addresses: config.addresses,
    handoff_out: config.handoffOut,
    next_command: "npm run base:flow",
  };
}

function loadArtifact(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function deploy(factory, signer, args = []) {
  const contract = await factory.connect(signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

function receiptHash(receipt) {
  return receipt.hash || receipt.transactionHash;
}

function receiptLogIndex(log) {
  return log.logIndex ?? log.index;
}

function findReceiptEvent(receipt, contractAddress, abi, eventName) {
  const iface = new Interface(abi);
  const normalized = getAddress(contractAddress).toLowerCase();
  for (const log of receipt.logs || []) {
    if (getAddress(log.address).toLowerCase() !== normalized) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === eventName) return { log, parsed };
    } catch {
      // Ignore logs from the same transaction that do not belong to this ABI.
    }
  }
  throw new Error(`Missing ${eventName} event in transaction ${receiptHash(receipt)}`);
}

function scannerEnvFromHandoff(handoff) {
  return {
    TASC_SCAN_RPC_URL: "$BASE_SEPOLIA_RPC_URL",
    TASC_SCAN_ESCROW: handoff.contracts.escrow,
    TASC_SCAN_CHAIN_ID: String(handoff.chain_id),
    TASC_SCAN_START_BLOCK: String(handoff.funding_event.block_number),
    TASC_SCAN_CONFIRMATIONS: String(handoff.funding_event.confirmations_required),
  };
}

function buildHandoff(input) {
  const handoff = {
    kind: "tasc.testnet.handoff",
    version: "0.1",
    network: "Base Sepolia",
    chain_id: input.chainId,
    rpc_env: ENV.rpcUrl,
    contracts: input.contracts,
    actors: input.actors,
    task_hash: input.taskHash,
    result_hash: input.resultHash,
    amount: input.amount,
    deadline: input.deadline,
    funding_event: {
      tx_hash: input.fundTxHash,
      block_number: input.fundBlockNumber,
      log_index: input.fundLogIndex,
      confirmations_required: input.confirmationsRequired,
    },
    scanner: {
      command: "npm run scan:funded",
    },
    lifecycle_txs: input.lifecycleTxs,
    note: "Public testnet metadata only. No private keys or RPC secrets are stored here.",
  };
  handoff.scanner.env = scannerEnvFromHandoff(handoff);
  return handoff;
}

function parseFlowArgs(rest) {
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--handoff") options.handoffOut = rest[++i];
    else usage();
  }
  return options;
}

async function flow(env = process.env, options = {}) {
  const config = readConfig(env);
  if (options.handoffOut) config.handoffOut = options.handoffOut;
  assertRunnableConfig(config);
  compileSolidity();

  const provider = new JsonRpcProvider(config.rpcUrl);
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  if (chainId !== config.expectedChainId) {
    throw new Error(`Connected chain ${chainId} does not match expected ${config.expectedChainId}`);
  }

  const buyer = new Wallet(envValue(env, ENV.buyerKey), provider);
  const worker = new Wallet(envValue(env, ENV.workerKey), provider);
  const verifier = new Wallet(envValue(env, ENV.verifierKey), provider);

  const tokenArtifact = loadArtifact(MOCK_USDC_ARTIFACT);
  const escrowArtifact = loadArtifact(TASC_ARTIFACT);
  const token = await deploy(new ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, buyer), buyer);
  const escrow = await deploy(new ContractFactory(escrowArtifact.abi, escrowArtifact.bytecode, buyer), buyer, [verifier.address]);

  const compiledTask = compileTasc(fs.readFileSync(EXAMPLE_TASK, "utf8"));
  const attestation = verifyCompiledTask(
    compiledTask,
    fs.readFileSync(EXAMPLE_SUBMISSION, "utf8"),
    EXAMPLE_INPUTS,
    EXAMPLE_LEDGER,
  );
  if (attestation.verdict !== "pass") throw new Error("Local attestation must pass before testnet release");

  const amount = parseUnits(config.amountUsdc, 6);
  const taskHash = taskHashToBytes32(compiledTask.task_hash);
  const resultHash = taskHashToBytes32(attestation.result_hash);
  const latest = await provider.getBlock("latest");
  const deadline = latest.timestamp + config.deadlineSeconds;

  const mintReceipt = await (await token.connect(buyer).mint(buyer.address, amount)).wait();
  const approveReceipt = await (await token.connect(buyer).approve(await escrow.getAddress(), amount)).wait();
  const fundReceipt = await (await escrow.connect(buyer).fund(taskHash, await token.getAddress(), amount, deadline)).wait();
  const fundedEvent = findReceiptEvent(fundReceipt, await escrow.getAddress(), escrowArtifact.abi, "Funded");
  const claimReceipt = await (await escrow.connect(worker).claim(taskHash)).wait();
  const attestReceipt = await (await escrow.connect(verifier).attest(taskHash, resultHash, true)).wait();
  const releaseReceipt = await (await escrow.connect(buyer).release(taskHash)).wait();

  const buyerBalance = await token.balanceOf(buyer.address);
  const escrowBalance = await token.balanceOf(await escrow.getAddress());
  const workerBalance = await token.balanceOf(worker.address);
  const task = await escrow.getTask(taskHash);
  if (escrowBalance !== 0n) throw new Error("Escrow balance should be zero after release");
  if (workerBalance !== amount) throw new Error("Worker did not receive expected amount");
  if (task.status !== 5n) throw new Error(`Task status should be Released(5), got ${task.status}`);

  const handoff = buildHandoff({
    chainId,
    contracts: {
      token: await token.getAddress(),
      escrow: await escrow.getAddress(),
    },
    actors: {
      buyer: buyer.address,
      worker: worker.address,
      verifier: verifier.address,
    },
    taskHash,
    resultHash,
    amount: amount.toString(),
    deadline,
    fundTxHash: receiptHash(fundReceipt),
    fundBlockNumber: fundReceipt.blockNumber,
    fundLogIndex: receiptLogIndex(fundedEvent.log),
    confirmationsRequired: config.scanConfirmations,
    lifecycleTxs: {
      mint: receiptHash(mintReceipt),
      approve: receiptHash(approveReceipt),
      fund: receiptHash(fundReceipt),
      claim: receiptHash(claimReceipt),
      attest: receiptHash(attestReceipt),
      release: receiptHash(releaseReceipt),
    },
  });
  if (config.handoffOut) writeJson(config.handoffOut, handoff);

  return {
    ok: true,
    chain_id: chainId,
    contracts: handoff.contracts,
    actors: handoff.actors,
    task_hash: taskHash,
    result_hash: resultHash,
    amount: amount.toString(),
    deadline,
    balances: {
      buyer: buyerBalance.toString(),
      escrow: escrowBalance.toString(),
      worker: workerBalance.toString(),
    },
    status: "Released",
    lifecycle: ["deploy", "mint", "approve", "fund", "claim", "attest", "release"],
    funding_event: handoff.funding_event,
    scanner: handoff.scanner,
    handoff_out: config.handoffOut || null,
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(plan(), null, 2)}\n`);
    return;
  }
  if (command === "flow") {
    process.stdout.write(`${JSON.stringify(await flow(process.env, parseFlowArgs(rest)), null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`run-base-sepolia: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  ENV,
  DEFAULT_CHAIN_ID,
  plan,
  readConfig,
  assertRunnableConfig,
  buildHandoff,
  scannerEnvFromHandoff,
  flow,
};
