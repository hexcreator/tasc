#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
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
const {
  SYSTEM_PROGRAM_ID,
  compileLegacyMessage,
  systemCreateAccountWithSeedData,
} = require("./run-solana-fund");
const { verifySignedSolanaIntent } = require("./tascsolana");
const {
  compareAccountToSignedIntent,
  decodeTaskAccount,
} = require("./tascsolana-program");
const {
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  decodeInitializeAccount3Data,
  decodeTokenAccountData,
  decodeTransferCheckedData,
  initializeAccount3Instruction,
  splBuyerTokenAddress,
  splWorkerTokenAddress,
  splWorkerTokenSeed,
  transferCheckedInstruction,
  vaultAuthorityPda,
} = require("./tascsolana-spl");

const DEFAULT_ENV_FILE = ".env.solana-devnet.local";
const DEFAULT_SIGNED_INTENT = "examples/solana-devnet/summarize_url_spl.signature.json";
const DEFAULT_TASK_ACCOUNT = "examples/solana-devnet/summarize_url_spl.lifecycle-account.live.json";
const DEFAULT_FUNDING = "examples/solana-devnet/summarize_url_spl.funding.live.json";
const DEFAULT_WORKER_TOKEN = "examples/solana-devnet/summarize_url_spl.worker-token.live.json";
const DEFAULT_RELEASE_PLAN = "examples/solana-devnet/summarize_url_spl.release-plan.live.json";
const DEFAULT_REFUND_PLAN = "examples/solana-devnet/summarize_url_spl.refund-plan.live.json";
const ALLOW_WORKER_TOKEN_ENV = "GLOBAL_TASC_ALLOW_SOLANA_WORKER_TOKEN_SETUP";
const ZERO_PUBKEY = "11111111111111111111111111111111";

function usage() {
  console.error([
    "Usage:",
    "  node bin/run-solana-spl-settlement.js plan-worker-token [signed-solana-intent.json] [--env file] [--task-account file] [--out file]",
    "  node bin/run-solana-spl-settlement.js send-worker-token [signed-solana-intent.json] [--env file] [--task-account file] [--out file]",
    "  node bin/run-solana-spl-settlement.js plan-release [signed-solana-intent.json] [--task-account file] [--funding file] [--worker-token file] [--out file]",
    "  node bin/run-solana-spl-settlement.js plan-refund [signed-solana-intent.json] [--task-account file] [--funding file] [--buyer-token-account address] [--out file]",
    "",
    `send-worker-token is guarded by ${ALLOW_WORKER_TOKEN_ENV}=1.`,
    "release/refund plans do not send transactions; they define the program-signed SPL Token CPI shape used by lifecycle send commands.",
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
    taskAccountFile: DEFAULT_TASK_ACCOUNT,
    fundingFile: DEFAULT_FUNDING,
    workerTokenFile: DEFAULT_WORKER_TOKEN,
    out: null,
    buyerTokenAccount: null,
    workerTokenAccount: null,
  };
  const args = [...rest];
  if (args[0] && !args[0].startsWith("--")) options.signedFile = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = args[++i];
    else if (arg === "--task-account") options.taskAccountFile = args[++i];
    else if (arg === "--funding") options.fundingFile = args[++i];
    else if (arg === "--worker-token") options.workerTokenFile = args[++i];
    else if (arg === "--worker-token-account") options.workerTokenAccount = args[++i];
    else if (arg === "--buyer-token-account") options.buyerTokenAccount = args[++i];
    else if (arg === "--out") options.out = args[++i];
    else usage();
  }
  return options;
}

function accountMeta(pubkey, signer, writable) {
  return { pubkey, signer: Boolean(signer), writable: Boolean(writable) };
}

function loadSignedIntent(file) {
  const signed = loadJson(file);
  const signatureCheck = verifySignedSolanaIntent(signed);
  assert(signatureCheck.ok, "signed Solana intent signature is invalid");
  return signed;
}

function taskAccountFromArtifact(artifact) {
  assert(artifact, "task account artifact is required");
  if (artifact.decoded) return artifact.decoded;
  assert(artifact.data_base64, "task account artifact missing data_base64");
  return decodeTaskAccount(artifact.data_base64, {
    programId: artifact.owner || artifact.program_id,
    taskPda: artifact.pubkey || artifact.task_pda,
  });
}

