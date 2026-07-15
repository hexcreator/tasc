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

  function bytesFromBase64(value) {
    const raw = String(value || "");
    if (typeof Buffer !== "undefined") return Array.from(Buffer.from(raw, "base64"));
    const decoded = atob(raw);
    const bytes = new Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
    return bytes;
  }

  function hexFromBytes(bytes) {
    return Array.from(bytes || [])
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
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
    const status = account ? account.status : entry.status;
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
    FUNDED_TOPIC,
    ZERO_SOLANA_PUBKEY,
    buildFundedFilter,
    decodeFundedLog,
    decodeSolanaTaskAccountBase64,
    deriveConfigFromHandoff,
    formatTokenAmount,
    mergeEntries,
    normalizeAddress,
    numberFromRpcQuantity,
    numberToRpcQuantity,
    solanaNextAction,
    solanaWalletRole,
    taskKey,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  root.TascWebCore = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
