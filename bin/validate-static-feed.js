#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const core = require("../web/tasc-web-core");

const ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(ROOT, "web");
const FEED_SUMMARY = path.join(WEB_DIR, "feed", "proof-feed.json");
const SECRET_PATTERNS = [
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /private[_-]?key/i,
  /\bsecret\b/i,
  /mnemonic/i,
  /seed phrase/i,
  /xprv/i,
  /api[_-]?key/i,
  /rpc_url/i,
  /env_file/i,
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertNoSecrets(file) {
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of SECRET_PATTERNS) {
    assert(!pattern.test(text), `${path.relative(ROOT, file)} contains a secret-looking field`);
  }
}

function resolveWebPath(publicPath) {
  assert(typeof publicPath === "string" && publicPath.length > 0, "feed path is required");
  assert(!publicPath.includes(".."), `feed path must not contain parent traversal: ${publicPath}`);
  const resolved = path.resolve(WEB_DIR, publicPath);
  assert(resolved.startsWith(`${WEB_DIR}${path.sep}`), `feed path must stay inside web/: ${publicPath}`);
  return resolved;
}

function entriesFromHostedPayload(payload, seen = new Set()) {
  const parsed = core.indexEntriesFromImportPayload(payload);
  let entries = parsed.entries;
  for (const publicPath of parsed.index_paths) {
    const file = resolveWebPath(publicPath);
    assert(fs.existsSync(file), `referenced feed file missing: ${publicPath}`);
    assert(!seen.has(file), `feed path recursion detected: ${publicPath}`);
    seen.add(file);
    assertNoSecrets(file);
    const nested = entriesFromHostedPayload(readJson(file), seen);
    entries = core.mergeIndexEntries(entries, nested.entries);
  }
  return { entries, indexPaths: parsed.index_paths };
}

function main() {
  const packageJson = readJson(path.join(ROOT, "package.json"));
  const html = fs.readFileSync(path.join(WEB_DIR, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(WEB_DIR, "app.js"), "utf8");

  assert(packageJson.scripts["beta:feed"], "missing beta:feed script");
  assert(packageJson.scripts["validate:static-feed"], "missing validate:static-feed script");
  assert(html.includes("load-hosted-feed"), "static app should expose hosted feed loader");
  assert(app.includes("./feed/proof-feed.json"), "static app should know hosted feed path");
  assert(fs.existsSync(FEED_SUMMARY), "web/feed/proof-feed.json is missing");
  assertNoSecrets(FEED_SUMMARY);

  const summary = readJson(FEED_SUMMARY);
  assert(summary.kind === "tasc.solana-devnet.proof", "hosted feed summary kind mismatch");
  assert(summary.mode === "static-proof-feed", "hosted feed summary mode mismatch");
  assert(summary.static_feed && summary.static_feed.no_secrets === true, "hosted feed must declare no_secrets");
  assert(summary.static_feed.no_new_dependencies === true, "hosted feed must declare no_new_dependencies");
  assert(summary.branches && Object.keys(summary.branches).length === 3, "hosted feed should include release/refund/timeout branches");

  const imported = entriesFromHostedPayload(summary);
  assert(imported.indexPaths.length === 6, "hosted proof feed should reference six index files");
  assert(imported.entries.length === 3, "hosted proof feed should merge to three final task entries");
  assert(imported.entries.every((entry) => entry.status === "completed"), "hosted proof feed should prove completed branches");
  assert(imported.entries.some((entry) => entry.completed_status === "Released"), "hosted proof feed missing release proof");
  assert(imported.entries.filter((entry) => entry.completed_status === "Refunded").length === 2, "hosted proof feed missing refund proofs");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    hosted_feed: path.relative(ROOT, FEED_SUMMARY),
    referenced_indexes: imported.indexPaths.length,
    merged_entries: imported.entries.length,
    statuses: Array.from(new Set(imported.entries.map((entry) => entry.completed_status))).sort(),
    no_new_dependencies: true,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(`validate-static-feed: ${error.message}`);
  process.exit(1);
}