function loadTaskAccount(file) {
  return taskAccountFromArtifact(loadJson(file));
}

function loadFunding(file) {
  const funding = loadJson(file);
  assert(funding && funding.kind === "tasc.funding.solana", "funding evidence must be tasc.funding.solana");
  assert(funding.custody, "funding evidence must include SPL custody");
  return funding;
}

function tokenAccountFixtureFromRpc(pubkey, result) {
  assert(result.value, `token account ${pubkey} not found`);
  assert(result.value.owner === TOKEN_PROGRAM_ID, `token account ${pubkey} must be owned by SPL Token Program`);
  assert(Array.isArray(result.value.data), "token account data must be [base64, encoding]");
  assert(result.value.data[1] === "base64", "token account encoding must be base64");
  return {
    kind: "tasc.solana.spl_token.account.live",
    version: "0.1",
    pubkey,
    owner: result.value.owner,
    executable: Boolean(result.value.executable),
    lamports: String(result.value.lamports),
    rent_epoch: String(result.value.rentEpoch ?? "0"),
    data_base64: result.value.data[0],
    context: {
      slot: String(result.context?.slot ?? "0"),
      api_version: result.context?.apiVersion || null,
    },
    decoded: {
      kind: "tasc.solana.spl_token.account",
      version: "0.1",
      pubkey,
      account_owner: result.value.owner,
      ...decodeTokenAccountData(result.value.data[0]),
    },
  };
}

function tokenAccountFromArtifact(artifact, label) {
  if (!artifact) return null;
  const account = artifact.worker_token_account || artifact.buyer_token_account || artifact.token_account || artifact;
  if (!account.data_base64) return null;
  return {
    pubkey: account.pubkey,
    owner: account.owner,
    decoded: account.decoded && account.decoded.mint
      ? account.decoded
      : {
        pubkey: account.pubkey,
        account_owner: account.owner,
        ...decodeTokenAccountData(account.data_base64),
      },
    label,
  };
}

function maybeLoadWorkerToken(file) {
  if (!file || !fs.existsSync(file)) return null;
  return tokenAccountFromArtifact(loadJson(file), "worker_token_account");
}

function validateTaskAndFunding(signed, task, funding) {
  compareAccountToSignedIntent(signed, task);
  const message = signed.intent.message;
  const custody = funding.custody;
  const expectedVaultAuthority = vaultAuthorityPda(message.program_id, message.task_hash, message.token_mint);

  assert(funding.program_id === message.program_id, "funding program_id must match signed intent");
  assert(funding.task_hash.toLowerCase() === message.task_hash.toLowerCase(), "funding task_hash must match signed intent");
  assert(funding.task_pda === task.task_pda, "funding task account must match lifecycle account");
  assert(funding.vault === task.vault, "funding vault must match lifecycle account");
  assert(funding.amount === task.amount, "funding amount must match lifecycle account");
  assert(custody.token_program_id === TOKEN_PROGRAM_ID, "custody token program mismatch");
  assert(custody.vault_token_account === task.vault, "custody vault token account must match task vault");
  assert(custody.vault_authority === expectedVaultAuthority.address, "custody vault authority PDA mismatch");
  assert(custody.token_mint === task.token_mint, "custody mint must match task token mint");
  assert(custody.required_amount === task.amount, "custody required amount must match task amount");
  assert(BigInt(custody.amount) >= BigInt(task.amount), "custody amount must cover task amount");

  return {
    custody,
    expectedVaultAuthority,
  };
}

function workerTokenAddressForTask(task, explicitAddress = null) {
  assert(task.worker && task.worker !== ZERO_PUBKEY, "task must be claimed before a worker token account can be derived");
  const derived = splWorkerTokenAddress(task.worker, task.token_mint);
  if (explicitAddress) {
    assert(assertBase58Address(explicitAddress, "worker_token_account") === derived, "explicit worker token account does not match derived worker token account");
  }
  return derived;
}

