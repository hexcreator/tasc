(function initTaskFeedApp() {
  "use strict";

  const core = window.TascWebCore;
  const storageKey = "global-tasc.web.feed.v1";

  const el = {
    rpcUrl: document.querySelector("#rpc-url"),
    escrow: document.querySelector("#escrow"),
    chainId: document.querySelector("#chain-id"),
    startBlock: document.querySelector("#start-block"),
    confirmations: document.querySelector("#confirmations"),
    chunkSize: document.querySelector("#chunk-size"),
    handoff: document.querySelector("#handoff"),
    importHandoff: document.querySelector("#import-handoff"),
    scan: document.querySelector("#scan"),
    clear: document.querySelector("#clear-cache"),
    status: document.querySelector("#status"),
    taskCount: document.querySelector("#task-count"),
    cursor: document.querySelector("#cursor"),
    tableBody: document.querySelector("#task-table-body"),
    empty: document.querySelector("#empty-state"),
  };

  function readState() {
    try {
      return JSON.parse(window.localStorage.getItem(storageKey) || "{}");
    } catch (_error) {
      return {};
    }
  }

  function writeState(state) {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  }

  function setStatus(message, variant) {
    el.status.textContent = message;
    el.status.dataset.variant = variant || "neutral";
  }

  function setFormFromState(state) {
    const config = state.config || {};
    el.rpcUrl.value = config.rpcUrl || "";
    el.escrow.value = config.escrow || "";
    el.chainId.value = config.chainId || String(core.DEFAULT_CHAIN_ID);
    el.startBlock.value = config.startBlock || "";
    el.confirmations.value = config.confirmations || String(core.DEFAULT_CONFIRMATIONS);
    el.chunkSize.value = config.chunkSize || String(core.DEFAULT_CHUNK_SIZE);
  }

  function readConfig() {
    return {
      rpcUrl: el.rpcUrl.value.trim(),
      escrow: el.escrow.value.trim(),
      chainId: el.chainId.value.trim(),
      startBlock: el.startBlock.value.trim(),
      confirmations: el.confirmations.value.trim(),
      chunkSize: el.chunkSize.value.trim(),
    };
  }

  function requireConfig(config) {
    if (!config.rpcUrl) throw new Error("RPC URL is required");
    if (!config.escrow) throw new Error("Escrow address is required");
    if (!config.chainId) throw new Error("Chain ID is required");
    if (!config.startBlock) throw new Error("Start block is required");
    if (!config.confirmations) throw new Error("Confirmations are required");
    const chainId = Number(config.chainId);
    const startBlock = Number(config.startBlock);
    const confirmations = Number(config.confirmations);
    const chunkSize = Number(config.chunkSize || core.DEFAULT_CHUNK_SIZE);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Chain ID must be a positive integer");
    if (!Number.isSafeInteger(startBlock) || startBlock < 0) throw new Error("Start block must be a non-negative integer");
    if (!Number.isSafeInteger(confirmations) || confirmations < 0) throw new Error("Confirmations must be a non-negative integer");
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error("Chunk size must be a positive integer");
    core.normalizeAddress(config.escrow, "escrow");
    return {
      rpcUrl: config.rpcUrl,
      escrow: core.normalizeAddress(config.escrow, "escrow"),
      chainId,
      startBlock,
      confirmations,
      chunkSize,
    };
  }

  async function rpcCall(rpcUrl, method, params) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message || "RPC error");
    return payload.result;
  }

  async function scanFunded(config) {
    const chainIdHex = await rpcCall(config.rpcUrl, "eth_chainId", []);
    const rpcChainId = core.numberFromRpcQuantity(chainIdHex, "RPC chain id");
    if (rpcChainId !== config.chainId) {
      throw new Error(`RPC chain id ${rpcChainId} does not match ${config.chainId}`);
    }

    const headHex = await rpcCall(config.rpcUrl, "eth_blockNumber", []);
    const headBlock = core.numberFromRpcQuantity(headHex, "head block");
    const safeToBlock = headBlock - config.confirmations + 1;
    if (safeToBlock < config.startBlock) {
      return { headBlock, safeToBlock: null, entries: [] };
    }

    const entries = [];
    for (let fromBlock = config.startBlock; fromBlock <= safeToBlock; fromBlock += config.chunkSize + 1) {
      const toBlock = Math.min(safeToBlock, fromBlock + config.chunkSize);
      setStatus(`Scanning blocks ${fromBlock} to ${toBlock}`, "neutral");
      const logs = await rpcCall(config.rpcUrl, "eth_getLogs", [
        core.buildFundedFilter({ escrow: config.escrow, fromBlock, toBlock }),
      ]);
      for (const log of logs) {
        entries.push(core.decodeFundedLog(log, {
          chainId: config.chainId,
          headBlock,
        }));
      }
    }

    return { headBlock, safeToBlock, entries };
  }

  function shortHash(value) {
    if (!value) return "";
    return `${value.slice(0, 10)}...${value.slice(-6)}`;
  }

  function explorerTxUrl(chainId, txHash) {
    if (chainId === 84532) return `https://sepolia.basescan.org/tx/${txHash}`;
    if (chainId === 8453) return `https://basescan.org/tx/${txHash}`;
    return "";
  }

  function deadlineText(deadline) {
    const millis = Number(deadline) * 1000;
    if (!Number.isFinite(millis)) return String(deadline);
    return new Date(millis).toLocaleString();
  }

  function render() {
    const state = readState();
    const entries = state.entries || [];
    el.taskCount.textContent = String(entries.length);
    el.cursor.textContent = state.cursor
      ? `Next block ${state.cursor.nextFromBlock}; head ${state.cursor.headBlock}`
      : "No cursor";
    el.empty.hidden = entries.length > 0;
    el.tableBody.replaceChildren(...entries.map(renderRow));
  }

  function renderRow(entry) {
    const row = document.createElement("tr");
    const txUrl = explorerTxUrl(entry.chain_id, entry.tx_hash);
    const txNode = txUrl
      ? Object.assign(document.createElement("a"), {
        href: txUrl,
        target: "_blank",
        rel: "noreferrer",
        textContent: shortHash(entry.tx_hash),
      })
      : document.createTextNode(shortHash(entry.tx_hash));

    [
      `${core.formatTokenAmount(entry.amount, 6)} USDC`,
      shortHash(entry.task_hash),
      shortHash(entry.buyer),
      shortHash(entry.token),
      deadlineText(entry.deadline),
      `${entry.block_number} / ${entry.confirmations}`,
    ].forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });

    const txCell = document.createElement("td");
    txCell.appendChild(txNode);
    row.appendChild(txCell);
    return row;
  }

  function saveConfig(config) {
    const state = readState();
    state.config = config;
    writeState(state);
  }

  async function onScan() {
    el.scan.disabled = true;
    try {
      const rawConfig = readConfig();
      const config = requireConfig(rawConfig);
      saveConfig(rawConfig);
      setStatus("Checking RPC", "neutral");
      const result = await scanFunded(config);
      const state = readState();
      const merged = core.mergeEntries(state.entries || [], result.entries);
      state.entries = merged;
      const nextFromBlock = result.safeToBlock === null ? config.startBlock : result.safeToBlock + 1;
      state.cursor = {
        nextFromBlock,
        headBlock: result.headBlock,
        updatedAt: new Date().toISOString(),
      };
      state.config = {
        ...rawConfig,
        startBlock: String(nextFromBlock),
      };
      writeState(state);
      setFormFromState(state);
      render();
      setStatus(`Loaded ${result.entries.length} new funded task event(s)`, "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      el.scan.disabled = false;
    }
  }

  function onImportHandoff() {
    try {
      const handoff = JSON.parse(el.handoff.value);
      const derived = core.deriveConfigFromHandoff(handoff);
      const state = readState();
      state.config = {
        ...state.config,
        ...derived,
      };
      writeState(state);
      setFormFromState(state);
      setStatus("Imported public handoff metadata", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  function onClear() {
    window.localStorage.removeItem(storageKey);
    setFormFromState({});
    render();
    setStatus("Local cache cleared", "neutral");
  }

  function init() {
    const state = readState();
    setFormFromState(state);
    render();
    el.scan.addEventListener("click", onScan);
    el.importHandoff.addEventListener("click", onImportHandoff);
    el.clear.addEventListener("click", onClear);
  }

  init();
})();
