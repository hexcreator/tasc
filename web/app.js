(function initTaskFeedApp() {
  "use strict";

  const core = window.TascWebCore;
  const demoIndex = window.TascDemoIndex;
  const storageKey = "global-tasc.web.feed.v1";

  const el = {
    loadDemo: document.querySelector("#load-demo"),
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
    claimableList: document.querySelector("#claimable-list"),
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

  function shortMiddle(value) {
    if (!value) return "";
    if (String(value).length <= 18) return String(value);
    return `${String(value).slice(0, 8)}...${String(value).slice(-6)}`;
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

  function solanaExplorerUrl(path, cluster) {
    return `https://explorer.solana.com/${path}?cluster=${encodeURIComponent(cluster || "devnet")}`;
  }

  function render() {
    const state = readState();
    const entries = state.entries || [];
    const claimableEntries = state.claimableEntries || [];
    el.taskCount.textContent = String(entries.length + claimableEntries.length);
    el.cursor.textContent = state.cursor
      ? `Next block ${state.cursor.nextFromBlock}; head ${state.cursor.headBlock}`
      : claimableEntries.length > 0
        ? "Bundled devnet proof loaded"
        : "No cursor";
    el.claimableList.replaceChildren(...claimableEntries.map(renderClaimableCard));
    el.empty.hidden = entries.length > 0 || claimableEntries.length > 0;
    el.tableBody.replaceChildren(...entries.map(renderRow));
  }

  function metaItem(label, value, href) {
    const item = document.createElement("div");
    item.className = "meta-item";
    const labelNode = document.createElement("span");
    labelNode.textContent = label;
    const valueNode = href
      ? Object.assign(document.createElement("a"), {
        href,
        target: "_blank",
        rel: "noreferrer",
        textContent: value,
      })
      : Object.assign(document.createElement("strong"), { textContent: value });
    item.append(labelNode, valueNode);
    return item;
  }

  function renderClaimableCard(entry) {
    const card = document.createElement("article");
    card.className = "claimable-card";
    const settlement = entry.settlement || {};
    const funding = entry.funding || {};
    const custody = funding.custody || {};
    const cluster = settlement.cluster || "devnet";
    const reward = `${core.formatTokenAmount(entry.amount, custody.decimals ?? 6)} USDC`;

    const header = document.createElement("div");
    header.className = "claimable-card-header";
    const titleWrap = document.createElement("div");
    const eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = `${settlement.chain || "chain"} / ${cluster}`;
    const title = document.createElement("h3");
    title.textContent = "summarize_url_spl";
    const subtitle = document.createElement("p");
    subtitle.textContent = "Live devnet task admitted from signed intent plus SPL vault custody.";
    titleWrap.append(eyebrow, title, subtitle);

    const rewardNode = document.createElement("div");
    rewardNode.className = "reward";
    rewardNode.textContent = reward;
    header.append(titleWrap, rewardNode);

    const meta = document.createElement("div");
    meta.className = "claimable-meta";
    meta.append(
      metaItem("Status", entry.status),
      metaItem("Task", shortHash(entry.task_hash)),
      metaItem("Program", shortMiddle(settlement.program_id), solanaExplorerUrl(`address/${settlement.program_id}`, cluster)),
      metaItem("Task account", shortMiddle(settlement.task_pda), solanaExplorerUrl(`address/${settlement.task_pda}`, cluster)),
      metaItem("Vault", shortMiddle(settlement.vault), solanaExplorerUrl(`address/${settlement.vault}`, cluster)),
      metaItem("Custody", `${core.formatTokenAmount(custody.amount || "0", custody.decimals ?? 6)} USDC`),
      metaItem("Funding tx", shortMiddle(funding.signature), solanaExplorerUrl(`tx/${funding.signature}`, cluster)),
      metaItem("Verifier", shortMiddle(entry.verifier), solanaExplorerUrl(`address/${entry.verifier}`, cluster)),
    );

    const footer = document.createElement("div");
    footer.className = "claimable-card-footer";
    const note = document.createElement("span");
    note.textContent = "Claim is disabled until the live Solana claim instruction is implemented.";
    const claim = document.createElement("button");
    claim.type = "button";
    claim.disabled = true;
    claim.textContent = "Claim pending";
    footer.append(note, claim);

    card.append(header, meta, footer);
    return card;
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

  function onLoadDemo() {
    const state = readState();
    state.claimableEntries = demoIndex && Array.isArray(demoIndex.entries) ? demoIndex.entries : [];
    writeState(state);
    render();
    setStatus(`Loaded ${state.claimableEntries.length} bundled devnet proof task(s)`, "success");
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
    el.loadDemo.addEventListener("click", onLoadDemo);
    el.scan.addEventListener("click", onScan);
    el.importHandoff.addEventListener("click", onImportHandoff);
    el.clear.addEventListener("click", onClear);
  }

  init();
})();