function buildWorkerTokenInstructions(task, lamports) {
  const workerTokenSeed = splWorkerTokenSeed(task.worker, task.token_mint);
  const workerTokenAccount = workerTokenAddressForTask(task);
  return {
    worker_token_seed: workerTokenSeed,
    worker_token_account: workerTokenAccount,
    instructions: [
      {
        name: "create_worker_token_account",
        programId: SYSTEM_PROGRAM_ID,
        accounts: [
          accountMeta(task.worker, true, true),
          accountMeta(workerTokenAccount, false, true),
        ],
        data: systemCreateAccountWithSeedData({
          base: task.worker,
          seed: workerTokenSeed,
          lamports,
          space: TOKEN_ACCOUNT_SIZE,
          owner: TOKEN_PROGRAM_ID,
        }),
      },
      initializeAccount3Instruction({
        account: workerTokenAccount,
        mint: task.token_mint,
        owner: task.worker,
      }),
    ],
  };
}

function buildWorkerTokenPlan(options = {}) {
  const signed = options.signed || loadSignedIntent(options.signedFile || DEFAULT_SIGNED_INTENT);
  const task = options.task || loadTaskAccount(options.taskAccountFile || DEFAULT_TASK_ACCOUNT);
  compareAccountToSignedIntent(signed, task);
  const workerTokenAccount = workerTokenAddressForTask(task, options.workerTokenAccount);
  const workerTokenSeed = splWorkerTokenSeed(task.worker, task.token_mint);
  let localWorker = null;
  if (!options.skipEnv) {
    const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE, {});
    try {
      localWorker = keypairForRole(env, "worker").address;
    } catch {
      localWorker = env.GLOBAL_TASC_SOLANA_WORKER_ADDRESS || null;
    }
  }
  return {
    ok: true,
    mode: "plan-worker-token",
    signed_intent: options.signedFile || DEFAULT_SIGNED_INTENT,
    task_account_file: options.taskAccountFile || DEFAULT_TASK_ACCOUNT,
    env_file: path.resolve(options.envFile || DEFAULT_ENV_FILE),
    sends_transactions: false,
    guard_for_send: `${ALLOW_WORKER_TOKEN_ENV}=1`,
    cluster: signed.intent.message.cluster,
    program_id: signed.intent.message.program_id,
    token_program_id: TOKEN_PROGRAM_ID,
    task_account: task.task_pda,
    task_status: task.status,
    worker: task.worker,
    local_worker: localWorker,
    local_worker_matches_task: localWorker ? localWorker === task.worker : false,
    token_mint: task.token_mint,
    worker_token_seed: workerTokenSeed,
    worker_token_account: workerTokenAccount,
    planned_instruction_shape: [
      "system.create_account_with_seed(worker_token_account)",
      "spl_token.initialize_account3(worker)",
    ],
    send_requirements: [
      "worker keypair in local env must match the claimed task worker",
      "worker SOL balance must cover one SPL token account rent exemption plus fee",
      `${ALLOW_WORKER_TOKEN_ENV}=1`,
    ],
    ready_to_send: Boolean(localWorker && localWorker === task.worker),
    key_material_printed: false,
  };
}

function assertWorkerTokenAccount(account, task) {
  assert(account, "worker token account evidence is required for release readiness");
  assert(account.pubkey === splWorkerTokenAddress(task.worker, task.token_mint), "worker token account pubkey mismatch");
  assert(account.owner === TOKEN_PROGRAM_ID || account.decoded.account_owner === TOKEN_PROGRAM_ID, "worker token account must be owned by SPL Token Program");
  assert(account.decoded.mint === task.token_mint, "worker token account mint mismatch");
  assert(account.decoded.owner === task.worker, "worker token account owner mismatch");
  return true;
}

