#!/usr/bin/env node

const { startProductionSubmitter } = require("./run-production-submitter-local");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function text(url, options = {}) {
  const response = await fetch(url, options);
  return {
    response,
    body: await response.text(),
  };
}

async function main() {
  const session = await startProductionSubmitter({ port: 0 });
  try {
    const baseUrl = session.summary.root_url;
    const root = await fetch(baseUrl, { redirect: "manual" });
    assert(root.status === 302, "root should redirect");
    assert(root.headers.get("location") === "/web/production-run.html", "root redirect should target production runner");

    const html = await text(session.summary.production_submitter_url);
    assert(html.response.status === 200, "production-run.html should be served");
    assert(html.body.includes("Tasc Production Run"), "production-run.html content mismatch");
    assert(html.body.includes("./production-run.js"), "production runner script missing");
    assert(html.body.includes("./tasc-web-core.js"), "production core script missing");

    const js = await text(`${baseUrl}/web/production-run.js`);
    assert(js.response.status === 200, "production-run.js should be served");
    assert(js.body.includes("Enable production wallet sends first"), "production-run.js should keep send guard");
    assert(js.body.includes("Connected wallet must match artifact signer"), "production-run.js should enforce signer match");

    const core = await text(`${baseUrl}/web/tasc-web-core.js`);
    assert(core.response.status === 200, "tasc-web-core.js should be served");
    assert(core.body.includes("summarizeProductionTransactionArtifact"), "core production artifact summarizer missing");
    assert(core.body.includes("tasc.production_token_account_setup_transaction"), "core token-account setup artifact support missing");

    const cssHead = await fetch(`${baseUrl}/web/styles.css`, { method: "HEAD" });
    assert(cssHead.status === 200, "styles.css HEAD should be served");
    assert((cssHead.headers.get("content-type") || "").includes("text/css"), "styles.css content type mismatch");

    const docs = await fetch(`${baseUrl}/docs/static-web-v1.md`);
    assert(docs.status === 200, "safe docs path should be served");

    const forbidden = [
      "/package.json",
      "/package-lock.json",
      "/.env.example",
      "/.env.solana-mainnet.local",
      "/.tascverifier/production-run-packet.json",
      "/node_modules/ethers/package.json",
      "/../package.json",
    ];
    for (const route of forbidden) {
      const response = await fetch(`${baseUrl}${route}`);
      assert(response.status === 404, `${route} should not be served`);
    }

    const methodRejected = await fetch(session.summary.production_submitter_url, { method: "POST" });
    assert(methodRejected.status === 405, "POST should be rejected");

    process.stdout.write(`${JSON.stringify({
      ok: true,
      launcher: "bin/run-production-submitter-local.js",
      production_submitter_url: session.summary.production_submitter_url,
      safe_routes: [
        "/web/production-run.html",
        "/web/production-run.js",
        "/web/tasc-web-core.js",
        "/web/styles.css",
        "/docs/static-web-v1.md",
      ],
      restricted_routes: forbidden,
      sends_transactions: false,
      accepts_private_keys: false,
      calls_rpc: false,
      reads_env_files: false,
      no_new_dependencies: true,
    }, null, 2)}\n`);
  } finally {
    await session.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`validate-production-submitter-local: ${error.message}`);
    process.exit(1);
  });
}
