#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { base58Decode, base58Encode } = require("./run-solana-devnet");
const { createWithSeedAddress } = require("./tascsolana");

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MINT_ACCOUNT_SIZE = 82;
const TOKEN_ACCOUNT_SIZE = 165;
const CREATE_ASSOCIATED_TOKEN_ACCOUNT_IDEMPOTENT_TAG = 1;
const TRANSFER_CHECKED_TAG = 12;
const INITIALIZE_ACCOUNT3_TAG = 18;
const INITIALIZE_MINT2_TAG = 20;
const MINT_TO_CHECKED_TAG = 14;
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const TOKEN_ACCOUNT_STATE_OFFSET = 108;
const ACCOUNT_STATE_INITIALIZED = 1;
const MINT_SUPPLY_OFFSET = 36;
const MINT_DECIMALS_OFFSET = 44;
const MINT_INITIALIZED_OFFSET = 45;
const MINT_FREEZE_AUTHORITY_OFFSET = 46;
const PDA_MARKER = Buffer.from("ProgramDerivedAddress", "utf8");
const ED25519_P = (1n << 255n) - 19n;
const ED25519_D = mod(-121665n * modInv(121666n));

function usage() {
  console.error([
    "Usage:",
    "  node bin/tascsolana-spl.js decode-mint-account <account.json>",
    "  node bin/tascsolana-spl.js decode-token-account <account.json>",
    "  node bin/tascsolana-spl.js derive-associated-token-account <owner> <mint>",
    "  node bin/tascsolana-spl.js create-associated-token-account-idempotent <payer> <owner> <mint>",
    "",
    "This helper is dependencyless and only handles the SPL Token v1 account/TransferChecked boundary.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function seedFrom(label, parts) {
  return `${label}-${sha256Hex(parts.join(":")).slice(0, 27)}`;
}

function bytes32Buffer(value, label) {
  const raw = String(value || "");
  assert(/^0x[a-fA-F0-9]{64}$/.test(raw), `${label} must be bytes32 hex`);
  return Buffer.from(raw.slice(2), "hex");
}

function mod(value) {
  const result = value % ED25519_P;
  return result >= 0n ? result : result + ED25519_P;
}

function modPow(base, exponent) {
  let result = 1n;
  let value = mod(base);
  let power = BigInt(exponent);
  while (power > 0n) {
    if (power & 1n) result = mod(result * value);
    value = mod(value * value);
    power >>= 1n;
  }
  return result;
}

function modInv(value) {
  return modPow(value, ED25519_P - 2n);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function assertU64(value, label) {
  const raw = String(value ?? "");
  assert(/^\d+$/.test(raw), `${label} must be a u64 integer string`);
  const parsed = BigInt(raw);
  assert(parsed >= 0n && parsed <= ((1n << 64n) - 1n), `${label} exceeds u64`);
  return parsed;
}

function assertU8(value, label) {
  const parsed = Number(value);
  assert(Number.isInteger(parsed) && parsed >= 0 && parsed <= 255, `${label} must be a u8`);
  return parsed;
}

function pubkeyBytes(address, label) {
  const raw = String(address || "");
  assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw), `${label} must be a Solana base58 address`);
  const bytes = base58Decode(raw);
  assert(bytes.length === 32, `${label} must decode to 32 bytes`);
  return bytes;
}

function bytesToLittleEndianInt(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) + BigInt(bytes[index]);
  }
  return value;
}

function isEd25519CompressedPoint(bytes) {
  const raw = Buffer.from(bytes);
  if (raw.length !== 32) return false;
  const sign = raw[31] >> 7;
  raw[31] &= 0x7f;
  const y = bytesToLittleEndianInt(raw);
  if (y >= ED25519_P) return false;
  const y2 = mod(y * y);
  const denominator = mod(ED25519_D * y2 + 1n);
  if (denominator === 0n) return false;
  const x2 = mod((y2 - 1n) * modInv(denominator));
  if (x2 === 0n) return sign === 0;
  return modPow(x2, (ED25519_P - 1n) / 2n) === 1n;
}

function seedBuffer(seed, label) {
  const buffer = Buffer.isBuffer(seed) ? Buffer.from(seed) : Buffer.from(String(seed), "utf8");
  assert(buffer.length <= 32, `${label} seed must be 32 bytes or shorter`);
  return buffer;
}