function destinationForAction(action, signed, task, options = {}) {
  if (action === "release") {
    const destination = workerTokenAddressForTask(task, options.workerTokenAccount);
    const workerToken = options.workerToken || maybeLoadWorkerToken(options.workerTokenFile || DEFAULT_WORKER_TOKEN);
    const destinationReady = workerToken ? assertWorkerTokenAccount(workerToken, task) : false;
    return {
      destination_token_account: destination,
      destination_owner: task.worker,
      destination_role: "worker",
      destination_ready: destinationReady,
    };
  }

  const buyerToken = options.buyerTokenAccount
    ? assertBase58Address(options.buyerTokenAccount, "buyer_token_account")
    : splBuyerTokenAddress(signed.intent.message.buyer, task.token_mint);
  return {
    destination_token_account: buyerToken,
    destination_owner: signed.intent.message.buyer,
    destination_role: "buyer",
    destination_ready: true,
  };
}

function buildSettlementPlan(action, options = {}) {
  assert(action === "release" || action === "refund", "settlement action must be release or refund");
  const signed = options.signed || loadSignedIntent(options.signedFile || DEFAULT_SIGNED_INTENT);
  const task = options.task || loadTaskAccount(options.taskAccountFile || DEFAULT_TASK_ACCOUNT);
  const funding = options.funding || loadFunding(options.fundingFile || DEFAULT_FUNDING);
  const requiredStatus = action === "release" ? "Passed" : "Failed";
  assert(task.status === requiredStatus, `${action} requires task status ${requiredStatus}; found ${task.status}`);
  const { custody, expectedVaultAuthority } = validateTaskAndFunding(signed, task, funding);
  const destination = destinationForAction(action, signed, task, options);
  const decimals = Number(custody.decimals ?? signed.intent.chain_reward?.decimals ?? 6);
  assert(Number.isInteger(decimals) && decimals >= 0 && decimals <= 255, "token decimals must be a u8");

  const transfer = transferCheckedInstruction({
    source: task.vault,
    mint: task.token_mint,
    destination: destination.destination_token_account,
    authority: expectedVaultAuthority.address,
    amount: task.amount,
    decimals,
  });

  return {
    ok: true,
    mode: `plan-${action}`,
    signed_intent: options.signedFile || DEFAULT_SIGNED_INTENT,
    task_account_file: options.taskAccountFile || DEFAULT_TASK_ACCOUNT,
    funding_file: options.fundingFile || DEFAULT_FUNDING,
    sends_transactions: false,
    token_movement: "planned_not_sent",
    cpi_required: true,
    cluster: signed.intent.message.cluster,
    program_id: signed.intent.message.program_id,
    token_program_id: TOKEN_PROGRAM_ID,
    task_account: task.task_pda,
    task_status: task.status,
    vault_token_account: task.vault,
    vault_authority: expectedVaultAuthority.address,
    vault_authority_bump: expectedVaultAuthority.bump,
    vault_authority_seeds: [
      "global-tasc-vault",
      task.task_hash,
      task.token_mint,
      String(expectedVaultAuthority.bump),
    ],
    destination_token_account: destination.destination_token_account,
    destination_owner: destination.destination_owner,
    destination_role: destination.destination_role,
    destination_ready: destination.destination_ready,
    token_mint: task.token_mint,
    amount: task.amount,
    token_decimals: decimals,
    transfer_checked: {
      name: transfer.name,
      program_id: transfer.programId,
      accounts: transfer.accounts.map(({ pubkey, signer, writable }) => ({ pubkey, signer, writable })),
      data_hex: `0x${transfer.data.toString("hex")}`,
      decoded_data: decodeTransferCheckedData(transfer.data),
    },
    lifecycle_send_requirements: [
      "run the guarded lifecycle release/refund sender with the same settlement accounts",
      "program signs the CPI as the vault_authority PDA with the documented seeds",
      "task account transitions to Released or Refunded only after the CPI succeeds",
    ],
    key_material_printed: false,
  };
}

