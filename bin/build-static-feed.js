#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT_DIR = "web/feed";
const DEFAULT_PUBLIC_PREFIX = "feed";
const DEFAULT_GENERATED_AT = "1970-01-01T00:00:00.000Z";
const DEFAULT_BRANCHES = {
  release: {
    claimable: "examples/index/solana.spl.live.index.json",
    completed: "examples/index/solana.spl.release.index.json",
  },
  refund: {
    claimable: "examples/index/solana.spl.refund-job.claimable.index.json",
    completed: "examples/index/solana.spl.refund.index.json",
  },
  timeout: {
    claimable: "examples/index/solana.spl.timeout-job.claimable.index.json",
    completed: "examples/index/solana.spl.timeout-refund.index.json",
  },
};
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

function usage() {
  console.error([
    "Usage:",
    "  node bin/build-static-feed.js [options]",
    "",
    "Options:",
    "  --out-dir <dir>             output directory; default web/feed",
    "  --public-prefix <path>      path used inside proof summary; default feed",
    "  --mode <proof|claimable>    proof includes claimable+completed, claimable includes only claimable indexes",
    "  --proof-summary <json>      build from a fresh tasc.solana-devnet.proof summary",
    "  --generated-at <iso>        deterministic timestamp; default 1970-01-01T00:00:00.000Z",
    "  --help                      show this help",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveInsideRoot(file, label) {
  const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(ROOT, file);
  assert(resolved === ROOT || resolved.startsWith(`${ROOT}${path.sep}`), `${label} must stay inside repo root`);
  return resolved;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(argv) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    publicPrefix: DEFAULT_PUBLIC_PREFIX,
    mode: "proof",
    proofSummary: "",
    generatedAt: DEFAULT_GENERATED_AT,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    else if (arg === "--out-dir") {
      options.outDir = argv[++i] || "";
      if (!options.outDir) usage();
    } else if (arg === "--public-prefix") {
      options.publicPrefix = argv[++i] || "";
      if (!options.publicPrefix) usage();
    } else if (arg === "--mode") {
      options.mode = argv[++i] || "";
      if (options.mode !== "proof" && options.mode !== "claimable") usage();
    } else if (arg === "--proof-summary") {
      options.proofSummary = argv[++i] || "";
      if (!options.proofSummary) usage();
    } else if (arg === "--generated-at") {
      options.generatedAt = argv[++i] || "";
      if (!Number.isFinite(Date.parse(options.generatedAt))) usage();
    } else {
      usage();
    }
  }

  return options;
}

function publicPath(prefix, name) {
  return `${String(prefix || "").replace(/^\/+|\/+$/g, "")}/${name}`.replace(/^\/+/, "");
}

function assertSafePublicName(value, label) {
  assert(/^[a-z0-9][a-z0-9._/-]*$/i.test(value), `${label} contains unsupported characters`);
  assert(!value.includes(".."), `${label} must not contain parent traversal`);
}

function assertNoSecrets(text, label) {
  for (const pattern of SECRET_PATTERNS) {
    assert(!pattern.test(text), `${label} contains a secret-looking field`);
  }
}

function assertIndexPayload(index, label) {
  assert(index && typeof index === "object", `${label} must be a JSON object`);
  assert(index.kind === "tasc.index", `${label} kind must be tasc.index`);
  assert(index.version === "0.1", `${label} version mismatch`);
  assert(Array.isArray(index.entries), `${label} entries must be an array`);
  assert(index.entries.length > 0, `${label} must contain at least one entry`);
  index.entries.forEach((entry, indexNumber) => {
    assert(entry && typeof entry === "object", `${label}.entries[${indexNumber}] must be an object`);
    assert(entry.kind === "tasc.index.entry", `${label}.entries[${indexNumber}] kind mismatch`);
    assert(entry.task_hash, `${label}.entries[${indexNumber}] missing task_hash`);
    assert(entry.status === "claimable" || entry.status === "completed", `${label}.entries[${indexNumber}] status must be claimable or completed`);
    assert(entry.settlement && entry.settlement.chain === "solana", `${label}.entries[${indexNumber}] must be Solana settlement`);
  });
}

function loadSafeIndex(file, label) {
  const bytes = fs.readFileSync(file);
  const text = bytes.toString("utf8");
  assertNoSecrets(text, label);
  const json = JSON.parse(text);
  assertIndexPayload(json, label);
  return { json, text, bytes };
}

function resolveProofPath(rawPath, summaryFile) {
  const asRootPath = resolveInsideRoot(rawPath, "proof summary path");
  if (fs.existsSync(asRootPath)) return asRootPath;
  const relativeToSummary = path.resolve(path.dirname(summaryFile), rawPath);
  assert(relativeToSummary.startsWith(`${ROOT}${path.sep}`), "proof summary path must stay inside repo root");
  assert(fs.existsSync(relativeToSummary), `proof summary referenced file missing: ${rawPath}`);
  return relativeToSummary;
}

function defaultBranchSpec() {
  return Object.fromEntries(Object.entries(DEFAULT_BRANCHES).map(([name, value]) => ([
    name,
    {
      claimable: resolveInsideRoot(value.claimable, `${name} claimable index`),
      completed: resolveInsideRoot(value.completed, `${name} completed index`),
    },
  ])));
}

function branchSpecFromProofSummary(proofSummaryFile) {
  const resolved = resolveInsideRoot(proofSummaryFile, "proof summary");
  const proof = readJson(resolved);
  assert(proof && proof.kind === "tasc.solana-devnet.proof", "proof summary kind mismatch");
  assert(proof.branches && typeof proof.branches === "object", "proof summary branches missing");
  const branchSpec = {};
  for (const [name, branch] of Object.entries(proof.branches)) {
    assertSafePublicName(name, "branch name");
    if (!branch || typeof branch !== "object") continue;
    const spec = {};
    if (branch.claimable_index_file) spec.claimable = resolveProofPath(String(branch.claimable_index_file), resolved);
    if (branch.completed_index_file) spec.completed = resolveProofPath(String(branch.completed_index_file), resolved);
    if (spec.claimable || spec.completed) branchSpec[name] = spec;
  }
  assert(Object.keys(branchSpec).length > 0, "proof summary did not reference any index files");
  return branchSpec;
}

function filesForMode(branchSpec, mode) {
  const files = [];
  for (const [branch, spec] of Object.entries(branchSpec)) {
    assertSafePublicName(branch, "branch name");
    if (spec.claimable) files.push({ branch, role: "claimable", source: spec.claimable });
    if (mode === "proof" && spec.completed) files.push({ branch, role: "completed", source: spec.completed });
  }
  assert(files.length > 0, "no index files selected for static feed");
  return files;
}

function buildStaticFeed(rawOptions = {}) {
  const options = {
    outDir: rawOptions.outDir || DEFAULT_OUT_DIR,
    publicPrefix: rawOptions.publicPrefix || DEFAULT_PUBLIC_PREFIX,
    mode: rawOptions.mode || "proof",
    proofSummary: rawOptions.proofSummary || "",
    generatedAt: rawOptions.generatedAt || DEFAULT_GENERATED_AT,
  };
  assert(options.mode === "proof" || options.mode === "claimable", "mode must be proof or claimable");
  assert(Number.isFinite(Date.parse(options.generatedAt)), "generatedAt must be an ISO timestamp");
  assertSafePublicName(options.publicPrefix, "public prefix");

  const outDir = resolveInsideRoot(options.outDir, "out dir");
  const branchSpec = options.proofSummary ? branchSpecFromProofSummary(options.proofSummary) : defaultBranchSpec();
  const selected = filesForMode(branchSpec, options.mode);
  const branches = {};
  const fileRecords = [];

  for (const file of selected) {
    const source = loadSafeIndex(file.source, `${file.branch}.${file.role}`);
    const outputName = `${file.branch}.${file.role}.index.json`;
    assertSafePublicName(outputName, "output index name");
    const outputFile = path.join(outDir, outputName);
    writeJson(outputFile, source.json);
    const outputBytes = fs.readFileSync(outputFile);
    const outputPath = publicPath(options.publicPrefix, outputName);
    branches[file.branch] = branches[file.branch] || {};
    branches[file.branch][`${file.role}_index_file`] = outputPath;
    fileRecords.push({
      branch: file.branch,
      role: file.role,
      source: path.relative(ROOT, file.source),
      path: outputPath,
      sha256: sha256Hex(outputBytes),
      bytes: outputBytes.length,
      entries: source.json.entries.length,
      statuses: Array.from(new Set(source.json.entries.map((entry) => entry.status))).sort(),
    });
  }

  const summaryName = options.mode === "claimable" ? "claimable-feed.json" : "proof-feed.json";
  const summary = {
    ok: true,
    kind: "tasc.solana-devnet.proof",
    version: "0.1",
    mode: options.mode === "claimable" ? "static-claimable-feed" : "static-proof-feed",
    generated_at: options.generatedAt,
    generated_by: "bin/build-static-feed.js",
    static_feed: {
      public_prefix: options.publicPrefix,
      files: fileRecords,
      no_secrets: true,
      no_new_dependencies: true,
    },
    branches,
  };
  const summaryFile = path.join(outDir, summaryName);
  writeJson(summaryFile, summary);

  return {
    ok: true,
    kind: "tasc.static_feed.build",
    mode: options.mode,
    out_dir: path.relative(ROOT, outDir),
    summary_file: path.relative(ROOT, summaryFile),
    branch_count: Object.keys(branches).length,
    file_count: fileRecords.length,
    entry_count: fileRecords.reduce((total, file) => total + file.entries, 0),
    summary_sha256: sha256Hex(fs.readFileSync(summaryFile)),
    no_new_dependencies: true,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(buildStaticFeed(options), null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`build-static-feed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildStaticFeed,
  parseArgs,
};
