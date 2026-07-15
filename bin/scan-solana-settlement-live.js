#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  DEFAULT_RPC_URL,
  assertBase58Address,
  mergedEnv,
  rpcCall,
} = require("./run-solana-devnet");
const { fundAddresses } = require("./run-solana-fund");
const { verifySignedSolanaIntent } = require("./tascsolana");
const {
  compareAccountToSignedIntent,
  decodeTaskAccount,
} = require("./tascsolana-program");
const {
  TOKEN_PROGRAM_ID,
  decodedTokenAccountFromFixture,
  splBuyerTokenAddress,
  splWorkerTokenAddress,
  vaultAuthorityPda,
} = require("./tascsolana-spl");

const DEFAULT_ENV_FILE = ".env.solana-devnet.local";
const DEFAULT_SIGNED_INTENT = "examples/solana-devnet/summarize_url_spl.signature.json";
const DEFAULT_TX_FILE = "examples/solana-devnet/summarize_url_spl.release.live.json";
const DEFAULT_OUT = "examples/solana-devnet/summarize_url_spl.settlement.live.json";

function usage() {
  console.error([
    "Usage:",
    "  node bin/scan-solana-settlement-live.js plan [signed-solana-intent.json] [--env file] [--tx file] [--out file]",
    "  node bin/scan-solana-settlement-live.js scan [signed-solana-intent.json] [--env file] [--tx file] [--out file]",
    "    [--signature txsig] [--instruction-index n] [--confirmation-status status]",
    "    [--destination-token-account address]",
    "",
    "scan is read-only: it fetches the task, vault token, and destination token accounts and writes completed settlement evidence.",
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
    txFile: DEFAULT_TX_FILE,
    out: DEFAULT_OUT,
    signature: null,
    instructionIndex: "0",
    confirmationStatus: "confirmed",
    destinationTokenAccount: null,
  };
  const args = [...rest];
  if (args[0] && !args[0].startsWith("--")) options.signedFile = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = args[++i];
    else if (arg === "--tx") options.txFile = args[++i];
    else if (arg === "--out") options.out = args[++i];
    else if (arg === "--signature") options.signature = args[++i];
    else if (arg === "--instruction-index") options.instructionIndex = String(args[++i]);
    else if (arg === "--confirmation-status") options.confirmationStatus = args[++i];
    else if (arg === "--destination-token-account") options.destinationTokenAccount = args[++i];
    else usage();
  }
  return options;
}

function loadSignedIntent(file) {
  const signed = loadJson(file);
  const signatureCheck = verifySignedSolanaIntent(signed);
  assert(signatureCheck.ok, "signed Solana intent signature is invalid");
  return signed;
}

function loadTransactionFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  return loadJson(file);
}

function rpcHost(envFile) {
  const env = mergedEnv(envFile, {});
  return new URL(env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL).host;
}

function plan(options = {}) {
  const signed = loadSignedIntent(options.signedFile || DEFAULT_SIGNED_INTENT);
  const message = signed.intent.message;
  const addresses = fundAddresses(message);
  const tx = loadTransactionFile(options.txFile || DEFAULT_TX_FILE);
  return {
    ok: true,
    mode: "plan",
    signed_intent: options.signedFile || DEFAULT_SIGNED_INTENT,
    tx_file: tx ? (options.txFile || DEFAULT_TX_FILE) : null,
    env_file: path.resolve(options.envFile || DEFAULT_ENV_FILE),
    rpc_host: rpcHost(options.envFile || DEFAULT_ENV_FILE),
    rpc_url_printed: false,
    sends_transactions: false,
    writes_files: false,
    cluster: message.cluster,
    program_id: message.program_id,
    task_account: addresses.task_account,
    tx_signature: options.signature || tx?.signature || null,
    out: options.out || DEFAULT_OUT,
  };
}

function accountFixtureFromRpc(input) {
  const value = input.value;
  assert(value, `account ${input.pubkey} not found`);
  assert(Array.isArray(value.data), "getAccountInfo data must be [base64, encoding]");
  assert(value.data[1] === "base64", "getAccountInfo data encoding must be base64");
  return {
    kind: input.kind,
    version: "0.1",
    pubkey: input.pubkey,
    owner: value.owner,
    executable: Boolean(value.executable),
    lamports: String(value.lamports),
    rent_epoch: String(value.rentEpoch ?? "0"),
    data_base64: value.data[0],
    context: {
      slot: String(input.context?.slot ?? "0"),
      api_version: input.context?.apiVersion || null,
    },
  };
}

