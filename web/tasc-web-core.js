(function initTascWebCore(root) {
  "use strict";

  const FUNDED_TOPIC = "0xe27c180c59dadd04beb7d79adb8fc96266c3672cfb075e52df8e40cd55d7cc42";
  const DEFAULT_CHAIN_ID = 84532;
  const DEFAULT_CONFIRMATIONS = 6;
  const DEFAULT_CHUNK_SIZE = 2000;

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

  const api = {
    DEFAULT_CHAIN_ID,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_CONFIRMATIONS,
    FUNDED_TOPIC,
    buildFundedFilter,
    decodeFundedLog,
    deriveConfigFromHandoff,
    formatTokenAmount,
    mergeEntries,
    normalizeAddress,
    numberFromRpcQuantity,
    numberToRpcQuantity,
    taskKey,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  root.TascWebCore = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