function createProgramAddress(seeds, programId) {
  const programBytes = pubkeyBytes(programId, "program_id");
  const seedBytes = seeds.map((seed, index) => seedBuffer(seed, `program address ${index}`));
  const address = crypto.createHash("sha256")
    .update(Buffer.concat([...seedBytes, programBytes, PDA_MARKER]))
    .digest();
  assert(!isEd25519CompressedPoint(address), "derived program address must be off curve");
  return base58Encode(address);
}

function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump -= 1) {
    try {
      const address = createProgramAddress([...seeds, Buffer.from([bump])], programId);
      return { address, bump };
    } catch {
      // Try the next bump.
    }
  }
  throw new Error("unable to find a valid program address");
}

function splMintSeed(programId, taskHash) {
  pubkeyBytes(programId, "program_id");
  bytes32Buffer(taskHash, "task_hash");
  return seedFrom("mint", [programId, String(taskHash).toLowerCase()]);
}

function splMintAddress(buyer, programId, taskHash) {
  return createWithSeedAddress(buyer, splMintSeed(programId, taskHash), TOKEN_PROGRAM_ID);
}

function splBuyerTokenSeed(buyer, mint) {
  pubkeyBytes(buyer, "buyer");
  pubkeyBytes(mint, "mint");
  return seedFrom("btok", [buyer, mint]);
}

function splBuyerTokenAddress(buyer, mint) {
  return createWithSeedAddress(buyer, splBuyerTokenSeed(buyer, mint), TOKEN_PROGRAM_ID);
}

function splWorkerTokenSeed(worker, mint) {
  pubkeyBytes(worker, "worker");
  pubkeyBytes(mint, "mint");
  return seedFrom("wtok", [worker, mint]);
}

function splWorkerTokenAddress(worker, mint) {
  return createWithSeedAddress(worker, splWorkerTokenSeed(worker, mint), TOKEN_PROGRAM_ID);
}

function splVaultSeed(programId, taskHash, mint) {
  pubkeyBytes(programId, "program_id");
  bytes32Buffer(taskHash, "task_hash");
  pubkeyBytes(mint, "mint");
  return seedFrom("vtok", [programId, String(taskHash).toLowerCase(), mint]);
}

function splVaultAddress(programId, buyer, taskHash, mint) {
  return createWithSeedAddress(buyer, splVaultSeed(programId, taskHash, mint), TOKEN_PROGRAM_ID);
}

function vaultAuthorityPda(programId, taskHash, mint) {
  return findProgramAddress([
    Buffer.from("global-tasc-vault", "utf8"),
    bytes32Buffer(taskHash, "task_hash"),
    pubkeyBytes(mint, "mint"),
  ], programId);
}

function associatedTokenAddress(owner, mint, tokenProgramId = TOKEN_PROGRAM_ID, associatedProgramId = ASSOCIATED_TOKEN_PROGRAM_ID) {
  return findProgramAddress([
    pubkeyBytes(owner, "token account owner"),
    pubkeyBytes(tokenProgramId, "token program id"),
    pubkeyBytes(mint, "token mint"),
  ], associatedProgramId).address;
}

function u64Buffer(value, label) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(assertU64(value, label), 0);
  return out;
}

function encodeTransferCheckedData(input) {
  return Buffer.concat([
    Buffer.from([TRANSFER_CHECKED_TAG]),
    u64Buffer(input.amount, "transfer amount"),
    Buffer.from([assertU8(input.decimals, "token decimals")]),
  ]);
}

function encodePubkeyOption(address) {
  if (!address) return Buffer.alloc(36);
  return Buffer.concat([
    Buffer.from([1, 0, 0, 0]),
    pubkeyBytes(address, "optional pubkey"),
  ]);
}

function decodePubkeyOption(buffer, offset, label) {
  const tag = buffer.readUInt32LE(offset);
  assert(tag === 0 || tag === 1, `${label} option tag is invalid`);
  return tag === 1 ? base58Encode(buffer.subarray(offset + 4, offset + 36)) : null;
}

function encodeInitializeMint2Data(input) {
  return Buffer.concat([
    Buffer.from([INITIALIZE_MINT2_TAG, assertU8(input.decimals, "mint decimals")]),
    pubkeyBytes(input.mintAuthority, "mint authority"),
    encodePubkeyOption(input.freezeAuthority || null),
  ]);
}