async function sendWorkerToken(options = {}) {
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE);
  const rpcUrl = env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL;
  const signed = loadSignedIntent(options.signedFile || DEFAULT_SIGNED_INTENT);
  const task = loadTaskAccount(options.taskAccountFile || DEFAULT_TASK_ACCOUNT);
  compareAccountToSignedIntent(signed, task);
  const worker = keypairForRole(env, "worker");
  assert(env[ALLOW_WORKER_TOKEN_ENV] === "1", `refusing to send without ${ALLOW_WORKER_TOKEN_ENV}=1`);
  assert(worker.address === task.worker, "local worker keypair must match claimed task worker");
  const workerTokenAccount = workerTokenAddressForTask(task, options.workerTokenAccount);

  const existing = await rpcCall(rpcUrl, "getAccountInfo", [
    workerTokenAccount,
    {
      commitment: "confirmed",
      encoding: "base64",
    },
  ]);
  if (existing.value) {
    const tokenAccount = tokenAccountFixtureFromRpc(workerTokenAccount, existing);
    assertWorkerTokenAccount(tokenAccount, task);
    const result = {
      ok: true,
      mode: "send-worker-token",
      rpc_host: new URL(rpcUrl).host,
      rpc_url_printed: false,
      sends_transactions: false,
      already_existed: true,
      cluster: signed.intent.message.cluster,
      worker: worker.address,
      token_mint: task.token_mint,
      worker_token_account: tokenAccount,
      key_material_printed: false,
    };
    if (options.out) writeJson(options.out, result);
    return result;
  }

  const [tokenRent, latest] = await Promise.all([
    rpcCall(rpcUrl, "getMinimumBalanceForRentExemption", [TOKEN_ACCOUNT_SIZE]),
    rpcCall(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]),
  ]);
  const { worker_token_seed: workerTokenSeed, instructions } = buildWorkerTokenInstructions(task, String(tokenRent));
  const compiled = compileLegacyMessage({
    payer: worker.address,
    recentBlockhash: latest.value.blockhash,
    instructions,
  });
  const signature = signSolanaMessage(compiled.message, worker.seed);
  const encoded = encodeSignedTransaction(compiled.message, signature);
  const txSignature = await rpcCall(rpcUrl, "sendTransaction", [
    encoded,
    {
      encoding: "base64",
      preflightCommitment: "confirmed",
    },
  ]);
  const status = await pollSignature(rpcUrl, txSignature);
  const after = await rpcCall(rpcUrl, "getAccountInfo", [
    workerTokenAccount,
    {
      commitment: "confirmed",
      encoding: "base64",
    },
  ]);
  const tokenAccount = tokenAccountFixtureFromRpc(workerTokenAccount, after);
  assertWorkerTokenAccount(tokenAccount, task);
  const initData = decodeInitializeAccount3Data(instructions[1].data);
  const result = {
    ok: true,
    mode: "send-worker-token",
    rpc_host: new URL(rpcUrl).host,
    rpc_url_printed: false,
    sends_transactions: true,
    already_existed: false,
    cluster: signed.intent.message.cluster,
    worker: worker.address,
    token_program_id: TOKEN_PROGRAM_ID,
    token_mint: task.token_mint,
    worker_token_seed: workerTokenSeed,
    worker_token_account: tokenAccount,
    token_account_rent_lamports: String(tokenRent),
    instructions: instructions.map((instruction) => instruction.name),
    initialize_account3: initData,
    signature: txSignature,
    confirmation_status: status ? status.confirmationStatus : "pending",
    key_material_printed: false,
  };
  if (options.out) writeJson(options.out, result);
  return result;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (command === "plan-worker-token") {
    const result = buildWorkerTokenPlan(options);
    if (options.out) writeJson(options.out, result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "send-worker-token") {
    if (!options.out) options.out = DEFAULT_WORKER_TOKEN;
    process.stdout.write(`${JSON.stringify(await sendWorkerToken(options), null, 2)}\n`);
    return;
  }
  if (command === "plan-release") {
    if (!options.out) options.out = DEFAULT_RELEASE_PLAN;
    const result = buildSettlementPlan("release", options);
    if (options.out) writeJson(options.out, result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "plan-refund") {
    if (!options.out) options.out = DEFAULT_REFUND_PLAN;
    const result = buildSettlementPlan("refund", options);
    if (options.out) writeJson(options.out, result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`run-solana-spl-settlement: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  ALLOW_WORKER_TOKEN_ENV,
  buildSettlementPlan,
  buildWorkerTokenInstructions,
  buildWorkerTokenPlan,
  sendWorkerToken,
  taskAccountFromArtifact,
  validateTaskAndFunding,
  workerTokenAddressForTask,
};
