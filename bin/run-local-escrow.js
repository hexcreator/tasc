#!/usr/bin/env node

const fs = require("fs");
const { ContractFactory, JsonRpcProvider, Wallet, parseUnits } = require("ethers");
const { compile: compileSolidity } = require("./compile-solidity");
const { compile: compileTasc } = require("./tasclang");
const { verifyCompiledTask } = require("./tascverify");
const { taskHashToBytes32 } = require("./tascintent");

const TASC_ARTIFACT = "build/TascEscrow.json";
const MOCK_USDC_ARTIFACT = "build/MockUSDC.json";
const EXAMPLE_TASK = "examples/summarize_url.tasc";
const EXAMPLE_SUBMISSION = "examples/submissions/summarize_url.pass.md";
const EXAMPLE_LEDGER = "examples/ledger.json";
const EXAMPLE_INPUTS = { url: "https://docs.cdp.coinbase.com/x402/welcome" };
const REQUIRED_ENV = [
  "LOCAL_EVM_RPC_URL",
  "GLOBAL_TASC_BUYER_PRIVATE_KEY",
  "GLOBAL_TASC_WORKER_PRIVATE_KEY",
  "GLOBAL_TASC_VERIFIER_PRIVATE_KEY",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadArtifact(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function bigintString(value) {
  return value.toString();
}

async function deploy(factory, signer, args = []) {
  const contract = await factory.connect(signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

function plan() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  return {
    kind: "tasc.local-escrow.plan",
    sends_transactions: false,
    bundled_chain: false,
    required_env: REQUIRED_ENV,
    optional_env: ["LOCAL_EVM_EXPECTED_CHAIN_ID"],
    missing_env: missing,
    note: "Ganache is intentionally not bundled. Start a local RPC such as Anvil, Hardhat, or Ganache separately, then run npm run local-escrow:flow.",
  };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Run npm run local-escrow:plan for required environment.`);
  return value;
}

async function flow() {
  compileSolidity();

  const ethersProvider = new JsonRpcProvider(requireEnv("LOCAL_EVM_RPC_URL"));
  const network = await ethersProvider.getNetwork();
  const expectedChainId = process.env.LOCAL_EVM_EXPECTED_CHAIN_ID;
  if (expectedChainId !== undefined) {
    assert(network.chainId === BigInt(expectedChainId), `expected chain ${expectedChainId}, got ${network.chainId}`);
  }

  const buyer = new Wallet(requireEnv("GLOBAL_TASC_BUYER_PRIVATE_KEY"), ethersProvider);
  const worker = new Wallet(requireEnv("GLOBAL_TASC_WORKER_PRIVATE_KEY"), ethersProvider);
  const verifier = new Wallet(requireEnv("GLOBAL_TASC_VERIFIER_PRIVATE_KEY"), ethersProvider);

  const buyerAddress = buyer.address;
  const workerAddress = worker.address;
  const verifierAddress = verifier.address;

  const tokenArtifact = loadArtifact(MOCK_USDC_ARTIFACT);
  const escrowArtifact = loadArtifact(TASC_ARTIFACT);

  const tokenFactory = new ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, buyer);
  const token = await deploy(tokenFactory, buyer);

  const escrowFactory = new ContractFactory(escrowArtifact.abi, escrowArtifact.bytecode, buyer);
  const escrow = await deploy(escrowFactory, buyer, [verifierAddress]);

  const amount = parseUnits("10", 6);
  const compiledTask = compileTasc(fs.readFileSync(EXAMPLE_TASK, "utf8"));
  const attestation = verifyCompiledTask(
    compiledTask,
    fs.readFileSync(EXAMPLE_SUBMISSION, "utf8"),
    EXAMPLE_INPUTS,
    EXAMPLE_LEDGER,
  );
  assert(attestation.verdict === "pass", "example attestation must pass before on-chain release");

  const taskHash = taskHashToBytes32(compiledTask.task_hash);
  const resultHash = taskHashToBytes32(attestation.result_hash);
  const latest = await ethersProvider.getBlock("latest");
  const deadline = latest.timestamp + 60;

  await (await token.mint(buyerAddress, amount)).wait();
  await (await token.connect(buyer).approve(await escrow.getAddress(), amount)).wait();
  await (await escrow.connect(buyer).fund(taskHash, await token.getAddress(), amount, deadline)).wait();

  assert((await token.balanceOf(await escrow.getAddress())) === amount, "escrow did not receive funded tokens");
  assert((await token.balanceOf(workerAddress)) === 0n, "worker should start with zero token balance");

  await (await escrow.connect(worker).claim(taskHash)).wait();
  await (await escrow.connect(verifier).attest(taskHash, resultHash, true)).wait();
  await (await escrow.connect(buyer).release(taskHash)).wait();

  const escrowBalance = await token.balanceOf(await escrow.getAddress());
  const workerBalance = await token.balanceOf(workerAddress);
  const buyerBalance = await token.balanceOf(buyerAddress);
  const task = await escrow.getTask(taskHash);

  assert(escrowBalance === 0n, "escrow balance should return to zero after release");
  assert(workerBalance === amount, "worker should receive released task amount");
  assert(task.status === 5n, `task status should be Released(5), got ${task.status}`);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    chain_id: Number(network.chainId),
    contracts: {
      token: await token.getAddress(),
      escrow: await escrow.getAddress(),
    },
    actors: {
      buyer: buyerAddress,
      worker: workerAddress,
      verifier: verifierAddress,
    },
    task_hash: taskHash,
    result_hash: resultHash,
    amount: bigintString(amount),
    balances: {
      buyer: bigintString(buyerBalance),
      escrow: bigintString(escrowBalance),
      worker: bigintString(workerBalance),
    },
    status: "Released",
    lifecycle: ["mint", "approve", "fund", "claim", "attest", "release"],
  }, null, 2)}\n`);
}

async function main() {
  const command = process.argv[2] || "plan";
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(plan(), null, 2)}\n`);
    return;
  }
  if (command === "flow") {
    await flow();
    return;
  }
  throw new Error(`Unknown command '${command}'. Use plan or flow.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`run-local-escrow: ${error.message}`);
    process.exit(1);
  });
}