async function fetchAccount(rpcUrl, pubkey, kind) {
  const result = await rpcCall(rpcUrl, "getAccountInfo", [
    pubkey,
    {
      commitment: "confirmed",
      encoding: "base64",
    },
  ]);
  return accountFixtureFromRpc({
    kind,
    pubkey,
    context: result.context,
    value: result.value,
  });
}

async function fetchSignatureStatus(rpcUrl, signature) {
  if (!signature) return null;
  const result = await rpcCall(rpcUrl, "getSignatureStatuses", [
    [signature],
    { searchTransactionHistory: true },
  ]);
  const status = result.value && result.value[0] ? result.value[0] : null;
  assert(status, `settlement signature ${signature} not found`);
  assert(status.err === null, `settlement signature ${signature} has an error`);
  return status;
}

function settlementActionForStatus(status) {
  if (status === "Released") {
    return {
      action: "release",
      destination_role: "worker",
      completed_status: "Released",
    };
  }
  if (status === "Refunded") {
    return {
      action: "refund",
      destination_role: "buyer",
      completed_status: "Refunded",
    };
  }
  throw new Error(`task account status must be Released or Refunded; found ${status}`);
}

function destinationForSettlement(action, task, tx, explicitDestination) {
  if (explicitDestination) {
    return assertBase58Address(explicitDestination, "destination_token_account");
  }
  if (tx?.settlement?.destination_token_account) {
    return assertBase58Address(tx.settlement.destination_token_account, "destination_token_account");
  }
  if (action === "release") return splWorkerTokenAddress(task.worker, task.token_mint);
  return splBuyerTokenAddress(task.buyer, task.token_mint);
}