function decodeInitializeMint2Data(data) {
  const buffer = Buffer.from(data);
  assert(buffer.length === 70, "InitializeMint2 data must be 70 bytes");
  assert(buffer.readUInt8(0) === INITIALIZE_MINT2_TAG, "InitializeMint2 tag mismatch");
  const freezeTag = buffer.readUInt32LE(34);
  assert(freezeTag === 0 || freezeTag === 1, "InitializeMint2 freeze authority option is invalid");
  return {
    name: "initialize_mint2",
    tag: INITIALIZE_MINT2_TAG,
    decimals: buffer.readUInt8(1),
    mint_authority: base58Encode(buffer.subarray(2, 34)),
    freeze_authority: freezeTag === 1 ? base58Encode(buffer.subarray(38, 70)) : null,
  };
}

function encodeInitializeAccount3Data(input) {
  return Buffer.concat([
    Buffer.from([INITIALIZE_ACCOUNT3_TAG]),
    pubkeyBytes(input.owner, "token account owner"),
  ]);
}

function decodeInitializeAccount3Data(data) {
  const buffer = Buffer.from(data);
  assert(buffer.length === 33, "InitializeAccount3 data must be 33 bytes");
  assert(buffer.readUInt8(0) === INITIALIZE_ACCOUNT3_TAG, "InitializeAccount3 tag mismatch");
  return {
    name: "initialize_account3",
    tag: INITIALIZE_ACCOUNT3_TAG,
    owner: base58Encode(buffer.subarray(1, 33)),
  };
}

function encodeMintToCheckedData(input) {
  return Buffer.concat([
    Buffer.from([MINT_TO_CHECKED_TAG]),
    u64Buffer(input.amount, "mint amount"),
    Buffer.from([assertU8(input.decimals, "token decimals")]),
  ]);
}

function decodeMintToCheckedData(data) {
  const buffer = Buffer.from(data);
  assert(buffer.length === 10, "MintToChecked data must be 10 bytes");
  assert(buffer.readUInt8(0) === MINT_TO_CHECKED_TAG, "MintToChecked tag mismatch");
  return {
    name: "mint_to_checked",
    tag: MINT_TO_CHECKED_TAG,
    amount: buffer.readBigUInt64LE(1).toString(),
    decimals: buffer.readUInt8(9),
  };
}

function decodeTransferCheckedData(data) {
  const buffer = Buffer.from(data);
  assert(buffer.length === 10, "TransferChecked data must be 10 bytes");
  assert(buffer.readUInt8(0) === TRANSFER_CHECKED_TAG, "TransferChecked tag mismatch");
  return {
    name: "transfer_checked",
    tag: TRANSFER_CHECKED_TAG,
    amount: buffer.readBigUInt64LE(1).toString(),
    decimals: buffer.readUInt8(9),
  };
}

function accountMeta(pubkey, signer, writable) {
  return { pubkey, signer: Boolean(signer), writable: Boolean(writable) };
}

function transferCheckedInstruction(input) {
  return {
    name: "spl_token.transfer_checked",
    programId: TOKEN_PROGRAM_ID,
    accounts: [
      accountMeta(input.source, false, true),
      accountMeta(input.mint, false, false),
      accountMeta(input.destination, false, true),
      accountMeta(input.authority, true, false),
    ],
    data: encodeTransferCheckedData({
      amount: input.amount,
      decimals: input.decimals,
    }),
  };
}

function createAssociatedTokenAccountIdempotentInstruction(input) {
  const tokenProgramId = input.tokenProgramId || TOKEN_PROGRAM_ID;
  const associatedProgramId = input.associatedProgramId || ASSOCIATED_TOKEN_PROGRAM_ID;
  const payer = input.payer || input.owner;
  const owner = input.owner;
  const mint = input.mint;
  const account = input.account || associatedTokenAddress(owner, mint, tokenProgramId, associatedProgramId);
  pubkeyBytes(payer, "associated token account payer");
  pubkeyBytes(owner, "associated token account owner");
  pubkeyBytes(mint, "associated token account mint");
  pubkeyBytes(account, "associated token account");
  return {
    name: "associated_token.create_idempotent",
    programId: associatedProgramId,
    accounts: [
      accountMeta(payer, true, true),
      accountMeta(account, false, true),
      accountMeta(owner, false, false),
      accountMeta(mint, false, false),
      accountMeta(SYSTEM_PROGRAM_ID, false, false),
      accountMeta(tokenProgramId, false, false),
    ],
    data: Buffer.from([CREATE_ASSOCIATED_TOKEN_ACCOUNT_IDEMPOTENT_TAG]),
  };
}

