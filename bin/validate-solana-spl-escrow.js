#!/usr/bin/env node

const { admit } = require("./tascindex");
const {
  buildFundWithSplVaultInstructions,
  buildFundWithSplTransferInstructions,
  compileLegacyMessage,
  fundAddresses,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} = require("./run-solana-fund");
const {
  createSolanaIntent,
  fixtureKeypair,
  signSolanaIntent,
} = require("./tascsolana");
const {
  fundingEvidenceFromTaskAccount,
  taskAccountFixtureFromState,
} = require("./tascsolana-program");
const {
  custodyEvidenceFromVault,
  decodeInitializeAccount3Data,
  decodeInitializeMint2Data,
  decodeMintToCheckedData,
  decodeTransferCheckedData,
  tokenAccountFixture,
} = require("./tascsolana-spl");
const {
  buildSetupInstructions,
  plan: setupPlan,
  setupAddresses,
} = require("./run-solana-spl-setup");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const EXAMPLE_INPUTS = { url: "https://docs.cdp.coinbase.com/x402/welcome" };

function main() {
  const buyer = fixtureKeypair("buyer");
  const verifier = fixtureKeypair("verifier");
  const programId = fixtureKeypair("program").address;
  const tokenMint = fixtureKeypair("token_mint").address;
  const buyerTokenAccount = fixtureKeypair("buyer_token_account").address;
  const { intent } = createSolanaIntent("examples/summarize_url.tasc", {
    buyer: buyer.address,
    verifier: verifier.address,
    programId,
    tokenMint,
    inputs: EXAMPLE_INPUTS,
  });
  const signed = signSolanaIntent(intent, buyer);
  const message = signed.intent.message;
  const addresses = fundAddresses(message);
  const setup = setupAddresses(message);
  const setupInstructions = buildSetupInstructions(signed, {
    mint_lamports: "1461600",
    token_lamports: "2039280",
  }).instructions;

  assert(setupInstructions.length === 7, "SPL setup should have seven instructions");
  assert(setupInstructions[0].programId === SYSTEM_PROGRAM_ID, "setup should create mint account first");
  assert(setupInstructions[1].programId === TOKEN_PROGRAM_ID, "setup should initialize mint with token program");
  assert(setupInstructions[2].programId === SYSTEM_PROGRAM_ID, "setup should create buyer token account");
  assert(setupInstructions[3].programId === TOKEN_PROGRAM_ID, "setup should initialize buyer token account");
  assert(setupInstructions[4].programId === SYSTEM_PROGRAM_ID, "setup should create vault token account");
  assert(setupInstructions[5].programId === TOKEN_PROGRAM_ID, "setup should initialize vault token account");
  assert(setupInstructions[6].programId === TOKEN_PROGRAM_ID, "setup should mint tokens to buyer token account");
  const mintInit = decodeInitializeMint2Data(setupInstructions[1].data);
  assert(mintInit.decimals === signed.intent.chain_reward.decimals, "InitializeMint2 decimals mismatch");
  assert(mintInit.mint_authority === buyer.address, "InitializeMint2 mint authority mismatch");
  assert(mintInit.freeze_authority === null, "InitializeMint2 should not set freeze authority");
  const buyerInit = decodeInitializeAccount3Data(setupInstructions[3].data);
  assert(buyerInit.owner === buyer.address, "buyer token account owner mismatch");
  const vaultInit = decodeInitializeAccount3Data(setupInstructions[5].data);
  assert(vaultInit.owner === setup.vault_authority, "vault token account should be owned by vault PDA authority");
  const mintTo = decodeMintToCheckedData(setupInstructions[6].data);
  assert(mintTo.amount === message.amount, "MintToChecked amount mismatch");
  assert(mintTo.decimals === signed.intent.chain_reward.decimals, "MintToChecked decimals mismatch");
  const setupCompiled = compileLegacyMessage({
    payer: buyer.address,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: setupInstructions,
  });
  assert(setupCompiled.accountKeys.some((meta) => meta.pubkey === setup.mint && meta.writable), "setup message missing writable mint");
  assert(setupCompiled.accountKeys.some((meta) => meta.pubkey === setup.buyer_token_account && meta.writable), "setup message missing writable buyer token account");
  assert(setupCompiled.accountKeys.some((meta) => meta.pubkey === setup.vault_token_account && meta.writable), "setup message missing writable vault token account");
  const plannedSetup = setupPlan({ signedFile: "examples/solana/summarize_url.signature.json", envFile: ".env.solana-devnet.local" });
  assert(plannedSetup.sends_transactions === false, "SPL setup plan must not send transactions");
  assert(plannedSetup.key_material_printed === false, "SPL setup plan must not print key material");

  const { instructions } = buildFundWithSplTransferInstructions(signed, {
    task_lamports: "2039280",
    buyer_token_account: buyerTokenAccount,
    vault_token_account: addresses.vault,
    token_decimals: signed.intent.chain_reward.decimals,
  });

  assert(instructions.length === 3, "SPL escrow tx should create task, transfer tokens, and fund task");
  assert(instructions[0].programId === SYSTEM_PROGRAM_ID, "first instruction should create task account");
  assert(instructions[1].programId === TOKEN_PROGRAM_ID, "second instruction should call SPL Token Program");
  assert(instructions[2].programId === programId, "third instruction should call Global Tasc program");
  assert(instructions[1].accounts[0].pubkey === buyerTokenAccount, "transfer source token account mismatch");
  assert(instructions[1].accounts[1].pubkey === tokenMint, "transfer mint mismatch");
  assert(instructions[1].accounts[2].pubkey === addresses.vault, "transfer destination vault mismatch");
  assert(instructions[1].accounts[3].pubkey === buyer.address, "transfer authority mismatch");
  const transfer = decodeTransferCheckedData(instructions[1].data);
  assert(transfer.amount === message.amount, "TransferChecked amount must match signed intent amount");
  assert(transfer.decimals === signed.intent.chain_reward.decimals, "TransferChecked decimals mismatch");
  assert(instructions[2].accounts[2].pubkey === addresses.vault, "fund instruction vault should be the token vault");

  const compiled = compileLegacyMessage({
    payer: buyer.address,
    recentBlockhash: "11111111111111111111111111111111",
    instructions,
  });
  assert(compiled.accountKeys.some((meta) => meta.pubkey === buyerTokenAccount && meta.writable), "message missing writable buyer token account");
  assert(compiled.accountKeys.some((meta) => meta.pubkey === addresses.vault && meta.writable), "message missing writable vault token account");
  assert(compiled.accountKeys.some((meta) => meta.pubkey === TOKEN_PROGRAM_ID && !meta.writable), "message missing readonly SPL Token Program");

  const vaultFunding = buildFundWithSplVaultInstructions(signed, {
    task_lamports: "2039280",
    vault_token_lamports: "2039280",
    buyer_token_account: buyerTokenAccount,
    token_decimals: signed.intent.chain_reward.decimals,
  });
  assert(vaultFunding.instructions.length === 5, "live SPL funding tx should create task, create/init vault, transfer, and fund");
  assert(vaultFunding.instructions[0].programId === SYSTEM_PROGRAM_ID, "live SPL funding should create task first");
  assert(vaultFunding.instructions[1].programId === SYSTEM_PROGRAM_ID, "live SPL funding should create vault token account second");
  assert(vaultFunding.instructions[2].programId === TOKEN_PROGRAM_ID, "live SPL funding should initialize vault token account third");
  assert(vaultFunding.instructions[3].programId === TOKEN_PROGRAM_ID, "live SPL funding should transfer checked fourth");
  assert(vaultFunding.instructions[4].programId === programId, "live SPL funding should call Global Tasc fifth");
  const vaultInitLive = decodeInitializeAccount3Data(vaultFunding.instructions[2].data);
  assert(vaultInitLive.owner === vaultFunding.addresses.vault_authority, "live SPL vault account should use PDA authority");
  const liveTransfer = decodeTransferCheckedData(vaultFunding.instructions[3].data);
  assert(liveTransfer.amount === message.amount, "live SPL TransferChecked amount mismatch");
  assert(vaultFunding.instructions[3].accounts[2].pubkey === vaultFunding.addresses.vault_token_account, "live SPL transfer destination mismatch");
  assert(vaultFunding.instructions[4].accounts[2].pubkey === vaultFunding.addresses.vault_token_account, "live SPL fund vault mismatch");
  const vaultCompiled = compileLegacyMessage({
    payer: buyer.address,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: vaultFunding.instructions,
  });
  assert(vaultCompiled.accountKeys.some((meta) => meta.pubkey === vaultFunding.addresses.vault_token_account && meta.writable), "live SPL message missing writable vault token account");

  const taskAccount = taskAccountFixtureFromState({
    kind: "tasc.solana.task_account",
    version: "0.1",
    program_id: message.program_id,
    task_pda: addresses.task_account,
    status: "Funded",
    task_hash: message.task_hash,
    buyer: message.buyer,
    worker: "11111111111111111111111111111111",
    verifier: message.verifier,
    token_mint: message.token_mint,
    vault: addresses.vault,
    amount: String(message.amount),
    deadline_unix: String(message.deadline_unix),
    nonce: String(message.nonce),
    result_hash: `0x${"00".repeat(32)}`,
    created_slot: "77",
    updated_slot: "77",
  });
  const vaultAccount = tokenAccountFixture({
    pubkey: addresses.vault,
    mint: message.token_mint,
    owner: message.program_id,
    amount: message.amount,
  });
  const funding = fundingEvidenceFromTaskAccount({
    signed,
    account: taskAccount,
    tx: {
      signature: signed.signature,
      slot: "77",
      instruction_index: "2",
      confirmation_status: "confirmed",
    },
  });
  funding.custody = custodyEvidenceFromVault({
    signed,
    account: vaultAccount,
    vault: addresses.vault,
    decimals: signed.intent.chain_reward.decimals,
    tx: {
      signature: signed.signature,
      slot: "77",
      instruction_index: "1",
      confirmation_status: "confirmed",
    },
  });

  const admitted = admit({ inlineSigned: signed }, { inlineFunding: funding });
  assert(admitted.entry.status === "claimable", "SPL custody funding should admit");
  assert(admitted.entry.inputs.url === EXAMPLE_INPUTS.url, "index entry should include signed input URL");
  assert(admitted.entry.input_hash === signed.intent.input_hash, "index entry should include signed input hash");
  assert(admitted.entry.funding.custody.amount === message.amount, "index entry should include custody amount");

  const liveTaskAccount = taskAccountFixtureFromState({
    kind: "tasc.solana.task_account",
    version: "0.1",
    program_id: message.program_id,
    task_pda: vaultFunding.addresses.task_account,
    status: "Funded",
    task_hash: message.task_hash,
    buyer: message.buyer,
    worker: "11111111111111111111111111111111",
    verifier: message.verifier,
    token_mint: message.token_mint,
    vault: vaultFunding.addresses.vault_token_account,
    amount: String(message.amount),
    deadline_unix: String(message.deadline_unix),
    nonce: String(message.nonce),
    result_hash: `0x${"00".repeat(32)}`,
    created_slot: "88",
    updated_slot: "88",
  });
  const liveVaultAccount = tokenAccountFixture({
    pubkey: vaultFunding.addresses.vault_token_account,
    mint: message.token_mint,
    owner: vaultFunding.addresses.vault_authority,
    amount: message.amount,
  });
  const liveFunding = fundingEvidenceFromTaskAccount({
    signed,
    account: liveTaskAccount,
    tx: {
      signature: signed.signature,
      slot: "88",
      instruction_index: "4",
      confirmation_status: "confirmed",
    },
  });
  liveFunding.custody = custodyEvidenceFromVault({
    signed,
    account: liveVaultAccount,
    vault: vaultFunding.addresses.vault_token_account,
    decimals: signed.intent.chain_reward.decimals,
    tx: {
      signature: signed.signature,
      slot: "88",
      instruction_index: "3",
      confirmation_status: "confirmed",
    },
  });
  const liveAdmitted = admit({ inlineSigned: signed }, { inlineFunding: liveFunding });
  assert(liveAdmitted.entry.settlement.vault === vaultFunding.addresses.vault_token_account, "live SPL index entry should point at vault token account");

  let rejectedReason = null;
  try {
    admit({ inlineSigned: signed }, {
      inlineFunding: {
        ...funding,
        custody: {
          ...funding.custody,
          amount: String(BigInt(message.amount) - 1n),
        },
      },
    });
  } catch (error) {
    rejectedReason = error.message;
  }
  assert(rejectedReason && rejectedReason.includes("custody_amount"), "underfunded custody should be rejected");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checks: [
      "SPL setup InitializeMint2/InitializeAccount3/MintToChecked bytes",
      "SPL setup account ordering is single-signer and deterministic",
      "SPL setup plan is non-sending and masks key material",
      "SPL Token TransferChecked bytes",
      "legacy message account ordering includes token custody accounts",
      "fund instruction stores token vault account",
      "live SPL funding creates and initializes a fresh vault token account",
      "live SPL task scanner accepts SPL vault-token-account custody",
      "vault token account decodes to custody evidence",
      "index admission carries custody proof",
      "underfunded custody is rejected",
    ],
    token_program_id: TOKEN_PROGRAM_ID,
    setup_mint: setup.mint,
    setup_vault_authority: setup.vault_authority,
    buyer_token_account: buyerTokenAccount,
    vault_token_account: addresses.vault,
    live_vault_token_account: vaultFunding.addresses.vault_token_account,
    live_vault_authority: vaultFunding.addresses.vault_authority,
    amount: message.amount,
    decimals: signed.intent.chain_reward.decimals,
    rejected_underfunded_custody: rejectedReason,
    no_new_dependencies: true,
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-solana-spl-escrow: ${error.message}`);
    process.exit(1);
  }
}