function settlementEvidenceFromAccounts(input) {
  const {
    signed,
    taskAccount,
    vaultAccount,
    destinationAccount,
    tx,
    signature,
    instructionIndex,
    confirmationStatus,
    signatureStatus,
  } = input;
  const task = taskAccount.decoded;
  const settlement = settlementActionForStatus(task.status);
  const vault = vaultAccount.decoded;
  const destination = destinationAccount.decoded;
  const expectedAuthority = vaultAuthorityPda(task.program_id, task.task_hash, task.token_mint);
  const expectedDestinationOwner = settlement.action === "release" ? task.worker : task.buyer;
  const txSignature = signature || tx?.signature || null;
  assert(txSignature, "settlement signature is required");

  const checks = [
    ["intent_match", compareAccountToSignedIntent(signed, task).every((check) => check.pass)],
    ["token_program_vault", vaultAccount.owner === TOKEN_PROGRAM_ID],
    ["token_program_destination", destinationAccount.owner === TOKEN_PROGRAM_ID],
    ["vault_pubkey", vaultAccount.pubkey === task.vault],
    ["vault_mint", vault.mint === task.token_mint],
    ["vault_authority", vault.owner === expectedAuthority.address],
    ["vault_empty", vault.amount === "0"],
    ["destination_mint", destination.mint === task.token_mint],
    ["destination_owner", destination.owner === expectedDestinationOwner],
    ["destination_amount", BigInt(destination.amount) >= BigInt(task.amount)],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  assert(failed.length === 0, `settlement account checks failed: ${failed.join(", ")}`);

  return {
    kind: "tasc.settlement.solana.spl_token",
    version: "0.1",
    status: settlement.completed_status,
    action: settlement.action,
    cluster: signed.intent.message.cluster,
    program_id: signed.intent.message.program_id,
    task_hash: task.task_hash,
    task_pda: task.task_pda,
    vault: task.vault,
    vault_authority: expectedAuthority.address,
    vault_authority_bump: expectedAuthority.bump,
    token_program_id: TOKEN_PROGRAM_ID,
    buyer: task.buyer,
    worker: task.worker,
    token_mint: task.token_mint,
    amount: task.amount,
    deadline_unix: task.deadline_unix,
    verifier: task.verifier,
    nonce: task.nonce,
    result_hash: task.result_hash,
    destination_role: settlement.destination_role,
    destination_owner: expectedDestinationOwner,
    destination_token_account: destinationAccount.pubkey,
    vault_balance_after: vault.amount,
    destination_balance_after: destination.amount,
    signature: txSignature,
    slot: signatureStatus?.slot !== undefined ? String(signatureStatus.slot) : taskAccount.context.slot,
    instruction_index: String(instructionIndex ?? "0"),
    confirmation_status: confirmationStatus || signatureStatus?.confirmationStatus || tx?.confirmation_status || "confirmed",
    scan_accounts: {
      task_account: {
        pubkey: taskAccount.pubkey,
        owner: taskAccount.owner,
        slot: taskAccount.context.slot,
        status: task.status,
      },
      vault_token_account: {
        pubkey: vaultAccount.pubkey,
        owner: vaultAccount.owner,
        slot: vaultAccount.context.slot,
        amount: vault.amount,
      },
      destination_token_account: {
        pubkey: destinationAccount.pubkey,
        owner: destinationAccount.owner,
        slot: destinationAccount.context.slot,
        amount: destination.amount,
      },
    },
    checks: checks.map(([name, pass]) => ({ name, pass })),
  };
}

async function scan(options = {}) {
  const signed = loadSignedIntent(options.signedFile || DEFAULT_SIGNED_INTENT);
  const tx = loadTransactionFile(options.txFile || DEFAULT_TX_FILE);
  const env = mergedEnv(options.envFile || DEFAULT_ENV_FILE);
  const rpcUrl = env.SOLANA_DEVNET_RPC_URL || DEFAULT_RPC_URL;
  const message = signed.intent.message;
  const addresses = fundAddresses(message);
  const taskAccount = await fetchAccount(
    rpcUrl,
    addresses.task_account,
    "tasc.solana.lifecycle_account.live",
  );
  taskAccount.decoded = decodeTaskAccount(taskAccount.data_base64, {
    programId: taskAccount.owner,
    taskPda: taskAccount.pubkey,
  });
  const settlement = settlementActionForStatus(taskAccount.decoded.status);
  const destinationTokenAccount = destinationForSettlement(
    settlement.action,
    taskAccount.decoded,
    tx,
    options.destinationTokenAccount,
  );
  const [vaultAccount, destinationAccount] = await Promise.all([
    fetchAccount(rpcUrl, taskAccount.decoded.vault, "tasc.solana.spl_token.account.live"),
    fetchAccount(rpcUrl, destinationTokenAccount, "tasc.solana.spl_token.account.live"),
  ]);
  vaultAccount.decoded = decodedTokenAccountFromFixture(vaultAccount);
  destinationAccount.decoded = decodedTokenAccountFromFixture(destinationAccount);
  const txSignature = options.signature || tx?.signature || null;
  const signatureStatus = await fetchSignatureStatus(rpcUrl, txSignature);

  const evidence = settlementEvidenceFromAccounts({
    signed,
    taskAccount,
    vaultAccount,
    destinationAccount,
    tx,
    signature: options.signature,
    instructionIndex: options.instructionIndex,
    confirmationStatus: options.confirmationStatus,
    signatureStatus,
  });
  if (options.out) writeJson(options.out, evidence);
  return {
    ok: true,
    mode: "scan",
    signed_intent: options.signedFile || DEFAULT_SIGNED_INTENT,
    tx_file: tx ? (options.txFile || DEFAULT_TX_FILE) : null,
    out: options.out || null,
    rpc_host: new URL(rpcUrl).host,
    rpc_url_printed: false,
    sends_transactions: false,
    evidence: {
      kind: evidence.kind,
      status: evidence.status,
      action: evidence.action,
      task_pda: evidence.task_pda,
      signature: evidence.signature,
      vault_balance_after: evidence.vault_balance_after,
      destination_balance_after: evidence.destination_balance_after,
    },
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(plan(options), null, 2)}\n`);
    return;
  }
  if (command === "scan") {
    process.stdout.write(`${JSON.stringify(await scan(options), null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`scan-solana-settlement-live: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  plan,
  scan,
  settlementEvidenceFromAccounts,
};
