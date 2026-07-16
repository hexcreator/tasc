#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { startPrivateBetaSession } = require("./run-private-beta-local");

const WORKER_SUBMISSION = "examples/submissions/summarize_url_spl.worker-submission.json";
const EXPECTED_RESULT_HASH = "sha256:0bdfacb7e0ec2c3241da82c7b812b1a0fa28945b47c7f8a6b113b4de3779776f";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  let body = null;
  try {
    body = await response.json();
  } catch (_error) {
    body = null;
  }
  return { response, body };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tasc-private-beta-"));
  const ledgerOut = path.join(tempDir, "ledger.json");
  const artifactDir = path.join(tempDir, "artifacts");
  const token = "validate-private-beta-token";
  const session = await startPrivateBetaSession({
    webPort: 0,
    verifierPort: 0,
    token,
    ledgerOut,
    artifactDir,
  });

  try {
    const appUrl = session.summary.app_url;
    const verifierUrl = session.summary.verifier_api_url;

    const app = await fetch(appUrl);
    assert(app.status === 200, "static app should be served");
    const html = await app.text();
    assert(html.includes("Tasc Claimable Feed"), "static app HTML mismatch");
    assert(html.includes("verifier-api-url"), "static app should expose verifier API controls");

    const appJs = await fetch(`${appUrl.replace(/\/web\/index\.html$/, "")}/web/app.js`);
    assert(appJs.status === 200, "static server should serve app.js");
    const appSource = await appJs.text();
    assert(appSource.includes("loadLocalBetaConfig"), "static app should load local beta config");
    assert(appSource.includes("./tasc-local-config.json"), "static app local config path mismatch");
    assert(appSource.includes("tasc.private_beta.local_config"), "static app local config kind mismatch");

    const localConfig = await requestJson(`${appUrl.replace(/\/web\/index\.html$/, "")}/web/tasc-local-config.json`);
    assert(localConfig.response.status === 200, "local beta config should be served");
    assert(localConfig.body && localConfig.body.kind === "tasc.private_beta.local_config", "local beta config kind mismatch");
    assert(localConfig.body.verifier.apiUrl === verifierUrl, "local beta config verifier URL mismatch");
    assert(localConfig.body.verifier.token === token, "local beta config token mismatch");

    const fixture = await fetch(`${appUrl.replace(/\/web\/index\.html$/, "")}/${WORKER_SUBMISSION}`);
    assert(fixture.status === 200, "static server should serve bundled worker submission fixture");

    const forbidden = await fetch(`${appUrl.replace(/\/web\/index\.html$/, "")}/package.json`);
    assert(forbidden.status === 404, "static server should not expose package.json");

    const health = await requestJson(`${verifierUrl}/health`);
    assert(health.response.status === 200, "verifier health should be reachable");
    assert(health.body && health.body.auth_required === true, "verifier health auth flag mismatch");

    const unauthorized = await requestJson(`${verifierUrl}/v1/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ submission: loadJson(WORKER_SUBMISSION) }),
    });
    assert(unauthorized.response.status === 401, "verifier should reject missing bearer token");

    const accepted = await requestJson(`${verifierUrl}/v1/ingest`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ submission: loadJson(WORKER_SUBMISSION) }),
    });
    assert(accepted.response.status === 200, "verifier should accept worker proof");
    assert(accepted.body && accepted.body.kind === "tasc.verifier.ingestion", "accepted body kind mismatch");
    assert(accepted.body.accepted === true, "accepted body should mark proof accepted");
    assert(accepted.body.attestation.result_hash === EXPECTED_RESULT_HASH, "accepted result hash mismatch");
    assert(accepted.body.artifact && fs.existsSync(accepted.body.artifact.path), "accepted artifact should be written");
    assert(fs.existsSync(ledgerOut), "persistent verifier ledger should be written");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      launcher: "bin/run-private-beta-local.js",
      app_url: appUrl,
      verifier_api_url: verifierUrl,
      static_routes: ["/web/index.html", `/${WORKER_SUBMISSION}`],
      local_config: "/web/tasc-local-config.json",
      restricted_routes: ["/package.json"],
      verifier_auth: "Bearer",
      accepted_result_hash: accepted.body.attestation.result_hash,
      artifact_count: fs.readdirSync(artifactDir).filter((file) => file.endsWith(".json")).length,
      ledger_out: ledgerOut,
      no_new_dependencies: true,
    }, null, 2)}\n`);
  } finally {
    await session.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`validate-private-beta-local: ${error.message}`);
    process.exit(1);
  });
}
