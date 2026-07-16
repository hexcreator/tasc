(function initTaskFeedApp() {
  "use strict";

  const core = window.TascWebCore;
  const demoIndex = window.TascDemoIndex;
  const storageKey = "global-tasc.web.feed.v1";
  const defaultAttestResultHash = "0x0bdfacb7e0ec2c3241da82c7b812b1a0fa28945b47c7f8a6b113b4de3779776f";

  const el = {
    loadDemo: document.querySelector("#load-demo"),
    feedImport: document.querySelector("#feed-import"),
    feedFiles: document.querySelector("#feed-files"),
    importFeed: document.querySelector("#import-feed"),
    solanaRpcUrl: document.querySelector("#solana-rpc-url"),
    connectSolana: document.querySelector("#connect-solana"),
    refreshSolana: document.querySelector("#refresh-solana"),
    attestVerdict: document.querySelector("#attest-verdict"),
    attestResultHash: document.querySelector("#attest-result-hash"),
    enableSolanaSubmit: document.querySelector("#enable-solana-submit"),
    solanaWallet: document.querySelector("#solana-wallet"),
    verifierApiUrl: document.querySelector("#verifier-api-url"),
    verifierApiToken: document.querySelector("#verifier-api-token"),
    walletRole: document.querySelector("#wallet-role"),
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
    const solana = state.solana || {};
    el.solanaRpcUrl.value = solana.rpcUrl || core.DEFAULT_SOLANA_RPC_URL;
    el.attestVerdict.value = solana.attestVerdict || "pass";
    el.attestResultHash.value = solana.attestResultHash || defaultAttestResultHash;
    el.enableSolanaSubmit.checked = Boolean(solana.enableSubmit);
    el.verifierApiUrl.value = (state.verifier && state.verifier.apiUrl) || "";
    el.verifierApiToken.value = (state.verifier && state.verifier.token) || "";
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

  function readSolanaConfig() {
    return {
      rpcUrl: el.solanaRpcUrl.value.trim() || core.DEFAULT_SOLANA_RPC_URL,
      attestVerdict: el.attestVerdict.value,
      attestResultHash: el.attestResultHash.value.trim() || defaultAttestResultHash,
      enableSubmit: el.enableSolanaSubmit.checked,
    };
  }

  function readVerifierConfig() {
    return {
      apiUrl: el.verifierApiUrl.value.trim(),
      token: el.verifierApiToken.value.trim(),
    };
  }

  async function loadLocalBetaConfig() {
    try {
      const response = await fetch("./tasc-local-config.json", { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      if (!payload || payload.kind !== "tasc.private_beta.local_config" || !payload.verifier) return;
      const apiUrl = String(payload.verifier.apiUrl || "").trim();
      const token = String(payload.verifier.token || "").trim();
      if (!apiUrl) return;
      const state = readState();
      const current = state.verifier || {};
      const hasManualVerifier = (current.apiUrl || current.token) && current.source !== "local-beta";
      if (hasManualVerifier && (!current.apiUrl || current.apiUrl !== apiUrl)) return;
      state.verifier = { apiUrl, token, source: "local-beta" };
      writeState(state);
      setFormFromState(state);
      setStatus("Loaded local beta verifier config", "success");
    } catch (_error) {
      // Hosted static deployments do not provide local beta config.
    }
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

  async function solanaRpcCall(rpcUrl, method, params) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message || "Solana RPC error");
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

  function solanaEntries(state) {
    return (state.claimableEntries || []).filter((entry) => entry.settlement && entry.settlement.chain === "solana");
  }

  function solanaAccountForEntry(state, entry) {
    const taskPda = entry.settlement && entry.settlement.task_pda;
    return taskPda && state.solana && state.solana.accounts ? state.solana.accounts[taskPda] : null;
  }

  function connectedWallet(state) {
    return state.solana && state.solana.walletAddress ? state.solana.walletAddress : "";
  }

  function solanaProvider() {
    if (window.solana && window.solana.isPhantom) return window.solana;
    if (window.phantom && window.phantom.solana) return window.phantom.solana;
    return window.solana || null;
  }

  function solanaSubmissionKey(entry, action) {
    const taskPda = entry.settlement && entry.settlement.task_pda ? entry.settlement.task_pda : entry.task_hash;
    return `${taskPda}:${String(action || "").toLowerCase().replace(/\s+/g, "-")}`;
  }

  function solanaSubmissionForEntry(state, entry, action) {
    const submissions = state.solana && state.solana.submissions ? state.solana.submissions : {};
    return submissions[solanaSubmissionKey(entry, action)] || null;
  }

  function workerSubmissionKey(entry) {
    const settlement = entry.settlement || {};
    return settlement.task_pda || entry.task_hash || entry.intent_hash;
  }

  function workerSubmissionForEntry(state, entry) {
    const submissions = state.workerSubmissions || {};
    return submissions[workerSubmissionKey(entry)] || null;
  }

  function verifierIngestionForEntry(state, entry) {
    const ingestions = state.verifierIngestions || {};
    return ingestions[workerSubmissionKey(entry)] || null;
  }

  function displayReward(entry, custody) {
    if (entry.display_reward && entry.display_reward.amount && entry.display_reward.currency) {
      return `${entry.display_reward.amount} ${entry.display_reward.currency}`;
    }
    return `${core.formatTokenAmount(entry.amount, custody.decimals ?? 6)} USDC`;
  }

  function relativeDeadlineText(entry) {
    const deadline = entry.relative_deadline || (entry.task && entry.task.deadline);
    if (!deadline) return null;
    if (deadline.raw) return deadline.raw;
    if (deadline.seconds !== undefined) return `${deadline.seconds}s`;
    return null;
  }

  function verifyRuleText(rule, inputs) {
    if (!rule || !rule.op) return "";
    const args = rule.args || [];
    if (rule.op === "min_words" && args[0]) return `Minimum ${args[0]} words`;
    if (rule.op === "contains_citation" && args[0]) {
      const inputName = String(args[0]).replace(/^input\./, "");
      return inputs[inputName] ? `Cite ${inputs[inputName]}` : `Cite ${args[0]}`;
    }
    if (rule.op === "no_duplicate" && args[0]) return `No duplicate ${args[0]} submission`;
    return [rule.op, ...args].join(" ");
  }

  function renderTaskBrief(entry) {
    const inputs = entry.inputs || {};
    const task = entry.task || {};
    const inputEntries = Object.entries(inputs);
    const outputEntries = Array.isArray(task.outputs) ? task.outputs : [];
    const verifyRules = Array.isArray(task.verify) ? task.verify.map((rule) => verifyRuleText(rule, inputs)).filter(Boolean) : [];
    if (inputEntries.length === 0 && outputEntries.length === 0 && verifyRules.length === 0) return null;

    const brief = document.createElement("div");
    brief.className = "task-brief";

    if (inputEntries.length > 0) {
      const group = document.createElement("div");
      group.className = "task-brief-group";
      const label = document.createElement("span");
      label.textContent = "Input";
      const list = document.createElement("div");
      list.className = "task-brief-list";
      for (const [name, value] of inputEntries) {
        const item = document.createElement("div");
        const nameNode = document.createElement("strong");
        nameNode.textContent = name;
        const valueNode = /^https?:\/\//.test(String(value))
          ? Object.assign(document.createElement("a"), {
            href: String(value),
            target: "_blank",
            rel: "noreferrer",
            textContent: String(value),
          })
          : Object.assign(document.createElement("span"), { textContent: String(value) });
        item.append(nameNode, valueNode);
        list.append(item);
      }
      group.append(label, list);
      brief.append(group);
    }

    if (outputEntries.length > 0) {
      const group = document.createElement("div");
      group.className = "task-brief-group";
      const label = document.createElement("span");
      label.textContent = "Output";
      const value = document.createElement("strong");
      value.textContent = outputEntries.map((field) => `${field.name} ${field.type}`).join(", ");
      group.append(label, value);
      brief.append(group);
    }

    if (verifyRules.length > 0) {
      const group = document.createElement("div");
      group.className = "task-brief-group";
      const label = document.createElement("span");
      label.textContent = "Verifier";
      const value = document.createElement("strong");
      value.textContent = verifyRules.join(" · ");
      group.append(label, value);
      brief.append(group);
    }

    return brief;
  }

  function messageSignatureFromResult(result) {
    const signature = result && result.signature !== undefined ? result.signature : result;
    if (typeof signature === "string") return signature;
    if (signature instanceof Uint8Array || Array.isArray(signature)) return core.base58Encode(signature);
    if (signature && signature.data && Array.isArray(signature.data)) return core.base58Encode(signature.data);
    if (signature && signature.toString && signature.toString() !== "[object Object]") return signature.toString();
    return "";
  }

  async function signWorkerSubmission(provider, submission, wallet) {
    if (!wallet || !provider || !provider.signMessage) return submission;
    const message = core.canonicalize(submission);
    const encoded = new TextEncoder().encode(message);
    const signed = await provider.signMessage(encoded, "utf8");
    const signature = messageSignatureFromResult(signed);
    if (!signature) throw new Error("Wallet did not return a message signature");
    return {
      ...submission,
      signature: {
        scheme: "solana.signMessage",
        signer: wallet,
        message_hash: `sha256:${await core.sha256HexFromText(message)}`,
        signature,
      },
    };
  }

  async function onCaptureWorkerSubmission(entry, textarea, button) {
    try {
      if (button) button.disabled = true;
      const state = readState();
      const wallet = connectedWallet(state);
      const provider = solanaProvider();
      const submission = await core.buildWorkerSubmission({
        entry,
        markdown: textarea.value,
        workerAddress: wallet || null,
      });
      const signedSubmission = await signWorkerSubmission(provider, submission, wallet);
      const nextState = readState();
      nextState.workerSubmissions = {
        ...(nextState.workerSubmissions || {}),
        [workerSubmissionKey(entry)]: signedSubmission,
      };
      nextState.solana = {
        ...(nextState.solana || {}),
        ...readSolanaConfig(),
        attestResultHash: signedSubmission.result_hash_bytes32,
      };
      writeState(nextState);
      setFormFromState(nextState);
      render();
      setStatus(`Captured submission ${shortHash(signedSubmission.result_hash_bytes32)}`, "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function onCopyWorkerSubmission(entry) {
    try {
      const submission = workerSubmissionForEntry(readState(), entry);
      if (!submission) throw new Error("Capture a submission first");
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("Clipboard API is unavailable");
      await navigator.clipboard.writeText(JSON.stringify(submission, null, 2));
      setStatus("Copied submission proof JSON", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  function verifierIngestUrl(apiUrl) {
    if (!apiUrl) throw new Error("Verifier API URL is required");
    const url = new URL(apiUrl, window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Verifier API URL must be http(s)");
    const basePath = url.pathname.replace(/\/$/, "");
    url.pathname = basePath.endsWith("/v1/ingest") ? basePath : `${basePath}/v1/ingest`;
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  function resultHashBytes32FromSha256(resultHash) {
    const value = String(resultHash || "");
    const match = value.match(/^sha256:([a-fA-F0-9]{64})$/);
    if (!match) throw new Error("Verifier response result_hash must be sha256:<hex>");
    return `0x${match[1].toLowerCase()}`;
  }

  function normalizeVerifierIngestion(payload, submission) {
    if (!payload || payload.kind !== "tasc.verifier.ingestion") {
      throw new Error(payload && payload.error ? payload.error : "Verifier response must be tasc.verifier.ingestion");
    }
    const attestation = payload.attestation || {};
    const settlement = payload.settlement || {};
    const attest = settlement.attest || {};
    const verdict = attest.verdict || attestation.verdict;
    if (verdict !== "pass" && verdict !== "fail") throw new Error("Verifier response verdict must be pass or fail");
    const resultHash = attestation.result_hash || attest.result_hash;
    if (resultHash !== submission.result_hash) throw new Error("Verifier response result_hash does not match submission");
    const resultHashBytes32 = attest.result_hash_bytes32 || resultHashBytes32FromSha256(resultHash);
    if (!/^0x[a-fA-F0-9]{64}$/.test(resultHashBytes32)) throw new Error("Verifier response result_hash_bytes32 is invalid");
    return {
      ...payload,
      settlement: {
        ...settlement,
        attest: {
          ...attest,
          verdict,
          result_hash: resultHash,
          result_hash_bytes32: resultHashBytes32.toLowerCase(),
        },
      },
    };
  }

  async function submitVerifierIngestion(apiUrl, token, submission) {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(verifierIngestUrl(apiUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ submission }),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (_error) {
      throw new Error(`Verifier HTTP ${response.status}`);
    }
    if (!response.ok && (!payload || payload.kind !== "tasc.verifier.ingestion")) {
      throw new Error(payload && payload.error ? payload.error : `Verifier HTTP ${response.status}`);
    }
    return normalizeVerifierIngestion(payload, submission);
  }

  async function onSubmitWorkerSubmissionToVerifier(entry, button) {
    try {
      if (button) button.disabled = true;
      const state = readState();
      const submission = workerSubmissionForEntry(state, entry);
      if (!submission) throw new Error("Capture a submission first");
      const verifier = readVerifierConfig();
      setStatus("Submitting proof to verifier", "neutral");
      const ingestion = await submitVerifierIngestion(verifier.apiUrl, verifier.token, submission);
      const attest = ingestion.settlement.attest;
      const nextState = readState();
      nextState.verifier = verifier;
      nextState.verifierIngestions = {
        ...(nextState.verifierIngestions || {}),
        [workerSubmissionKey(entry)]: ingestion,
      };
      nextState.solana = {
        ...(nextState.solana || {}),
        ...readSolanaConfig(),
        attestVerdict: attest.verdict,
        attestResultHash: attest.result_hash_bytes32,
      };
      writeState(nextState);
      setFormFromState(nextState);
      render();
      const prefix = ingestion.accepted ? "Verifier accepted" : "Verifier rejected";
      setStatus(`${prefix}: ${attest.verdict} ${shortHash(attest.result_hash_bytes32)}`, ingestion.accepted ? "success" : "error");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  function renderWorkerSubmission(entry, state) {
    if (entry.completed_status || entry.status === "completed") return null;
    const latest = workerSubmissionForEntry(state, entry);
    const latestIngestion = verifierIngestionForEntry(state, entry);
    const panel = document.createElement("div");
    panel.className = "worker-submission";

    const label = document.createElement("div");
    label.className = "worker-submission-label";
    label.textContent = "Worker Submission";

    const textarea = document.createElement("textarea");
    textarea.className = "worker-output";
    textarea.spellcheck = true;
    textarea.placeholder = "Paste markdown output";
    textarea.value = latest && latest.output ? latest.output.markdown : "";

    const actions = document.createElement("div");
    actions.className = "actions";
    const capture = document.createElement("button");
    capture.type = "button";
    capture.textContent = "Capture Submission";
    capture.addEventListener("click", () => onCaptureWorkerSubmission(entry, textarea, capture));
    actions.append(capture);
    if (latest) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy Proof";
      copy.addEventListener("click", () => onCopyWorkerSubmission(entry));
      actions.append(copy);
      const verify = document.createElement("button");
      verify.type = "button";
      verify.textContent = "Submit to Verifier";
      verify.addEventListener("click", () => onSubmitWorkerSubmissionToVerifier(entry, verify));
      actions.append(verify);
    }

    panel.append(label, textarea, actions);
    if (latest) {
      const proof = document.createElement("div");
      proof.className = "submission-proof";
      proof.append(
        metaItem("Result hash", shortHash(latest.result_hash_bytes32)),
        metaItem("Local verdict", latest.local_verdict),
        metaItem("Signature", latest.signature ? "signed" : "unsigned"),
      );
      panel.append(proof);
      if (latestIngestion) {
        const attest = latestIngestion.settlement && latestIngestion.settlement.attest ? latestIngestion.settlement.attest : {};
        const verifierProof = document.createElement("div");
        verifierProof.className = "submission-proof verifier-proof";
        verifierProof.append(
          metaItem("Verifier", latestIngestion.accepted ? "accepted" : "rejected"),
          metaItem("Attest", attest.verdict || "unknown"),
          metaItem("Attest hash", attest.result_hash_bytes32 ? shortHash(attest.result_hash_bytes32) : ""),
        );
        panel.append(verifierProof);
      }
      const proofJson = document.createElement("textarea");
      proofJson.className = "submission-json";
      proofJson.readOnly = true;
      proofJson.spellcheck = false;
      proofJson.value = JSON.stringify(latestIngestion || latest, null, 2);
      panel.append(proofJson);
    }
    return panel;
  }

  function feedSourceText(state) {
    if (state.feedSource && state.feedSource.label) {
      return `${state.feedSource.label}: ${state.feedSource.count} task(s)`;
    }
    return "Bundled devnet proof loaded";
  }

  function walletReadout(state) {
    const wallet = connectedWallet(state);
    if (!wallet) return "No wallet connected";
    return shortMiddle(wallet);
  }

  function walletRoleText(state) {
    const wallet = connectedWallet(state);
    if (!wallet) return "Offline";
    const first = solanaEntries(state)[0];
    if (!first) return "Connected";
    const account = solanaAccountForEntry(state, first);
    const role = core.solanaWalletRole(first, account, wallet);
    return role.split(" ").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
  }

  function render() {
    const state = readState();
    const entries = state.entries || [];
    const claimableEntries = state.claimableEntries || [];
    el.taskCount.textContent = String(entries.length + claimableEntries.length);
    el.walletRole.textContent = walletRoleText(state);
    el.solanaWallet.textContent = walletReadout(state);
    el.cursor.textContent = state.cursor
      ? `Next block ${state.cursor.nextFromBlock}; head ${state.cursor.headBlock}`
      : claimableEntries.length > 0
        ? feedSourceText(state)
        : "No cursor";
    el.claimableList.replaceChildren(...claimableEntries.map((entry) => renderClaimableCard(entry, state)));
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

  function renderClaimableCard(entry, state) {
    const card = document.createElement("article");
    card.className = "claimable-card";
    const settlement = entry.settlement || {};
    const funding = entry.funding || {};
    const custody = funding.custody || {};
    const completedSettlement = entry.completed_settlement || {};
    const cluster = settlement.cluster || "devnet";
    const reward = displayReward(entry, custody);
    const deadlineText = relativeDeadlineText(entry);
    const liveAccount = solanaAccountForEntry(state, entry);
    const wallet = connectedWallet(state);
    const solanaConfig = readSolanaConfig();
    const action = settlement.chain === "solana"
      ? core.solanaNextAction(entry, liveAccount, wallet)
      : { status: entry.status, role: "operator", action: "watch", actor: "operator", enabled: false };
    const lastSubmission = solanaSubmissionForEntry(state, entry, action.action);

    const header = document.createElement("div");
    header.className = "claimable-card-header";
    const titleWrap = document.createElement("div");
    const eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = `${settlement.chain || "chain"} / ${cluster}`;
    const title = document.createElement("h3");
    title.textContent = entry.task_name || (entry.task && entry.task.name) || entry.name || "Tasc task";
    const subtitle = document.createElement("p");
    subtitle.textContent = entry.completed_status
      ? `Completed with ${entry.completed_status} settlement evidence.`
      : entry.inputs && entry.inputs.url
        ? "Ready to claim: summarize the linked source and submit markdown proof."
        : "Live devnet task admitted from signed intent plus SPL vault custody.";
    titleWrap.append(eyebrow, title, subtitle);

    const rewardNode = document.createElement("div");
    rewardNode.className = "reward";
    rewardNode.textContent = reward;
    header.append(titleWrap, rewardNode);

    const meta = document.createElement("div");
    meta.className = "claimable-meta";
    const evidenceSignature = completedSettlement.signature || funding.signature || "";
    const evidenceLabel = completedSettlement.signature ? "Settlement tx" : "Funding tx";
    const amountLabel = completedSettlement.signature ? "Settled" : "Custody";
    const amountValue = completedSettlement.amount || custody.amount || entry.amount || "0";
    meta.append(
      metaItem("Status", entry.completed_status || entry.status),
      metaItem("Live", liveAccount ? liveAccount.status : "not scanned"),
      metaItem("Task", shortHash(entry.task_hash)),
      metaItem("Program", shortMiddle(settlement.program_id), solanaExplorerUrl(`address/${settlement.program_id}`, cluster)),
      metaItem("Task account", shortMiddle(settlement.task_pda), solanaExplorerUrl(`address/${settlement.task_pda}`, cluster)),
      metaItem("Vault", shortMiddle(settlement.vault), solanaExplorerUrl(`address/${settlement.vault}`, cluster)),
      metaItem(amountLabel, `${core.formatTokenAmount(amountValue, custody.decimals ?? 6)} USDC`),
      metaItem(evidenceLabel, shortMiddle(evidenceSignature), evidenceSignature ? solanaExplorerUrl(`tx/${evidenceSignature}`, cluster) : null),
      metaItem("Verifier", shortMiddle(entry.verifier), solanaExplorerUrl(`address/${entry.verifier}`, cluster)),
    );
    if (deadlineText) meta.append(metaItem("SLA", deadlineText));
    if (entry.input_hash) meta.append(metaItem("Input hash", shortHash(entry.input_hash)));
    if (liveAccount && liveAccount.worker !== core.ZERO_SOLANA_PUBKEY) {
      meta.append(metaItem("Worker", shortMiddle(liveAccount.worker), solanaExplorerUrl(`address/${liveAccount.worker}`, cluster)));
    }
    if (lastSubmission) {
      meta.append(metaItem("Last send", shortMiddle(lastSubmission.signature), solanaExplorerUrl(`tx/${lastSubmission.signature}`, cluster)));
    }

    const footer = document.createElement("div");
    footer.className = "claimable-card-footer";
    const actionGroup = document.createElement("div");
    actionGroup.className = "action-readiness";
    const live = document.createElement("span");
    live.className = `status-pill ${action.enabled ? "ready" : "idle"}`;
    live.textContent = action.enabled ? "Ready" : action.status;
    const role = document.createElement("span");
    role.textContent = `Role: ${action.role}`;
    const next = document.createElement("strong");
    next.textContent = `Next: ${action.action}`;
    actionGroup.append(live, role, next);
    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.disabled = !action.enabled || !solanaConfig.enableSubmit;
    actionButton.textContent = action.enabled
      ? solanaConfig.enableSubmit
        ? `Send ${action.action}`
        : "Enable sends"
      : `${action.actor} action`;
    actionButton.addEventListener("click", () => onSubmitSolanaAction(entry, action.action, actionButton));
    footer.append(actionGroup, actionButton);

    const taskBrief = renderTaskBrief(entry);
    const workerSubmission = renderWorkerSubmission(entry, state);
    card.append(header);
    if (taskBrief) card.append(taskBrief);
    if (workerSubmission) card.append(workerSubmission);
    card.append(meta, footer);
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

  function saveVerifierConfig() {
    const state = readState();
    state.verifier = readVerifierConfig();
    writeState(state);
  }

  function onLoadDemo() {
    const state = readState();
    state.claimableEntries = demoIndex && Array.isArray(demoIndex.entries) ? demoIndex.entries : [];
    state.feedSource = {
      label: "Bundled devnet proof",
      count: state.claimableEntries.length,
      importedAt: new Date().toISOString(),
    };
    state.solana = {
      ...(state.solana || {}),
      rpcUrl: readSolanaConfig().rpcUrl,
      attestVerdict: readSolanaConfig().attestVerdict,
      attestResultHash: readSolanaConfig().attestResultHash,
      enableSubmit: readSolanaConfig().enableSubmit,
    };
    writeState(state);
    render();
    setStatus(`Loaded ${state.claimableEntries.length} bundled devnet proof task(s)`, "success");
  }

  function importPathCandidates(rawPath) {
    const value = String(rawPath || "");
    if (/^https?:\/\//.test(value) || value.startsWith("/")) return [value];
    return [
      new URL(`../${value}`, window.location.href).toString(),
      new URL(value, window.location.href).toString(),
    ];
  }

  async function fetchImportJson(rawPath) {
    const errors = [];
    for (const candidate of importPathCandidates(rawPath)) {
      try {
        const response = await fetch(candidate, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        errors.push(`${candidate}: ${error.message}`);
      }
    }
    throw new Error(`Could not fetch ${rawPath}. Paste or select the referenced index JSON instead. ${errors.join("; ")}`);
  }

  async function entriesFromImportPayload(payload) {
    const parsed = core.indexEntriesFromImportPayload(payload);
    let entries = parsed.entries;
    for (const path of parsed.index_paths) {
      const fetched = await fetchImportJson(path);
      const fetchedParsed = await entriesFromImportPayload(fetched);
      entries = core.mergeIndexEntries(entries, fetchedParsed.entries);
    }
    return { entries, indexPaths: parsed.index_paths };
  }

  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.readAsText(file);
    });
  }

  async function payloadsFromFeedInputs() {
    const payloads = [];
    const pasted = el.feedImport.value.trim();
    if (pasted) payloads.push(JSON.parse(pasted));
    for (const file of Array.from(el.feedFiles.files || [])) {
      payloads.push(JSON.parse(await readFileText(file)));
    }
    if (payloads.length === 0) throw new Error("Paste or select a feed JSON file first");
    return payloads;
  }

  async function onImportFeed() {
    el.importFeed.disabled = true;
    try {
      const payloads = await payloadsFromFeedInputs();
      let importedEntries = [];
      let referencedPaths = [];
      for (const payload of payloads) {
        const imported = await entriesFromImportPayload(payload);
        importedEntries = core.mergeIndexEntries(importedEntries, imported.entries);
        referencedPaths = [...referencedPaths, ...imported.indexPaths];
      }
      if (importedEntries.length === 0) throw new Error("No index entries found in import");
      const state = readState();
      state.claimableEntries = core.mergeIndexEntries(state.claimableEntries || [], importedEntries);
      state.feedSource = {
        label: referencedPaths.length > 0 ? "Imported proof bundle" : "Imported feed",
        count: importedEntries.length,
        importedAt: new Date().toISOString(),
      };
      state.solana = {
        ...(state.solana || {}),
        ...readSolanaConfig(),
      };
      writeState(state);
      render();
      setStatus(`Imported ${importedEntries.length} feed task(s)`, "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      el.importFeed.disabled = false;
    }
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

  async function fetchSolanaTaskAccount(rpcUrl, entry) {
    const settlement = entry.settlement || {};
    if (settlement.chain !== "solana") return null;
    const taskPda = settlement.task_pda;
    if (!taskPda) return null;
    const result = await solanaRpcCall(rpcUrl, "getAccountInfo", [
      taskPda,
      {
        commitment: "confirmed",
        encoding: "base64",
      },
    ]);
    if (!result.value) throw new Error(`Task account ${shortMiddle(taskPda)} not found`);
    if (!Array.isArray(result.value.data) || result.value.data[1] !== "base64") {
      throw new Error("Solana task account did not return base64 data");
    }
    const decoded = core.decodeSolanaTaskAccountBase64(result.value.data[0], {
      programId: result.value.owner,
      taskPda,
    });
    return {
      ...decoded,
      owner: result.value.owner,
      lamports: String(result.value.lamports),
      slot: String(result.context && result.context.slot ? result.context.slot : "0"),
    };
  }

  async function onRefreshSolana() {
    el.refreshSolana.disabled = true;
    try {
      const solana = readSolanaConfig();
      const state = readState();
      const entries = solanaEntries(state);
      if (entries.length === 0) throw new Error("Load a Solana task first");
      setStatus("Refreshing Solana task accounts", "neutral");
      const accounts = {};
      for (const entry of entries) {
        const account = await fetchSolanaTaskAccount(solana.rpcUrl, entry);
        accounts[entry.settlement.task_pda] = account;
      }
      state.solana = {
        ...(state.solana || {}),
        rpcUrl: solana.rpcUrl,
        attestVerdict: solana.attestVerdict,
        attestResultHash: solana.attestResultHash,
        enableSubmit: solana.enableSubmit,
        accounts,
        refreshedAt: new Date().toISOString(),
      };
      writeState(state);
      render();
      setStatus(`Refreshed ${entries.length} Solana task account(s)`, "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      el.refreshSolana.disabled = false;
    }
  }

  async function onConnectSolana() {
    try {
      const provider = solanaProvider();
      if (!provider || !provider.connect) throw new Error("Solana wallet provider not found");
      const result = await provider.connect();
      const address = result && result.publicKey ? result.publicKey.toString() : "";
      if (!address) throw new Error("Wallet did not return a public key");
      const state = readState();
      state.solana = {
        ...(state.solana || {}),
        rpcUrl: readSolanaConfig().rpcUrl,
        attestVerdict: readSolanaConfig().attestVerdict,
        attestResultHash: readSolanaConfig().attestResultHash,
        enableSubmit: readSolanaConfig().enableSubmit,
        walletAddress: address,
      };
      writeState(state);
      render();
      setStatus(`Connected ${shortMiddle(address)}`, "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function sendWalletSolanaTransaction(provider, rpcUrl, payload) {
    return core.submitSolanaWalletTransaction({
      provider,
      payload,
      rpcSendTransaction: (rawBase64, options) => solanaRpcCall(rpcUrl, "sendTransaction", [rawBase64, options]),
    });
  }

  async function pollSolanaSignature(rpcUrl, signature) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const status = await solanaRpcCall(rpcUrl, "getSignatureStatuses", [
        [signature],
        { searchTransactionHistory: true },
      ]);
      const value = status.value && status.value[0];
      if (value && (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized")) {
        return value.confirmationStatus;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return "pending";
  }

  async function onSubmitSolanaAction(entry, actionName, button) {
    try {
      const solana = readSolanaConfig();
      if (!solana.enableSubmit) throw new Error("Enable wallet sends first");
      const provider = solanaProvider();
      if (!provider) throw new Error("Solana wallet provider not found");
      const state = readState();
      const wallet = connectedWallet(state);
      if (!wallet) throw new Error("Connect a Solana wallet first");
      const account = solanaAccountForEntry(state, entry);
      if (!account) throw new Error("Refresh the Solana task account first");
      if (button) button.disabled = true;
      setStatus(`Building ${actionName} transaction`, "neutral");
      const latest = await solanaRpcCall(solana.rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]);
      const payload = await core.buildSolanaLifecycleTransaction({
        entry,
        account,
        action: actionName,
        walletAddress: wallet,
        recentBlockhash: latest.value.blockhash,
        verdict: solana.attestVerdict,
        resultHash: solana.attestResultHash,
      });
      setStatus(`Waiting for wallet signature: ${payload.action}`, "neutral");
      const sent = await sendWalletSolanaTransaction(provider, solana.rpcUrl, payload);
      const confirmationStatus = await pollSolanaSignature(solana.rpcUrl, sent.signature);
      const nextState = readState();
      nextState.solana = {
        ...(nextState.solana || {}),
        rpcUrl: solana.rpcUrl,
        attestVerdict: solana.attestVerdict,
        attestResultHash: solana.attestResultHash,
        enableSubmit: solana.enableSubmit,
        submissions: {
          ...((nextState.solana && nextState.solana.submissions) || {}),
          [solanaSubmissionKey(entry, payload.action)]: {
            action: payload.action,
            signature: sent.signature,
            transport: sent.transport,
            confirmationStatus,
            submittedAt: new Date().toISOString(),
          },
        },
      };
      writeState(nextState);
      render();
      setStatus(`Submitted ${payload.action}: ${shortMiddle(sent.signature)} (${confirmationStatus})`, "success");
    } catch (error) {
      setStatus(error.message, "error");
      render();
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
    loadLocalBetaConfig();
    el.loadDemo.addEventListener("click", onLoadDemo);
    el.importFeed.addEventListener("click", onImportFeed);
    el.connectSolana.addEventListener("click", onConnectSolana);
    el.refreshSolana.addEventListener("click", onRefreshSolana);
    el.attestVerdict.addEventListener("change", () => {
      const state = readState();
      state.solana = { ...(state.solana || {}), ...readSolanaConfig() };
      writeState(state);
    });
    el.attestResultHash.addEventListener("change", () => {
      const state = readState();
      state.solana = { ...(state.solana || {}), ...readSolanaConfig() };
      writeState(state);
    });
    el.enableSolanaSubmit.addEventListener("change", () => {
      const state = readState();
      state.solana = { ...(state.solana || {}), ...readSolanaConfig() };
      writeState(state);
      render();
    });
    el.verifierApiUrl.addEventListener("change", saveVerifierConfig);
    el.verifierApiToken.addEventListener("change", saveVerifierConfig);
    el.scan.addEventListener("click", onScan);
    el.importHandoff.addEventListener("click", onImportHandoff);
    el.clear.addEventListener("click", onClear);
  }

  init();
})();