function initializeMint2Instruction(input) {
  return {
    name: "spl_token.initialize_mint2",
    programId: TOKEN_PROGRAM_ID,
    accounts: [
      accountMeta(input.mint, false, true),
    ],
    data: encodeInitializeMint2Data(input),
  };
}

function initializeAccount3Instruction(input) {
  return {
    name: "spl_token.initialize_account3",
    programId: TOKEN_PROGRAM_ID,
    accounts: [
      accountMeta(input.account, false, true),
      accountMeta(input.mint, false, false),
    ],
    data: encodeInitializeAccount3Data(input),
  };
}

function mintToCheckedInstruction(input) {
  return {
    name: "spl_token.mint_to_checked",
    programId: TOKEN_PROGRAM_ID,
    accounts: [
      accountMeta(input.mint, false, true),
      accountMeta(input.destination, false, true),
      accountMeta(input.authority, true, false),
    ],
    data: encodeMintToCheckedData(input),
  };
}

function encodeTokenAccount(input) {
  const buffer = Buffer.alloc(TOKEN_ACCOUNT_SIZE);
  pubkeyBytes(input.mint, "token account mint").copy(buffer, 0);
  pubkeyBytes(input.owner, "token account owner").copy(buffer, 32);
  u64Buffer(input.amount, "token account amount").copy(buffer, TOKEN_ACCOUNT_AMOUNT_OFFSET);
  buffer.writeUInt8(assertU8(input.state ?? ACCOUNT_STATE_INITIALIZED, "token account state"), TOKEN_ACCOUNT_STATE_OFFSET);
  return buffer;
}

function decodeTokenAccountData(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "base64");
  assert(buffer.length === TOKEN_ACCOUNT_SIZE, `SPL token account data must be ${TOKEN_ACCOUNT_SIZE} bytes`);
  return {
    mint: base58Encode(buffer.subarray(0, 32)),
    owner: base58Encode(buffer.subarray(32, 64)),
    amount: buffer.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET).toString(),
    state: buffer.readUInt8(TOKEN_ACCOUNT_STATE_OFFSET),
  };
}

function decodeMintAccountData(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "base64");
  assert(buffer.length === MINT_ACCOUNT_SIZE, `SPL mint account data must be ${MINT_ACCOUNT_SIZE} bytes`);
  return {
    mint_authority: decodePubkeyOption(buffer, 0, "mint authority"),
    supply: buffer.readBigUInt64LE(MINT_SUPPLY_OFFSET).toString(),
    decimals: buffer.readUInt8(MINT_DECIMALS_OFFSET),
    initialized: buffer.readUInt8(MINT_INITIALIZED_OFFSET) === 1,
    freeze_authority: decodePubkeyOption(buffer, MINT_FREEZE_AUTHORITY_OFFSET, "freeze authority"),
  };
}

function tokenAccountFixture(input) {
  const data = encodeTokenAccount(input);
  const decoded = decodeTokenAccountData(data);
  return {
    kind: "tasc.solana.spl_token.account.fixture",
    version: "0.1",
    pubkey: input.pubkey,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    lamports: String(input.lamports || "2039280"),
    rent_epoch: "0",
    data_base64: data.toString("base64"),
    decoded,
  };
}

function decodedTokenAccountFromFixture(account) {
  assert(account && account.data_base64, "token account fixture missing data_base64");
  const decoded = decodeTokenAccountData(account.data_base64);
  return {
    kind: "tasc.solana.spl_token.account",
    version: "0.1",
    pubkey: account.pubkey || null,
    account_owner: account.owner || null,
    ...decoded,
  };
}

function decodedMintAccountFromFixture(account) {
  assert(account && account.data_base64, "mint account fixture missing data_base64");
  const decoded = decodeMintAccountData(account.data_base64);
  return {
    kind: "tasc.solana.spl_token.mint",
    version: "0.1",
    pubkey: account.pubkey || null,
    account_owner: account.owner || null,
    ...decoded,
  };
}

