#!/usr/bin/env node

const fs = require("fs");
const crypto = require("crypto");
const { compile } = require("./tasclang");

function usage() {
  console.error("Usage: node bin/tascverify.js <file.tasc> <submission.md> --input name=value [--ledger ledger.json]");
  process.exit(1);
}

function parseArgs(argv) {
  const [taskFile, submissionFile, ...rest] = argv;
  if (!taskFile || !submissionFile) usage();

  const inputs = {};
  let ledgerFile = null;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--input") {
      const pair = rest[i + 1];
      if (!pair || !pair.includes("=")) usage();
      const eq = pair.indexOf("=");
      inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
      i += 1;
    } else if (arg === "--ledger") {
      ledgerFile = rest[i + 1];
      if (!ledgerFile) usage();
      i += 1;
    } else {
      usage();
    }
  }

  return { taskFile, submissionFile, inputs, ledgerFile };
}

function wordCount(text) {
  const words = text.trim().match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g);
  return words ? words.length : 0;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function readLedger(file) {
  if (!file) return [];
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed.result_hashes)) {
    throw new Error("Ledger must be JSON with a result_hashes array");
  }
  return parsed.result_hashes;
}

function resolveRef(ref, inputs) {
  if (ref.startsWith("input.")) {
    const name = ref.slice("input.".length);
    if (!(name in inputs)) throw new Error(`Missing input '${name}'`);
    return inputs[name];
  }
  return ref;
}

function evaluateRule(rule, context) {
  if (rule.op === "min_words") {
    const required = Number(rule.args[0]);
    const actual = wordCount(context.submission);
    return {
      rule,
      pass: actual >= required,
      actual,
      expected: `>= ${required}`,
    };
  }

  if (rule.op === "contains_citation") {
    const required = resolveRef(rule.args[0], context.inputs);
    const pass = context.submission.includes(required);
    return {
      rule,
      pass,
      actual: pass ? "found" : "missing",
      expected: required,
    };
  }

  if (rule.op === "no_duplicate") {
    const pass = !context.ledger.includes(context.resultHash);
    return {
      rule,
      pass,
      actual: pass ? "unique" : "duplicate",
      expected: "unique result hash",
    };
  }

  return {
    rule,
    pass: false,
    actual: "unsupported",
    expected: "supported verifier operation",
  };
}

function verifyCompiledTask(compiled, submission, inputs, ledgerFile) {
  const resultHash = `sha256:${sha256(submission)}`;
  const ledger = readLedger(ledgerFile);
  const checks = compiled.task.verify.map((rule) => evaluateRule(rule, {
    inputs,
    submission,
    resultHash,
    ledger,
  }));

  const verdict = checks.every((check) => check.pass) ? "pass" : "fail";
  return {
    kind: "tasc.attestation",
    version: "0.1",
    task_hash: compiled.task_hash,
    result_hash: resultHash,
    verifier: "local.deterministic",
    verdict,
    checks,
  };
}

function main() {
  const { taskFile, submissionFile, inputs, ledgerFile } = parseArgs(process.argv.slice(2));
  const taskSource = fs.readFileSync(taskFile, "utf8");
  const submission = fs.readFileSync(submissionFile, "utf8");
  const compiled = compile(taskSource);
  const attestation = verifyCompiledTask(compiled, submission, inputs, ledgerFile);

  process.stdout.write(`${JSON.stringify(attestation, null, 2)}\n`);
  if (attestation.verdict !== "pass") process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`tascverify: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  readLedger,
  verifyCompiledTask,
};
