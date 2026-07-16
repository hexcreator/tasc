(function initProductionRun() {
  "use strict";

  const core = window.TascWebCore;
  const state = {
    artifact: null,
    summary: null,
    walletAddress: "",
    lastSubmission: null,
  };

  const el = {
    rpcUrl: document.querySelector("#production-rpc-url"),
    connectWallet: document.querySelector("#connect-wallet"),
    walletReadout: document.querySelector("#wallet-readout"),
    artifactLabel: document.querySelector("#artifact-label"),
    artifactFile: document.querySelector("#artifact-file"),
    artifactJson: document.querySelector("#artifact-json"),
    reviewArtifact: document.querySelector("#review-artifact"),
    enableSubmit: document.querySelector("#enable-production-submit"),
    submitArtifact: document.querySelector("#submit-artifact"),
    status: document.querySelector("#status"),
    artifactPhase: document.querySelector("#artifact-phase"),
    walletMatch: document.querySelector("#wallet-match"),
    artifactKind: document.querySelector("#artifact-kind"),
    artifactSummary: document.querySelector("#artifact-summary"),
    captureCommand: document.querySelector("#capture-command"),
    submitOutput: document.querySelector("#submit-output"),
  };

  function setStatus(message, variant) {
    el.status.textContent = message;
    el.status.dataset.variant = variant || "neutral";
  }

  function shortMiddle(value) {
    if (!value) return "";
    const text = String(value);
    if (text.length <= 18) return text;
    return `${text.slice(0, 8)}...${text.slice(-6)}`;
  }

  function solanaProvider() {
    if (window.solana && window.solana.isPhantom) return window.solana;
    if (window.phantom && window.phantom.solana) return window.phantom.solana;
    return window.solana || null;
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

  async function pollSolanaSignature(rpcUrl, signature) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await solanaRpcCall(rpcUrl, "getSignatureStatuses", [
        [signature],
        { searchTransactionHistory: true },
      ]);
      const value = status.value && status.value[0];
      if (value && value.err) throw new Error(`Transaction failed: ${JSON.stringify(value.err)}`);
      if (value && (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized")) {
        return {
          confirmationStatus: value.confirmationStatus,
          confirmedAt: new Date().toISOString(),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return {
      confirmationStatus: "pending",
      confirmedAt: "",
    };
  }

  function connectedWalletMatches() {
    return Boolean(state.summary && state.walletAddress && state.walletAddress === state.summary.signer);
  }

  function updateSubmitState() {
    el.submitArtifact.disabled = !(
      state.summary &&
      connectedWalletMatches() &&
      el.enableSubmit.checked &&
      el.rpcUrl.value.trim()
    );
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function metaItem(label, value) {
    const item = document.createElement("div");
    item.className = "meta-item";
    const span = document.createElement("span");
    span.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value ? String(value) : "n/a";
    item.append(span, strong);
    return item;
  }

  function renderSummary() {
    const summary = state.summary;
    clearNode(el.artifactSummary);
    el.artifactPhase.textContent = summary ? summary.phase : "None";
    el.artifactKind.textContent = summary ? summary.artifact_kind : "No artifact loaded";
    el.walletReadout.textContent = state.walletAddress
      ? `${state.walletAddress}${summary && !connectedWalletMatches() ? " (does not match artifact signer)" : ""}`
      : "No wallet connected";
    el.walletMatch.textContent = connectedWalletMatches() ? "Matched" : state.walletAddress ? "Mismatch" : "Offline";
    el.walletMatch.style.color = connectedWalletMatches() ? "var(--success)" : "";

    if (!summary) {
      el.captureCommand.value = "";
      updateSubmitState();
      return;
    }

    const rows = [
      ["Phase", summary.phase],
      ["Signer role", summary.signer_role],
      ["Signer", summary.signer],
      ["Owner", summary.owner],
      ["USDC ATA", summary.associated_token_account],
      ["Task account", summary.task_account],
      ["Vault token", summary.vault_token_account],
      ["Destination", summary.destination_token_account],
      ["Result hash", summary.result_hash],
      ["Tx sha256", summary.unsigned_transaction_sha256],
    ];
    for (const [label, value] of rows) el.artifactSummary.appendChild(metaItem(label, value));
    el.captureCommand.value = summary.capture_command;
    updateSubmitState();
  }

  function buildCaptureCommand(signature, timestamps) {
    const summary = state.summary;
    if (!summary) return "";
    const replacements = {
      [`<${summary.phase}-sig>`]: signature,
      "<iso-claim-started>": timestamps.claimStartedAt || "<iso-claim-started>",
      "<iso-release-confirmed>": timestamps.releaseConfirmedAt || "<iso-release-confirmed>",
      "<iso-completed-indexed>": "<iso-completed-indexed>",
    };
    let command = summary.capture_command;
    for (const [needle, value] of Object.entries(replacements)) command = command.replace(needle, value);
    return command;
  }

  function artifactPathLabel() {
    const label = el.artifactLabel.value.trim();
    return label || "<transaction-artifact.json>";
  }

  function artifactPathFromFileName(name) {
    const fileName = String(name || "");
    if (/^production-(fund-transaction|lifecycle-(claim|attest|release)|token-account-setup-(buyer|worker))\.json$/.test(fileName)) {
      return `.tascverifier/${fileName}`;
    }
    return fileName;
  }

  async function onConnectWallet() {
    el.connectWallet.disabled = true;
    try {
      const provider = solanaProvider();
      if (!provider || !provider.connect) throw new Error("Solana wallet provider not found");
      const result = await provider.connect();
      const address = result && result.publicKey ? result.publicKey.toString() : "";
      if (!address) throw new Error("Wallet did not return a public key");
      state.walletAddress = address;
      renderSummary();
      setStatus(`Connected ${shortMiddle(address)}`, connectedWalletMatches() ? "success" : "neutral");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      el.connectWallet.disabled = false;
      updateSubmitState();
    }
  }

  function onReviewArtifact() {
    try {
      const artifact = JSON.parse(el.artifactJson.value || "{}");
      const summary = core.summarizeProductionTransactionArtifact(artifact, {
        artifactFile: artifactPathLabel(),
      });
      state.artifact = artifact;
      state.summary = summary;
      state.lastSubmission = null;
      el.submitOutput.value = "";
      renderSummary();
      setStatus(`Reviewed ${summary.phase} artifact for ${shortMiddle(summary.signer)}`, "success");
    } catch (error) {
      state.artifact = null;
      state.summary = null;
      renderSummary();
      setStatus(error.message, "error");
    }
  }

  async function onArtifactFileChange() {
    const file = el.artifactFile.files && el.artifactFile.files[0];
    if (!file) return;
    el.artifactLabel.value = artifactPathFromFileName(file.name) || artifactPathLabel();
    el.artifactJson.value = await file.text();
    onReviewArtifact();
  }

  async function onSubmitArtifact() {
    el.submitArtifact.disabled = true;
    const claimStartedAt = state.summary && state.summary.phase === "claim" ? new Date().toISOString() : "";
    try {
      if (!state.summary) throw new Error("Review a production artifact first");
      if (!el.enableSubmit.checked) throw new Error("Enable production wallet sends first");
      if (!connectedWalletMatches()) throw new Error("Connected wallet must match artifact signer");
      const rpcUrl = el.rpcUrl.value.trim();
      if (!rpcUrl) throw new Error("Mainnet RPC URL is required");
      const provider = solanaProvider();
      if (!provider) throw new Error("Solana wallet provider not found");

      setStatus(`Waiting for wallet signature: ${state.summary.phase}`, "neutral");
      const sent = await core.submitSolanaWalletTransaction({
        provider,
        payload: state.summary.wallet_payload,
        rpcSendTransaction: (rawBase64, options) => solanaRpcCall(rpcUrl, "sendTransaction", [rawBase64, options]),
      });
      setStatus(`Submitted ${shortMiddle(sent.signature)}, checking confirmation`, "neutral");
      const polled = await pollSolanaSignature(rpcUrl, sent.signature);
      const releaseConfirmedAt = state.summary.phase === "release" && polled.confirmationStatus !== "pending"
        ? polled.confirmedAt
        : "";
      const captureCommand = buildCaptureCommand(sent.signature, {
        claimStartedAt,
        releaseConfirmedAt,
      });
      state.lastSubmission = {
        kind: "tasc.production_wallet_submission",
        version: "0.1",
        phase: state.summary.phase,
        signer: state.summary.signer,
        signature: sent.signature,
        transport: sent.transport,
        confirmation_status: polled.confirmationStatus,
        submitted_at: new Date().toISOString(),
        claim_started_at: claimStartedAt || null,
        release_confirmed_at: releaseConfirmedAt || null,
        capture_command: captureCommand,
      };
      el.captureCommand.value = captureCommand;
      el.submitOutput.value = JSON.stringify(state.lastSubmission, null, 2);
      setStatus(`Submitted ${state.summary.phase}: ${shortMiddle(sent.signature)} (${polled.confirmationStatus})`, "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      updateSubmitState();
    }
  }

  function init() {
    renderSummary();
    el.connectWallet.addEventListener("click", onConnectWallet);
    el.artifactFile.addEventListener("change", onArtifactFileChange);
    el.reviewArtifact.addEventListener("click", onReviewArtifact);
    el.enableSubmit.addEventListener("change", updateSubmitState);
    el.rpcUrl.addEventListener("input", updateSubmitState);
    el.artifactLabel.addEventListener("change", () => {
      if (state.artifact) onReviewArtifact();
    });
    el.submitArtifact.addEventListener("click", onSubmitArtifact);
  }

  init();
})();