function custodyEvidenceFromVault(input) {
  const signed = input.signed;
  assert(signed && signed.intent && signed.intent.message, "signed Solana intent is required");
  const message = signed.intent.message;
  const decoded = decodedTokenAccountFromFixture(input.account);
  assert(decoded.account_owner === TOKEN_PROGRAM_ID, "vault token account must be owned by SPL Token Program");
  assert(decoded.state === ACCOUNT_STATE_INITIALIZED, "vault token account must be initialized");
  assert(decoded.mint === message.token_mint, "vault token account mint must match signed intent");
  assert(decoded.pubkey === input.vault, "vault token account pubkey mismatch");
  assert(BigInt(decoded.amount) >= BigInt(message.amount), "vault token balance is below signed intent amount");
  const tx = input.tx || {};
  return {
    kind: "tasc.custody.solana.spl_token",
    version: "0.1",
    token_program_id: TOKEN_PROGRAM_ID,
    vault_token_account: decoded.pubkey,
    vault_authority: decoded.owner,
    token_mint: decoded.mint,
    amount: decoded.amount,
    required_amount: String(message.amount),
    decimals: assertU8(input.decimals ?? signed.intent.chain_reward?.decimals ?? 6, "token decimals"),
    transfer_signature: tx.signature || null,
    slot: tx.slot !== undefined ? String(tx.slot) : null,
    instruction_index: tx.instruction_index !== undefined ? String(tx.instruction_index) : null,
    confirmation_status: tx.confirmation_status || null,
  };
}

function main() {
  const [command, file, ...rest] = process.argv.slice(2);
  if (command === "decode-mint-account" && file) {
    if (rest.length > 0) usage();
    process.stdout.write(`${JSON.stringify(decodedMintAccountFromFixture(loadJson(file)), null, 2)}\n`);
    return;
  }
  if (command === "decode-token-account" && file) {
    if (rest.length > 0) usage();
    process.stdout.write(`${JSON.stringify(decodedTokenAccountFromFixture(loadJson(file)), null, 2)}\n`);
    return;
  }
  if (command === "derive-associated-token-account" && file && rest.length === 1) {
    const owner = file;
    const mint = rest[0];
    process.stdout.write(`${JSON.stringify({
      kind: "tasc.solana.associated_token_account",
      version: "0.1",
      owner,
      mint,
      token_program_id: TOKEN_PROGRAM_ID,
      associated_token_program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
      address: associatedTokenAddress(owner, mint),
    }, null, 2)}\n`);
    return;
  }
  if (command === "create-associated-token-account-idempotent" && file && rest.length === 2) {
    const payer = file;
    const owner = rest[0];
    const mint = rest[1];
    const instruction = createAssociatedTokenAccountIdempotentInstruction({ payer, owner, mint });
    process.stdout.write(`${JSON.stringify({
      kind: "tasc.solana.associated_token_account.create_idempotent_instruction",
      version: "0.1",
      payer,
      owner,
      mint,
      associated_token_account: instruction.accounts[1].pubkey,
      token_program_id: TOKEN_PROGRAM_ID,
      associated_token_program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
      instruction: {
        name: instruction.name,
        program_id: instruction.programId,
        accounts: instruction.accounts,
        data_hex: `0x${instruction.data.toString("hex")}`,
      },
    }, null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`tascsolana-spl: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  ACCOUNT_STATE_INITIALIZED,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CREATE_ASSOCIATED_TOKEN_ACCOUNT_IDEMPOTENT_TAG,
  INITIALIZE_ACCOUNT3_TAG,
  INITIALIZE_MINT2_TAG,
  MINT_ACCOUNT_SIZE,
  MINT_TO_CHECKED_TAG,
  SYSTEM_PROGRAM_ID,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  TRANSFER_CHECKED_TAG,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createProgramAddress,
  custodyEvidenceFromVault,
  decodeInitializeAccount3Data,
  decodeInitializeMint2Data,
  decodeMintToCheckedData,
  decodeMintAccountData,
  decodeTokenAccountData,
  decodeTransferCheckedData,
  decodedMintAccountFromFixture,
  decodedTokenAccountFromFixture,
  encodeInitializeAccount3Data,
  encodeInitializeMint2Data,
  encodeMintToCheckedData,
  encodeTokenAccount,
  encodeTransferCheckedData,
  findProgramAddress,
  initializeAccount3Instruction,
  initializeMint2Instruction,
  isEd25519CompressedPoint,
  mintToCheckedInstruction,
  splBuyerTokenAddress,
  splBuyerTokenSeed,
  splMintAddress,
  splMintSeed,
  splWorkerTokenAddress,
  splWorkerTokenSeed,
  splVaultAddress,
  splVaultSeed,
  tokenAccountFixture,
  transferCheckedInstruction,
  vaultAuthorityPda,
};
