(function initTascWebCore(root) {
  "use strict";

  const FUNDED_TOPIC = "0xe27c180c59dadd04beb7d79adb8fc96266c3672cfb075e52df8e40cd55d7cc42";
  const DEFAULT_CHAIN_ID = 84532;
  const DEFAULT_CONFIRMATIONS = 6;
  const DEFAULT_CHUNK_SIZE = 2000;
  const DEFAULT_SOLANA_RPC_URL = "https://api.devnet.solana.com";
  const SOLANA_TASK_ACCOUNT_DISCRIMINATOR = "fe5a9b1a20f08f03";
  const SOLANA_TASK_ACCOUNT_SIZE = 276;
  const ZERO_SOLANA_PUBKEY = "11111111111111111111111111111111";
  const SOLANA_STATUS_NAMES = [
    "Uninitialized",
    "Funded",
    "Claimed",
    "Passed",
    "Failed",
    "Released",
    "Refunded",
    "Disputed",
  ];
  const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const CLOCK_SYSVAR_ID = "SysvarC1ock11111111111111111111111111111111";
  const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const SOLANA_INSTRUCTION_TAGS = {
    claim: 1,
    attest: 2,
    release: 3,
    refund: 4,
  };
  const SOLANA_PDA_MARKER = "ProgramDerivedAddress";
  const ED25519_P = (1n << 255n) - 19n;
  const ED25519_D = mod(-121665n * modInv(121666n));

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function isHex(value, bytes) {
    const hex = String(value || "");
    const size = bytes === undefined ? "+" : `{${bytes * 2}}`;
    return new RegExp(`^0x[a-fA-F0-9]${size}$`).test(hex);
  }

  function assertHex(value, bytes, label) {
    assert(isHex(value, bytes), `${label} must be ${bytes ? `${bytes}-byte ` : ""}hex`);
    return String(value).toLowerCase();
  }

  function normalizeAddress(value, label) {
    const raw = String(value || "").toLowerCase();
    assert(/^0x[a-f0-9]{40}$/.test(raw), `${label} must be an address`);
    return raw;
  }

  function topicToAddress(topic, label) {
    const raw = assertHex(topic, 32, label);
    return normalizeAddress(`0x${raw.slice(-40)}`, label);
  }

  function assertUint(value, label) {
    assert(/^\d+$/.test(String(value ?? "")), `${label} must be an integer string`);
    return String(value);
  }

  function uintWordAt(data, index, label) {
    const raw = assertHex(data, undefined, "log data").slice(2);
    const offset = index * 64;
    const word = raw.slice(offset, offset + 64);
    assert(word.length === 64, `${label} is missing from log data`);
    return BigInt(`0x${word}`).toString(10);
  }

  function numberFromRpcQuantity(value, label) {
    const raw = String(value ?? "");
    assert(/^0x[0-9a-fA-F]+$/.test(raw), `${label} must be an RPC quantity`);
    const number = Number(BigInt(raw));
    assert(Number.isSafeInteger(number), `${label} is outside safe integer range`);
    return number;
  }

  function numberToRpcQuantity(value, label) {
    const number = Number(value);
    assert(Number.isSafeInteger(number) && number >= 0, `${label} must be a safe non-negative integer`);
    return `0x${number.toString(16)}`;
  }

  function numberFromUnknown(value, label) {
    if (typeof value === "number") {
      assert(Number.isSafeInteger(value), `${label} is outside safe integer range`);
      return value;
    }
    if (typeof value === "bigint") {
      const number = Number(value);
      assert(Number.isSafeInteger(number), `${label} is outside safe integer range`);
      return number;
    }
    if (/^0x[0-9a-fA-F]+$/.test(String(value ?? ""))) return numberFromRpcQuantity(value, label);
    assert(/^\d+$/.test(String(value ?? "")), `${label} must be an integer`);
    const number = Number(value);
    assert(Number.isSafeInteger(number), `${label} is outside safe integer range`);
    return number;
  }

  function decodeFundedLog(log, options) {
    const settings = options || {};
    const topics = log.topics || [];
    assert(Array.isArray(topics), "log topics must be an array");
    assert(topics.length >= 4, "Funded log must have 4 topics");
    assert(String(topics[0]).toLowerCase() === FUNDED_TOPIC, "log is not a TascEscrow Funded event");

    const chainId = numberFromUnknown(settings.chainId ?? log.chain_id ?? log.chainId ?? DEFAULT_CHAIN_ID, "chain id");
    const headBlock = settings.headBlock === undefined ? undefined : numberFromUnknown(settings.headBlock, "head block");
    const blockNumber = numberFromUnknown(log.blockNumber ?? log.block_number, "block number");
    const logIndex = numberFromUnknown(log.logIndex ?? log.log_index ?? log.index, "log index");
    const confirmations = settings.confirmations !== undefined
      ? numberFromUnknown(settings.confirmations, "confirmations")
      : headBlock === undefined
        ? numberFromUnknown(log.confirmations ?? 0, "confirmations")
        : Math.max(0, headBlock - blockNumber + 1);

    return {
      kind: "tasc.funding.evm",
      version: "0.1",
      chain_id: chainId,
      task_hash: assertHex(topics[1], 32, "task hash"),
      escrow: normalizeAddress(log.address ?? log.escrow, "escrow"),
      buyer: topicToAddress(topics[2], "buyer"),
      token: topicToAddress(topics[3], "token"),
      amount: assertUint(uintWordAt(log.data, 0, "amount"), "amount"),
      deadline: assertUint(uintWordAt(log.data, 1, "deadline"), "deadline"),
      status: "Funded",
      tx_hash: assertHex(log.transactionHash ?? log.tx_hash ?? log.transaction_hash, 32, "transaction hash"),
      block_number: blockNumber,
      log_index: logIndex,
      confirmations,
    };
  }

  function buildFundedFilter(settings) {
    const escrow = normalizeAddress(settings.escrow, "escrow");
    return {
      address: escrow,
      topics: [FUNDED_TOPIC],
      fromBlock: numberToRpcQuantity(settings.fromBlock, "from block"),
      toBlock: numberToRpcQuantity(settings.toBlock, "to block"),
    };
  }

  function taskKey(entry) {
    return [
      entry.chain_id,
      normalizeAddress(entry.escrow, "entry escrow"),
      assertHex(entry.tx_hash, 32, "entry transaction hash"),
      numberFromUnknown(entry.log_index, "entry log index"),
    ].join(":");
  }

  function mergeEntries(existingEntries, incomingEntries) {
    const map = new Map();
    for (const entry of existingEntries || []) map.set(taskKey(entry), entry);
    for (const entry of incomingEntries || []) map.set(taskKey(entry), entry);
    return Array.from(map.values()).sort((a, b) => {
      if (a.block_number !== b.block_number) return b.block_number - a.block_number;
      return b.log_index - a.log_index;
    });
  }

  function solanaIndexEntryKey(entry) {
    const settlement = entry && entry.settlement ? entry.settlement : {};
    if (settlement.chain === "solana" && settlement.task_pda) return `solana:${settlement.task_pda}`;
    if (entry && entry.task_hash) return `task:${entry.task_hash}`;
    return JSON.stringify(entry);
  }

  function entryPriority(entry) {
    if (entry && entry.status === "completed") return 3;
    if (entry && entry.completed_status) return 3;
    if (entry && entry.status === "claimable") return 2;
    return 1;
  }

  function mergeIndexEntries(existingEntries, incomingEntries) {
    const map = new Map();
    for (const entry of existingEntries || []) map.set(solanaIndexEntryKey(entry), entry);
    for (const entry of incomingEntries || []) {
      const key = solanaIndexEntryKey(entry);
      const previous = map.get(key);
      if (!previous || entryPriority(entry) >= entryPriority(previous)) map.set(key, entry);
    }
    return Array.from(map.values()).sort((a, b) => {
      const aStatus = entryPriority(a);
      const bStatus = entryPriority(b);
      if (aStatus !== bStatus) return bStatus - aStatus;
      return String(b.admitted_at || "").localeCompare(String(a.admitted_at || ""));
    });
  }

  function assertIndexEntry(entry, label) {
    assert(entry && typeof entry === "object", `${label} must be an object`);
    assert(entry.kind === "tasc.index.entry" || entry.task_hash, `${label} must be a tasc index entry`);
    assert(entry.task_hash, `${label} missing task_hash`);
    assert(entry.settlement && typeof entry.settlement === "object", `${label} missing settlement`);
    assert(entry.settlement.chain, `${label} missing settlement chain`);
    assert(entry.status, `${label} missing status`);
    return entry;
  }

  function proofSummaryIndexPaths(proof) {
    const branches = proof && proof.branches ? proof.branches : {};
    const paths = [];
    for (const branch of Object.values(branches)) {
      if (!branch || typeof branch !== "object") continue;
      for (const field of ["claimable_index_file", "completed_index_file"]) {
        if (branch[field]) paths.push(String(branch[field]));
      }
    }
    return Array.from(new Set(paths));
  }

  function indexEntriesFromImportPayload(payload) {
    const entries = [];
    const indexPaths = [];
    const visit = (value, label) => {
      assert(value !== null && value !== undefined, `${label} is empty`);
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${label}[${index}]`));
        return;
      }
      assert(typeof value === "object", `${label} must be a JSON object or array`);
      if (value.kind === "tasc.index") {
        assert(Array.isArray(value.entries), `${label} entries must be an array`);
        value.entries.forEach((entry, index) => entries.push(assertIndexEntry(entry, `${label}.entries[${index}]`)));
        return;
      }
      if (value.kind === "tasc.index.entry" || value.task_hash) {
        entries.push(assertIndexEntry(value, label));
        return;
      }
      if (value.kind === "tasc.solana-devnet.proof") {
        indexPaths.push(...proofSummaryIndexPaths(value));
        return;
      }
      if (Array.isArray(value.entries)) {
        value.entries.forEach((entry, index) => entries.push(assertIndexEntry(entry, `${label}.entries[${index}]`)));
        return;
      }
      throw new Error(`${label} is not a supported Tasc feed import`);
    };
    visit(payload, "import");
    return {
      entries: mergeIndexEntries([], entries),
      index_paths: Array.from(new Set(indexPaths)),
    };
  }

  function deriveConfigFromHandoff(handoff) {
    assert(handoff && handoff.kind === "tasc.testnet.handoff", "handoff kind must be tasc.testnet.handoff");
    const scannerEnv = handoff.scanner && handoff.scanner.env ? handoff.scanner.env : {};
    const fundingEvent = handoff.funding_event || {};
    const startBlock = scannerEnv.TASC_SCAN_START_BLOCK ?? fundingEvent.block_number;
    assert(startBlock !== undefined, "handoff missing funding start block");
    return {
      chainId: String(handoff.chain_id ?? scannerEnv.TASC_SCAN_CHAIN_ID ?? DEFAULT_CHAIN_ID),
      escrow: normalizeAddress(handoff.contracts && handoff.contracts.escrow, "handoff escrow"),
      startBlock: String(startBlock),
      confirmations: String(scannerEnv.TASC_SCAN_CONFIRMATIONS ?? fundingEvent.confirmations_required ?? DEFAULT_CONFIRMATIONS),
    };
  }

  function formatTokenAmount(amount, decimals) {
    const places = Number(decimals ?? 6);
    assert(Number.isInteger(places) && places >= 0 && places <= 36, "decimals must be between 0 and 36");
    const raw = assertUint(amount, "amount");
    const value = BigInt(raw);
    const scale = 10n ** BigInt(places);
    const whole = value / scale;
    const fraction = (value % scale).toString().padStart(places, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
  }

  function base58Encode(bytes) {
    const source = Array.from(bytes || []);
    if (source.length === 0) return "";
    let value = 0n;
    for (const byte of source) value = (value * 256n) + BigInt(byte);
    let encoded = "";
    while (value > 0n) {
      const index = Number(value % 58n);
      encoded = `${BASE58_ALPHABET[index]}${encoded}`;
      value /= 58n;
    }
    for (const byte of source) {
      if (byte !== 0) break;
      encoded = `1${encoded}`;
    }
    return encoded || "1";
  }

  function base58Decode(value) {
    const text = String(value || "");
    assert(text.length > 0, "base58 value is required");
    let decoded = 0n;
    for (const char of text) {
      const index = BASE58_ALPHABET.indexOf(char);
      assert(index !== -1, "base58 value contains invalid character");
      decoded = (decoded * 58n) + BigInt(index);
    }

    let hex = decoded.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    let bytes = hex === "00" && decoded === 0n
      ? []
      : hex.match(/.{2}/g).map((part) => Number.parseInt(part, 16));
    for (const char of text) {
      if (char !== "1") break;
      bytes = [0, ...bytes];
    }
    return bytes;
  }

  function assertSolanaAddress(address, label) {
    const value = String(address || "");
    assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value), `${label} must be a Solana base58 address`);
    assert(base58Decode(value).length === 32, `${label} must decode to 32 bytes`);
    return value;
  }

  function bytesFromBase64(value) {
    const raw = String(value || "");
    if (typeof Buffer !== "undefined") return Array.from(Buffer.from(raw, "base64"));
    const decoded = atob(raw);
    const bytes = new Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
    return bytes;
  }

  function base64FromBytes(bytes) {
    const source = Uint8Array.from(bytes || []);
    if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < source.length; index += chunkSize) {
      binary += String.fromCharCode(...source.slice(index, index + chunkSize));
    }
    return btoa(binary);
  }

  function base64UrlFromBytes(bytes) {
    return base64FromBytes(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function hexFromBytes(bytes) {
    return Array.from(bytes || [])
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function bytesFromHex(value, bytes, label) {
    const raw = assertHex(value, bytes, label).slice(2);
    return raw.match(/.{2}/g).map((part) => Number.parseInt(part, 16));
  }

  function bytesFromUtf8(value) {
    const text = String(value);
    if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(text));
    return unescape(encodeURIComponent(text)).split("").map((char) => char.charCodeAt(0));
  }

  function concatBytes(parts) {
    const out = [];
    for (const part of parts) out.push(...Array.from(part || []));
    return out;
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

  function bytesToLittleEndianInt(bytes) {
    let value = 0n;
    for (let index = bytes.length - 1; index >= 0; index -= 1) {
      value = (value << 8n) + BigInt(bytes[index]);
    }
    return value;
  }

  function isEd25519CompressedPoint(bytes) {
    const raw = Array.from(bytes || []);
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

  async function sha256Bytes(bytes) {
    assert(root.crypto && root.crypto.subtle && root.crypto.subtle.digest, "WebCrypto SHA-256 is required");
    const digest = await root.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes || []));
    return Array.from(new Uint8Array(digest));
  }

  async function sha256HexFromText(value) {
    return hexFromBytes(await sha256Bytes(bytesFromUtf8(value)));
  }

  async function seedFrom(label, parts) {
    const digest = await sha256HexFromText(parts.join(":"));
    return `${label}-${digest.slice(0, 27)}`;
  }

  async function createWithSeedAddress(base, seed, owner) {
    const seedBytes = bytesFromUtf8(seed);
    assert(seedBytes.length <= 32, "Solana seed must be 32 bytes or shorter");
    const address = await sha256Bytes(concatBytes([
      base58Decode(assertSolanaAddress(base, "base")),
      seedBytes,
      base58Decode(assertSolanaAddress(owner, "owner")),
    ]));
    return base58Encode(address);
  }

  function seedBuffer(seed, label) {
    const bytes = Array.isArray(seed) || seed instanceof Uint8Array ? Array.from(seed) : bytesFromUtf8(seed);
    assert(bytes.length <= 32, `${label} seed must be 32 bytes or shorter`);
    return bytes;
  }

  async function createProgramAddress(seeds, programId) {
    const seedBytes = seeds.map((seed, index) => seedBuffer(seed, `program address ${index}`));
    const address = await sha256Bytes(concatBytes([
      ...seedBytes,
      base58Decode(assertSolanaAddress(programId, "program_id")),
      bytesFromUtf8(SOLANA_PDA_MARKER),
    ]));
    assert(!isEd25519CompressedPoint(address), "derived program address must be off curve");
    return base58Encode(address);
  }

  async function findProgramAddress(seeds, programId) {
    for (let bump = 255; bump >= 0; bump -= 1) {
      try {
        return {
          address: await createProgramAddress([...seeds, [bump]], programId),
          bump,
        };
      } catch (_error) {
        // Keep searching for the Solana bump that derives an off-curve address.
      }
    }
    throw new Error("unable to find a valid program address");
  }

  async function splBuyerTokenAddress(buyer, mint) {
    assertSolanaAddress(buyer, "buyer");
    assertSolanaAddress(mint, "mint");
    const seed = await seedFrom("btok", [buyer, mint]);
    return createWithSeedAddress(buyer, seed, TOKEN_PROGRAM_ID);
  }

  async function splWorkerTokenAddress(worker, mint) {
    assertSolanaAddress(worker, "worker");
    assertSolanaAddress(mint, "mint");
    const seed = await seedFrom("wtok", [worker, mint]);
    return createWithSeedAddress(worker, seed, TOKEN_PROGRAM_ID);
  }

  async function vaultAuthorityPda(programId, taskHash, mint) {
    return findProgramAddress([
      bytesFromUtf8("global-tasc-vault"),
      bytesFromHex(taskHash, 32, "task_hash"),
      base58Decode(assertSolanaAddress(mint, "mint")),
    ], programId);
  }

  function encodeShortVectorLength(length) {
    assert(Number.isSafeInteger(length) && length >= 0, "short vector length must be non-negative");
    const bytes = [];
    let value = length;
    while (true) {
      let elem = value & 0x7f;
      value >>= 7;
      if (value === 0) {
        bytes.push(elem);
        break;
      }
      elem |= 0x80;
      bytes.push(elem);
    }
    return bytes;
  }

  function accountMeta(pubkey, signer, writable) {
    return {
      pubkey: assertSolanaAddress(pubkey, "account pubkey"),
      signer: Boolean(signer),
      writable: Boolean(writable),
    };
  }

  function mergeAccountMeta(map, meta) {
    const existing = map.get(meta.pubkey);
    if (!existing) {
      map.set(meta.pubkey, { ...meta });
      return;
    }
    existing.signer ||= meta.signer;
    existing.writable ||= meta.writable;
  }

  function orderedAccountKeys(payer, instructions) {
    const map = new Map();
    mergeAccountMeta(map, accountMeta(payer, true, true));
    for (const ix of instructions) {
      for (const meta of ix.accounts) mergeAccountMeta(map, meta);
      mergeAccountMeta(map, accountMeta(ix.programId, false, false));
    }
    const metas = [...map.values()];
    const payerMeta = metas.find((meta) => meta.pubkey === payer);
    const rest = metas.filter((meta) => meta.pubkey !== payer);
    const signedWritable = [payerMeta, ...rest.filter((meta) => meta.signer && meta.writable)];
    const signedReadonly = rest.filter((meta) => meta.signer && !meta.writable);
    const unsignedWritable = rest.filter((meta) => !meta.signer && meta.writable);
    const unsignedReadonly = rest.filter((meta) => !meta.signer && !meta.writable);
    return [...signedWritable, ...signedReadonly, ...unsignedWritable, ...unsignedReadonly];
  }

  function compileLegacyMessage(input) {
    const payer = assertSolanaAddress(input.payer, "payer");
    const accountKeys = orderedAccountKeys(payer, input.instructions);
    const keyIndex = new Map(accountKeys.map((meta, index) => [meta.pubkey, index]));
    const signers = accountKeys.filter((meta) => meta.signer);
    const readonlySigners = signers.filter((meta) => !meta.writable);
    const readonlyUnsigned = accountKeys.filter((meta) => !meta.signer && !meta.writable);
    const recentBlockhash = base58Decode(input.recentBlockhash);
    assert(recentBlockhash.length === 32, "recent blockhash must decode to 32 bytes");

    const compiledInstructions = input.instructions.map((ix) => {
      const data = Array.from(ix.data || []);
      const accountIndexes = ix.accounts.map((meta) => {
        const index = keyIndex.get(meta.pubkey);
        assert(index !== undefined, `missing account key ${meta.pubkey}`);
        return index;
      });
      const programIndex = keyIndex.get(ix.programId);
      assert(programIndex !== undefined, `missing program id ${ix.programId}`);
      return concatBytes([
        [programIndex],
        encodeShortVectorLength(accountIndexes.length),
        accountIndexes,
        encodeShortVectorLength(data.length),
        data,
      ]);
    });

    return {
      accountKeys,
      message: concatBytes([
        [signers.length, readonlySigners.length, readonlyUnsigned.length],
        encodeShortVectorLength(accountKeys.length),
        ...accountKeys.map((meta) => base58Decode(meta.pubkey)),
        recentBlockhash,
        encodeShortVectorLength(compiledInstructions.length),
        ...compiledInstructions,
      ]),
    };
  }

  function encodeInstruction(name, fields) {
    const input = fields || {};
    if (name === "attest") {
      const verdict = String(input.verdict || "pass").toLowerCase();
      assert(verdict === "pass" || verdict === "fail", "attest verdict must be pass or fail");
      return [
        SOLANA_INSTRUCTION_TAGS.attest,
        verdict === "pass" ? 1 : 0,
        ...bytesFromHex(input.result_hash, 32, "result_hash"),
      ];
    }
    assert(Object.prototype.hasOwnProperty.call(SOLANA_INSTRUCTION_TAGS, name), `unsupported Solana instruction ${name}`);
    return [SOLANA_INSTRUCTION_TAGS[name]];
  }

  function normalizeSolanaAction(action) {
    const normalized = String(action || "").toLowerCase().replace(/[_\s]+/g, "-");
    assert(["claim", "attest", "release", "refund", "timeout-refund"].includes(normalized), "unsupported Solana action");
    return normalized;
  }

  function solanaInstructionName(action) {
    return action === "timeout-refund" ? "refund" : action;
  }

  function solanaSignerRoleForAction(action) {
    if (action === "claim") return "worker";
    if (action === "attest") return "verifier";
    if (action === "refund" || action === "timeout-refund") return "buyer";
    return "worker";
  }

  function requireSolanaTask(entry, account) {
    const settlement = (entry && entry.settlement) || {};
    const fundingCustody = entry && entry.funding ? entry.funding.custody || {} : {};
    const task = {
      program_id: (account && (account.program_id || account.owner)) || settlement.program_id,
      task_account: (account && account.task_pda) || settlement.task_pda,
      task_hash: (account && account.task_hash) || (entry && entry.task_hash),
      buyer: (account && account.buyer) || (entry && entry.buyer),
      worker: account && account.worker,
      verifier: (account && account.verifier) || (entry && entry.verifier),
      token_mint: (account && account.token_mint) || (entry && entry.token_mint),
      vault: (account && account.vault) || settlement.vault || fundingCustody.vault_token_account,
      status: (account && account.status) || (entry && entry.status),
      deadline_unix: (account && account.deadline_unix) || (entry && entry.deadline_unix),
      vault_authority: fundingCustody.vault_authority || null,
    };
    assertSolanaAddress(task.program_id, "program_id");
    assertSolanaAddress(task.task_account, "task_account");
    assertHex(task.task_hash, 32, "task_hash");
    assertSolanaAddress(task.buyer, "buyer");
    assertSolanaAddress(task.verifier, "verifier");
    assertSolanaAddress(task.token_mint, "token_mint");
    assertSolanaAddress(task.vault, "vault");
    return task;
  }

  async function solanaSettlementAccountsForAction(action, task, signerAddress) {
    if (!["release", "refund", "timeout-refund"].includes(action)) return null;
    const vaultAuthority = await vaultAuthorityPda(task.program_id, task.task_hash, task.token_mint);
    const destination = action === "release"
      ? await splWorkerTokenAddress(signerAddress, task.token_mint)
      : await splBuyerTokenAddress(task.buyer, task.token_mint);
    return {
      destination_role: action === "release" ? "worker" : "buyer",
      vault_token_account: task.vault,
      token_mint: task.token_mint,
      destination_token_account: destination,
      vault_authority: vaultAuthority.address,
      vault_authority_bump: vaultAuthority.bump,
      token_program_id: TOKEN_PROGRAM_ID,
      vault_authority_matches_custody: task.vault_authority ? task.vault_authority === vaultAuthority.address : null,
      outer_accounts: [
        accountMeta(task.vault, false, true),
        accountMeta(task.token_mint, false, false),
        accountMeta(destination, false, true),
        accountMeta(vaultAuthority.address, false, false),
        accountMeta(TOKEN_PROGRAM_ID, false, false),
      ],
    };
  }

  function clockAccountsForAction(action) {
    if (action !== "claim" && action !== "timeout-refund") return [];
    return [accountMeta(CLOCK_SYSVAR_ID, false, false)];
  }

  async function buildSolanaLifecycleTransaction(input) {
    const settings = input || {};
    const action = normalizeSolanaAction(settings.action);
    const signer = assertSolanaAddress(settings.walletAddress, "walletAddress");
    const task = requireSolanaTask(settings.entry, settings.account);
    const programInstruction = solanaInstructionName(action);
    const data = encodeInstruction(programInstruction, {
      verdict: settings.verdict,
      result_hash: settings.resultHash || settings.result_hash,
    });
    const settlement = await solanaSettlementAccountsForAction(action, task, signer);
    const accounts = [
      accountMeta(signer, true, true),
      accountMeta(task.task_account, false, true),
      ...(settlement ? settlement.outer_accounts : []),
      ...clockAccountsForAction(action),
    ];
    const instruction = {
      name: action,
      programId: task.program_id,
      accounts,
      data,
    };
    const compiled = compileLegacyMessage({
      payer: signer,
      recentBlockhash: settings.recentBlockhash,
      instructions: [instruction],
    });
    const message = compiled.message;
    const unsignedTransaction = concatBytes([
      encodeShortVectorLength(1),
      new Array(64).fill(0),
      message,
    ]);
    return {
      ok: true,
      action,
      signer_role: solanaSignerRoleForAction(action),
      signer,
      program_id: task.program_id,
      task_account: task.task_account,
      recent_blockhash: settings.recentBlockhash,
      program_instruction: programInstruction,
      instruction_data_hex: `0x${hexFromBytes(data)}`,
      accounts: accounts.map(({ pubkey, signer: isSigner, writable }) => ({ pubkey, signer: isSigner, writable })),
      account_keys: compiled.accountKeys.map(({ pubkey, signer: isSigner, writable }) => ({ pubkey, signer: isSigner, writable })),
      message_bytes: message,
      message_base64: base64FromBytes(message),
      unsigned_transaction_bytes: unsignedTransaction,
      unsigned_transaction_base64: base64FromBytes(unsignedTransaction),
      unsigned_transaction_base64url: base64UrlFromBytes(unsignedTransaction),
      clock_sysvar: clockAccountsForAction(action)[0]?.pubkey || null,
      settlement: settlement ? {
        destination_role: settlement.destination_role,
        vault_token_account: settlement.vault_token_account,
        destination_token_account: settlement.destination_token_account,
        vault_authority: settlement.vault_authority,
        vault_authority_bump: settlement.vault_authority_bump,
        vault_authority_matches_custody: settlement.vault_authority_matches_custody,
        token_program_id: settlement.token_program_id,
      } : null,
    };
  }

  function encodeSignedSolanaTransactionBytes(message, signature) {
    const signatureBytes = Array.from(signature || []);
    assert(signatureBytes.length === 64, "Solana transaction signature must be 64 bytes");
    return concatBytes([
      encodeShortVectorLength(1),
      signatureBytes,
      message,
    ]);
  }

  function solanaPublicKeyObject(address) {
    const value = assertSolanaAddress(address, "public key");
    return {
      toString: () => value,
      toBase58: () => value,
      toBytes: () => Uint8Array.from(base58Decode(value)),
      equals: (other) => Boolean(other && (other === value || (other.toString && other.toString() === value))),
    };
  }

  function createSolanaWalletTransaction(payload) {
    assert(payload && Array.isArray(payload.message_bytes), "Solana transaction payload is required");
    const payer = solanaPublicKeyObject(payload.signer);
    const signatures = [{ publicKey: payer, signature: null }];
    return {
      feePayer: payer,
      recentBlockhash: payload.recent_blockhash,
      signatures,
      serializeMessage() {
        return Uint8Array.from(payload.message_bytes);
      },
      addSignature(publicKey, signature) {
        const signatureBytes = Uint8Array.from(signature || []);
        assert(signatureBytes.length === 64, "wallet signature must be 64 bytes");
        signatures[0] = { publicKey: publicKey || payer, signature: signatureBytes };
      },
      serialize(options) {
        const signature = signatures[0] && signatures[0].signature;
        const requireAllSignatures = !options || options.requireAllSignatures !== false;
        if (!signature && requireAllSignatures) throw new Error("wallet did not attach a signature");
        const signatureBytes = signature ? Array.from(signature) : new Array(64).fill(0);
        return Uint8Array.from(encodeSignedSolanaTransactionBytes(payload.message_bytes, signatureBytes));
      },
      _tasc: payload,
    };
  }

  function readU64Le(bytes, offset) {
    let value = 0n;
    for (let i = 7; i >= 0; i -= 1) value = (value * 256n) + BigInt(bytes[offset + i]);
    return value.toString(10);
  }

  function decodeSolanaTaskAccountBase64(dataBase64, options) {
    const settings = options || {};
    const bytes = bytesFromBase64(dataBase64);
    assert(bytes.length === SOLANA_TASK_ACCOUNT_SIZE, `task account data must be ${SOLANA_TASK_ACCOUNT_SIZE} bytes`);
    const discriminator = hexFromBytes(bytes.slice(0, 8));
    assert(discriminator === SOLANA_TASK_ACCOUNT_DISCRIMINATOR, "task account discriminator mismatch");
    const statusCode = bytes[9];
    assert(statusCode >= 0 && statusCode < SOLANA_STATUS_NAMES.length, "unknown task status code");
    return {
      kind: "tasc.solana.task_account",
      version: String(bytes[8]),
      status: SOLANA_STATUS_NAMES[statusCode],
      status_code: statusCode,
      bump: bytes[10],
      flags: bytes[11],
      program_id: settings.programId || null,
      task_pda: settings.taskPda || null,
      task_hash: `0x${hexFromBytes(bytes.slice(12, 44))}`,
      buyer: base58Encode(bytes.slice(44, 76)),
      worker: base58Encode(bytes.slice(76, 108)),
      verifier: base58Encode(bytes.slice(108, 140)),
      token_mint: base58Encode(bytes.slice(140, 172)),
      vault: base58Encode(bytes.slice(172, 204)),
      amount: readU64Le(bytes, 204),
      deadline_unix: readU64Le(bytes, 212),
      nonce: readU64Le(bytes, 220),
      result_hash: `0x${hexFromBytes(bytes.slice(228, 260))}`,
      created_slot: readU64Le(bytes, 260),
      updated_slot: readU64Le(bytes, 268),
    };
  }

  function sameSolanaAddress(left, right) {
    return Boolean(left && right && String(left) === String(right));
  }

  function solanaWalletRole(entry, account, walletAddress) {
    if (!walletAddress) return "not connected";
    if (sameSolanaAddress(walletAddress, entry.buyer)) return "buyer";
    if (sameSolanaAddress(walletAddress, entry.verifier)) return "verifier";
    if (account && account.worker !== ZERO_SOLANA_PUBKEY && sameSolanaAddress(walletAddress, account.worker)) return "worker";
    if (!account || account.status === "Funded") return "worker candidate";
    return "spectator";
  }

  function solanaNextAction(entry, account, walletAddress, nowUnix) {
    const status = account ? account.status : entry.completed_status || entry.status;
    const role = solanaWalletRole(entry, account, walletAddress);
    const deadline = Number((account && account.deadline_unix) || entry.deadline_unix || 0);
    const now = Number(nowUnix || Math.floor(Date.now() / 1000));
    const afterDeadline = Number.isFinite(deadline) && deadline > 0 && now >= deadline;
    if (status === "Funded" && afterDeadline) {
      return {
        action: "timeout refund",
        actor: "buyer",
        enabled: role === "buyer",
        status,
        role,
      };
    }
    if (status === "Funded") {
      return {
        action: "claim",
        actor: "worker",
        enabled: Boolean(walletAddress) && role !== "buyer" && role !== "verifier",
        status,
        role,
      };
    }
    if (status === "Claimed" && afterDeadline && role === "buyer") {
      return {
        action: "timeout refund",
        actor: "buyer",
        enabled: true,
        status,
        role,
      };
    }
    if (status === "Claimed") {
      return {
        action: "attest",
        actor: "verifier",
        enabled: role === "verifier",
        status,
        role,
      };
    }
    if (status === "Passed") {
      return {
        action: "release",
        actor: "worker",
        enabled: role === "worker",
        status,
        role,
      };
    }
    if (status === "Failed") {
      return {
        action: "refund",
        actor: "buyer",
        enabled: role === "buyer",
        status,
        role,
      };
    }
    return {
      action: status === "Released" || status === "Refunded" ? "complete" : "watch",
      actor: status === "Released" ? "worker" : status === "Refunded" ? "buyer" : "operator",
      enabled: false,
      status,
      role,
    };
  }

  const api = {
    DEFAULT_CHAIN_ID,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_CONFIRMATIONS,
    DEFAULT_SOLANA_RPC_URL,
    CLOCK_SYSVAR_ID,
    FUNDED_TOPIC,
    TOKEN_PROGRAM_ID,
    ZERO_SOLANA_PUBKEY,
    base58Decode,
    base58Encode,
    base64FromBytes,
    buildFundedFilter,
    buildSolanaLifecycleTransaction,
    createSolanaWalletTransaction,
    decodeFundedLog,
    decodeSolanaTaskAccountBase64,
    deriveConfigFromHandoff,
    encodeShortVectorLength,
    formatTokenAmount,
    indexEntriesFromImportPayload,
    mergeIndexEntries,
    mergeEntries,
    normalizeAddress,
    numberFromRpcQuantity,
    numberToRpcQuantity,
    solanaSettlementAccountsForAction,
    solanaNextAction,
    solanaWalletRole,
    taskKey,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  root.TascWebCore = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
