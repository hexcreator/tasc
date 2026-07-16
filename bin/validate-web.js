#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const core = require("../web/tasc-web-core");
const demoIndex = require("../web/demo-index");

const WEB_DIR = "web";
const LOG = "examples/events/summarize_url.funded-log.json";
const FUNDING = "examples/funding/summarize_url.from-log.json";
const HANDOFF = "examples/testnet/base-sepolia.handoff.example.json";
const SOLANA_INDEX = "examples/index/solana.spl.live.index.json";
const SOLANA_RELEASE_INDEX = "examples/index/solana.spl.release.index.json";
const SOLANA_LIFECYCLE_ACCOUNT = "examples/solana-devnet/summarize_url_spl.lifecycle-account.live.json";
const SOLANA_RELEASE_PLAN = "examples/solana-devnet/summarize_url_spl.release-plan.live.json";
const SOLANA_TIMEOUT_FUNDING = "examples/solana-devnet/summarize_url_timeout_job_spl.funding.live.json";
const SOLANA_TIMEOUT_ACCOUNT = "examples/solana-devnet/summarize_url_timeout_job_spl.task-account.live.json";
const SOLANA_TIMEOUT_PLAN = "examples/solana-devnet/summarize_url_timeout_job_spl.timeout-refund-plan.live.json";
const SUBMISSION = "examples/submissions/summarize_url.pass.md";
const DUMMY_BLOCKHASH = "11111111111111111111111111111111";
const EXPECTED_SUBMISSION_HASH = "sha256:0bdfacb7e0ec2c3241da82c7b812b1a0fa28945b47c7f8a6b113b4de3779776f";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function assertNoExternalRuntimeDependencies() {
  const html = read(path.join(WEB_DIR, "index.html"));
  assert(!/(?:src|href)=["']https?:\/\//.test(html), "web/index.html should not load external runtime URLs");
  assert(html.includes("./tasc-web-core.js"), "index should load dependencyless core");
  assert(html.includes("./demo-index.js"), "index should load bundled demo index");
  assert(html.includes("./app.js"), "index should load app script");
  assert(html.includes("connect-solana"), "index should expose Solana wallet connection");
  assert(html.includes("refresh-solana"), "index should expose Solana task refresh");
  assert(html.includes("enable-solana-submit"), "index should expose guarded Solana submit toggle");
  assert(html.includes("attest-result-hash"), "index should expose Solana attest result hash");
  assert(html.includes("feed-import"), "index should expose feed JSON import");
  assert(html.includes("feed-files"), "index should expose feed file import");
  assert(html.includes("verifier-api-url"), "index should expose verifier API URL");
  assert(html.includes("verifier-api-token"), "index should expose verifier API token");
  const app = read(path.join(WEB_DIR, "app.js"));
  assert(app.includes("worker-output"), "app should expose worker output capture");
  assert(app.includes("submission-json"), "app should expose submission proof JSON");
  assert(app.includes("Submit to Verifier"), "app should expose verifier submission action");
  assert(app.includes("verifierIngestions"), "app should persist verifier ingestion output");
  assert(app.includes("authorization = `Bearer ${token}`"), "app should send verifier bearer auth when configured");
  assert(app.includes("JSON.stringify({ submission })"), "app should submit captured worker proof JSON");
  assert(app.includes("loadLocalBetaConfig"), "app should load local beta verifier config when served");
  assert(app.includes("./tasc-local-config.json"), "app should look for same-origin local beta config");
  assert(app.includes("tasc.private_beta.local_config"), "app should require local beta config kind");
  assert(app.includes("source: \"local-beta\""), "app should tag auto-filled local beta verifier config");

  for (const file of ["app.js", "demo-index.js", "tasc-web-core.js"]) {
    const source = read(path.join(WEB_DIR, file));
    assert(!/from\s+["']/.test(source), `${file} should not use module imports`);
    assert(!/require\s*\(/.test(source), `${file} should not require packages in browser runtime`);
  }
}

function assertBundledSolanaIndexMatchesFixture() {
  const expected = loadJson(SOLANA_INDEX);
  assert(demoIndex.kind === expected.kind, "bundled Solana index kind mismatch");
  assert(Array.isArray(demoIndex.entries), "bundled Solana index entries must be an array");
  assert(demoIndex.entries.length === expected.entries.length, "bundled Solana index entry count mismatch");
  const actualEntry = demoIndex.entries[0];
  const expectedEntry = expected.entries[0];
  for (const field of ["status", "intent_hash", "task_hash", "task_name", "input_hash", "buyer", "token_mint", "amount", "deadline_unix", "verifier"]) {
    assert(actualEntry[field] === expectedEntry[field], `bundled Solana ${field} mismatch`);
  }
  assert(actualEntry.inputs.url === expectedEntry.inputs.url, "bundled Solana input URL mismatch");
  assert(actualEntry.task.outputs[0].name === "markdown", "bundled Solana output metadata mismatch");
  assert(actualEntry.settlement.vault === expectedEntry.settlement.vault, "bundled Solana vault mismatch");
  assert(actualEntry.funding.signature === expectedEntry.funding.signature, "bundled Solana funding signature mismatch");
  assert(actualEntry.funding.custody.amount === expectedEntry.funding.custody.amount, "bundled Solana custody amount mismatch");
}

function assertSolanaTaskAccountDecode() {
  const fixture = loadJson(SOLANA_LIFECYCLE_ACCOUNT);
  const decoded = core.decodeSolanaTaskAccountBase64(fixture.data_base64, {
    programId: fixture.owner,
    taskPda: fixture.pubkey,
  });
  for (const field of [
    "status",
    "task_hash",
    "buyer",
    "worker",
    "verifier",
    "token_mint",
    "vault",
    "amount",
    "deadline_unix",
    "nonce",
    "result_hash",
    "created_slot",
    "updated_slot",
  ]) {
    assert(decoded[field] === fixture.decoded[field], `Solana task account ${field} mismatch`);
  }
  assert(core.solanaNextAction(demoIndex.entries[0], decoded, fixture.decoded.worker).action === "complete", "released task should be complete");
}

function assertFeedImportPayloads() {
  const claimableIndex = loadJson(SOLANA_INDEX);
  const completedIndex = loadJson(SOLANA_RELEASE_INDEX);
  const fromIndex = core.indexEntriesFromImportPayload(claimableIndex);
  assert(fromIndex.entries.length === 1, "index import entry count mismatch");
  assert(fromIndex.entries[0].task_hash === claimableIndex.entries[0].task_hash, "index import task hash mismatch");
  assert(fromIndex.entries[0].inputs.url === claimableIndex.entries[0].inputs.url, "index import input URL mismatch");
  assert(fromIndex.entries[0].input_hash === claimableIndex.entries[0].input_hash, "index import input hash mismatch");

  const fromArray = core.indexEntriesFromImportPayload([claimableIndex.entries[0]]);
  assert(fromArray.entries.length === 1, "array import entry count mismatch");
  assert(fromArray.entries[0].settlement.task_pda === claimableIndex.entries[0].settlement.task_pda, "array import task account mismatch");
  assert(fromArray.entries[0].task_name === "summarize_url_spl", "array import task name mismatch");

  const merged = core.mergeIndexEntries(claimableIndex.entries, completedIndex.entries);
  assert(merged.length === 1, "completed merge should replace claimable entry for same task");
  assert(merged[0].status === "completed", "completed merge precedence mismatch");
  assert(core.solanaNextAction(merged[0], null, "").action === "complete", "completed import should render complete action");

  const proofSummary = {
    kind: "tasc.solana-devnet.proof",
    branches: {
      release: {
        claimable_index_file: SOLANA_INDEX,
        completed_index_file: SOLANA_RELEASE_INDEX,
      },
    },
  };
  const fromProof = core.indexEntriesFromImportPayload(proofSummary);
  assert(fromProof.entries.length === 0, "proof summary should not invent entries without referenced indexes");
  assert(fromProof.index_paths.includes(SOLANA_INDEX), "proof summary claimable index path missing");
  assert(fromProof.index_paths.includes(SOLANA_RELEASE_INDEX), "proof summary completed index path missing");

  let rejected = false;
  try {
    core.indexEntriesFromImportPayload({ ok: true });
  } catch {
    rejected = true;
  }
  assert(rejected, "invalid feed import should be rejected");
}

async function assertWorkerSubmissionCapture() {
  const entry = demoIndex.entries[0];
  const markdown = read(SUBMISSION);
  const submission = await core.buildWorkerSubmission({
    entry,
    markdown,
    workerAddress: "BfRmLmH7ksPRCRxNBi7c8SspN7zKoyuAPKrJMDL5uQCJ",
    submittedAt: "2026-01-01T00:00:00.000Z",
  });
  assert(submission.kind === "tasc.worker.submission", "worker submission kind mismatch");
  assert(submission.task_hash === entry.task_hash, "worker submission task hash mismatch");
  assert(submission.input_hash === entry.input_hash, "worker submission input hash mismatch");
  assert(submission.result_hash === EXPECTED_SUBMISSION_HASH, "worker submission result hash mismatch");
  assert(submission.result_hash_bytes32 === `0x${EXPECTED_SUBMISSION_HASH.slice("sha256:".length)}`, "worker submission bytes32 hash mismatch");
  assert(submission.output.markdown === markdown, "worker submission markdown mismatch");
  assert(submission.checks.some((check) => check.rule.op === "min_words" && check.pass === true), "worker submission min_words preview mismatch");
  assert(submission.checks.some((check) => check.rule.op === "contains_citation" && check.pass === true), "worker submission citation preview mismatch");
  assert(submission.checks.some((check) => check.rule.op === "no_duplicate" && check.pass === null), "worker submission duplicate check should require verifier");
  assert(submission.local_verdict === "needs_verifier", "worker submission local verdict mismatch");
  assert(/^sha256:[a-f0-9]{64}$/.test(`sha256:${await core.sha256HexFromText(core.canonicalize(submission))}`), "submission canonical message hash mismatch");

  let rejected = false;
  try {
    await core.buildWorkerSubmission({ entry, markdown: "" });
  } catch {
    rejected = true;
  }
  assert(rejected, "empty worker submission should be rejected");
}

function assertVerifierApiBrowserFlowSurface() {
  const app = read(path.join(WEB_DIR, "app.js"));
  assert(app.includes("normalizeVerifierIngestion"), "app should normalize verifier ingestion responses");
  assert(app.includes("tasc.verifier.ingestion"), "app should require verifier ingestion kind");
  assert(app.includes("attestResultHash: attest.result_hash_bytes32"), "app should fill Solana attest hash from verifier");
  assert(app.includes("attestVerdict: attest.verdict"), "app should fill Solana attest verdict from verifier");
  assert(app.includes("Verifier accepted"), "app should show accepted verifier status");
  assert(app.includes("Verifier rejected"), "app should show rejected verifier status");
}

function entryFromFunding(funding) {
  return {
    kind: "tasc.index.entry",
    version: "0.1",
    status: "claimable",
    task_hash: funding.task_hash,
    settlement: {
      chain: "solana",
      cluster: funding.cluster,
      program_id: funding.program_id,
      task_pda: funding.task_pda,
      vault: funding.vault,
    },
    buyer: funding.buyer,
    token_mint: funding.token_mint,
    amount: funding.amount,
    deadline_unix: funding.deadline_unix,
    verifier: funding.verifier,
    nonce: funding.nonce || "1",
    funding,
  };
}

function assertPayload(payload, expected) {
  assert(payload.ok === true, `${expected.action} payload should be ok`);
  assert(payload.action === expected.action, `${expected.action} action mismatch`);
  assert(payload.signer_role === expected.signerRole, `${expected.action} signer role mismatch`);
  assert(payload.instruction_data_hex === expected.dataHex, `${expected.action} instruction data mismatch`);
  assert(payload.accounts.length === expected.accountCount, `${expected.action} account count mismatch`);
  assert(Array.isArray(payload.message_bytes) && payload.message_bytes.length > 0, `${expected.action} message missing`);
  assert(payload.unsigned_transaction_bytes.length === payload.message_bytes.length + 65, `${expected.action} unsigned transaction size mismatch`);
  assert(payload.unsigned_transaction_base64 === core.base64FromBytes(payload.unsigned_transaction_bytes), `${expected.action} transaction base64 mismatch`);
  const walletTx = core.createSolanaWalletTransaction(payload);
  const unsigned = Array.from(walletTx.serialize({ requireAllSignatures: false }));
  assert(unsigned.length === payload.unsigned_transaction_bytes.length, `${expected.action} unsigned wallet serialization mismatch`);
  walletTx.addSignature(null, new Uint8Array(64).fill(7));
  const signed = Array.from(walletTx.serialize());
  assert(signed.length === payload.unsigned_transaction_bytes.length, `${expected.action} signed wallet serialization mismatch`);
  assert(signed[1] === 7, `${expected.action} signed transaction signature mismatch`);
}

async function assertWalletSubmissionAdapter(payload) {
  let signAndSendSawPayload = false;
  const signAndSend = await core.submitSolanaWalletTransaction({
    payload,
    provider: {
      async signAndSendTransaction(transaction) {
        signAndSendSawPayload = transaction._tasc.action === payload.action;
        assert(Array.from(transaction.serializeMessage()).join(",") === payload.message_bytes.join(","), "signAndSend message bytes mismatch");
        return { signature: "mockSignAndSendSignature111111111111111111111111111111111" };
      },
    },
  });
  assert(signAndSendSawPayload, "signAndSend provider did not receive wallet payload");
  assert(signAndSend.transport === "wallet.signAndSendTransaction", "signAndSend transport mismatch");
  assert(signAndSend.signature.startsWith("mockSignAndSend"), "signAndSend signature mismatch");

  let rpcRawBase64 = "";
  let rpcOptions = null;
  const fallback = await core.submitSolanaWalletTransaction({
    payload,
    provider: {
      async signTransaction(transaction) {
        transaction.addSignature(null, new Uint8Array(64).fill(9));
        return transaction;
      },
    },
    rpcSendTransaction: async (rawBase64, options) => {
      rpcRawBase64 = rawBase64;
      rpcOptions = options;
      return "mockRpcSignature1111111111111111111111111111111111111111";
    },
  });
  assert(fallback.transport === "wallet.signTransaction+rpc.sendTransaction", "fallback transport mismatch");
  assert(fallback.signature.startsWith("mockRpcSignature"), "fallback signature mismatch");
  assert(rpcRawBase64 === core.base64FromBytes(core.encodeSignedSolanaTransactionBytes(payload.message_bytes, new Uint8Array(64).fill(9))), "fallback signed bytes mismatch");
  assert(rpcOptions && rpcOptions.encoding === "base64", "fallback RPC encoding mismatch");
  assert(rpcOptions && rpcOptions.preflightCommitment === "confirmed", "fallback RPC commitment mismatch");

  let rejectedUnsupported = false;
  try {
    await core.submitSolanaWalletTransaction({ payload, provider: {} });
  } catch (error) {
    rejectedUnsupported = /cannot sign/i.test(error.message);
  }
  assert(rejectedUnsupported, "unsupported wallet provider should be rejected");

  let rejectedMissingSignature = false;
  try {
    await core.submitSolanaWalletTransaction({
      payload,
      provider: {
        async signAndSendTransaction() {
          return {};
        },
      },
    });
  } catch (error) {
    rejectedMissingSignature = /signature/i.test(error.message);
  }
  assert(rejectedMissingSignature, "missing wallet signature should be rejected");

  let rejectedMissingRpc = false;
  try {
    await core.submitSolanaWalletTransaction({
      payload,
      provider: {
        async signTransaction(transaction) {
          transaction.addSignature(null, new Uint8Array(64).fill(1));
          return transaction;
        },
      },
    });
  } catch (error) {
    rejectedMissingRpc = /sendTransaction callback/i.test(error.message);
  }
  assert(rejectedMissingRpc, "fallback wallet path should require RPC send callback");
}

async function assertSolanaLifecycleTransactionBuilds() {
  const fixture = loadJson(SOLANA_LIFECYCLE_ACCOUNT);
  const releasePlan = loadJson(SOLANA_RELEASE_PLAN);
  const entry = demoIndex.entries[0];
  const decoded = core.decodeSolanaTaskAccountBase64(fixture.data_base64, {
    programId: fixture.owner,
    taskPda: fixture.pubkey,
  });
  const worker = fixture.decoded.worker;
  const buyer = fixture.decoded.buyer;
  const verifier = fixture.decoded.verifier;
  const resultHash = fixture.decoded.result_hash;

  const claim = await core.buildSolanaLifecycleTransaction({
    entry,
    account: { ...decoded, status: "Funded", worker: core.ZERO_SOLANA_PUBKEY },
    action: "claim",
    walletAddress: worker,
    recentBlockhash: DUMMY_BLOCKHASH,
    resultHash,
  });
  assertPayload(claim, { action: "claim", signerRole: "worker", dataHex: "0x01", accountCount: 3 });
  assert(claim.accounts[2].pubkey === core.CLOCK_SYSVAR_ID, "claim clock sysvar mismatch");

  const attest = await core.buildSolanaLifecycleTransaction({
    entry,
    account: { ...decoded, status: "Claimed" },
    action: "attest",
    walletAddress: verifier,
    recentBlockhash: DUMMY_BLOCKHASH,
    verdict: "pass",
    resultHash,
  });
  assertPayload(attest, { action: "attest", signerRole: "verifier", dataHex: `0x0201${resultHash.slice(2)}`, accountCount: 2 });

  const release = await core.buildSolanaLifecycleTransaction({
    entry,
    account: { ...decoded, status: "Passed" },
    action: "release",
    walletAddress: worker,
    recentBlockhash: DUMMY_BLOCKHASH,
    resultHash,
  });
  assertPayload(release, { action: "release", signerRole: "worker", dataHex: "0x03", accountCount: 7 });
  assert(release.settlement.vault_authority === releasePlan.vault_authority, "release vault authority mismatch");
  assert(release.settlement.destination_token_account === releasePlan.destination_token_account, "release destination token account mismatch");
  assert(release.settlement.token_program_id === core.TOKEN_PROGRAM_ID, "release token program mismatch");
  await assertWalletSubmissionAdapter(release);

  const refund = await core.buildSolanaLifecycleTransaction({
    entry,
    account: { ...decoded, status: "Failed" },
    action: "refund",
    walletAddress: buyer,
    recentBlockhash: DUMMY_BLOCKHASH,
    resultHash,
  });
  assertPayload(refund, { action: "refund", signerRole: "buyer", dataHex: "0x04", accountCount: 7 });
  assert(refund.settlement.destination_role === "buyer", "refund destination role mismatch");

  const timeoutFunding = loadJson(SOLANA_TIMEOUT_FUNDING);
  const timeoutAccountFixture = loadJson(SOLANA_TIMEOUT_ACCOUNT);
  const timeoutPlan = loadJson(SOLANA_TIMEOUT_PLAN);
  const timeoutEntry = entryFromFunding(timeoutFunding);
  const timeoutAccount = core.decodeSolanaTaskAccountBase64(timeoutAccountFixture.data_base64, {
    programId: timeoutAccountFixture.owner,
    taskPda: timeoutAccountFixture.pubkey,
  });
  const timeoutRefund = await core.buildSolanaLifecycleTransaction({
    entry: timeoutEntry,
    account: timeoutAccount,
    action: "timeout refund",
    walletAddress: timeoutAccount.buyer,
    recentBlockhash: DUMMY_BLOCKHASH,
    resultHash: timeoutAccount.result_hash,
  });
  assertPayload(timeoutRefund, { action: "timeout-refund", signerRole: "buyer", dataHex: "0x04", accountCount: 8 });
  assert(timeoutRefund.accounts[7].pubkey === core.CLOCK_SYSVAR_ID, "timeout refund clock sysvar mismatch");
  assert(timeoutRefund.settlement.vault_authority === timeoutPlan.vault_authority, "timeout vault authority mismatch");
  assert(timeoutRefund.settlement.destination_token_account === timeoutPlan.destination_token_account, "timeout destination token account mismatch");
}

function assertDecodeMatchesFundingFixture() {
  const log = loadJson(LOG);
  const expected = loadJson(FUNDING);
  const decoded = core.decodeFundedLog(log, {
    chainId: log.chain_id,
    confirmations: log.confirmations,
  });

  for (const field of [
    "kind",
    "version",
    "chain_id",
    "task_hash",
    "escrow",
    "buyer",
    "token",
    "amount",
    "deadline",
    "status",
    "tx_hash",
    "block_number",
    "log_index",
    "confirmations",
  ]) {
    assert(decoded[field] === expected[field], `decoded ${field} mismatch`);
  }
}

function assertFilterAndHandoff() {
  const handoff = loadJson(HANDOFF);
  const derived = core.deriveConfigFromHandoff(handoff);
  assert(derived.chainId === "84532", "handoff chain id mismatch");
  assert(derived.escrow === handoff.contracts.escrow.toLowerCase(), "handoff escrow mismatch");
  assert(derived.startBlock === String(handoff.funding_event.block_number), "handoff start block mismatch");
  assert(derived.confirmations === String(handoff.funding_event.confirmations_required), "handoff confirmations mismatch");

  const filter = core.buildFundedFilter({
    escrow: derived.escrow,
    fromBlock: Number(derived.startBlock),
    toBlock: Number(derived.startBlock),
  });
  assert(filter.address === derived.escrow, "filter escrow mismatch");
  assert(filter.topics[0] === core.FUNDED_TOPIC, "filter topic mismatch");
  assert(filter.fromBlock === "0x1e240", "filter from block mismatch");
  assert(filter.toBlock === "0x1e240", "filter to block mismatch");
}

async function main() {
  assertNoExternalRuntimeDependencies();
  assertDecodeMatchesFundingFixture();
  assertFilterAndHandoff();
  assertBundledSolanaIndexMatchesFixture();
  assertSolanaTaskAccountDecode();
  assertFeedImportPayloads();
  await assertWorkerSubmissionCapture();
  assertVerifierApiBrowserFlowSurface();
  await assertSolanaLifecycleTransactionBuilds();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    web: WEB_DIR,
    decoded_fixture: LOG,
    handoff_fixture: HANDOFF,
    bundled_solana_index: SOLANA_INDEX,
    solana_task_account_fixture: SOLANA_LIFECYCLE_ACCOUNT,
    feed_import_shapes: ["tasc.index", "tasc.index.entry[]", "tasc.solana-devnet.proof"],
    worker_submission_capture: "tasc.worker.submission",
    verifier_api_browser_flow: "tasc.verifier.ingestion",
    local_beta_config: "tasc.private_beta.local_config",
    solana_wallet_submission_adapter: ["signAndSendTransaction", "signTransaction+rpc.sendTransaction"],
    solana_wallet_transaction_builds: ["claim", "attest", "release", "refund", "timeout-refund"],
    external_runtime_dependencies: 0,
    next: "Open web/index.html or deploy web/ as static files.",
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`validate-web: ${error.message}`);
    process.exit(1);
  });
}
