#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { compile } = require("./tasclang");
const { verifyCompiledTask } = require("./tascverify");

const DEFAULT_STATE = ".tascmarket/market.json";

function usage() {
  console.error([
    "Usage:",
    "  node bin/tascmarket.js init [--state file] [--force]",
    "  node bin/tascmarket.js publish <file.tasc> --buyer name [--state file]",
    "  node bin/tascmarket.js claim <task_hash_prefix> --worker name [--state file]",
    "  node bin/tascmarket.js attest <task_hash_prefix> <submission.md> --input name=value [--ledger file] [--state file]",
    "  node bin/tascmarket.js release <task_hash_prefix> [--state file]",
    "  node bin/tascmarket.js list [--state file]",
    "  node bin/tascmarket.js demo <file.tasc> <submission.md> --input name=value [--buyer name] [--worker name] [--ledger file]",
  ].join("\n"));
  process.exit(1);
}

function parseOptions(args) {
  const positionals = [];
  const options = { inputs: {}, state: DEFAULT_STATE };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--input") {
      const pair = args[i + 1];
      if (!pair || !pair.includes("=")) usage();
      const eq = pair.indexOf("=");
      options.inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
      i += 1;
    } else if (arg === "--state") {
      options.state = args[i + 1];
      if (!options.state) usage();
      i += 1;
    } else if (arg === "--buyer") {
      options.buyer = args[i + 1];
      if (!options.buyer) usage();
      i += 1;
    } else if (arg === "--worker") {
      options.worker = args[i + 1];
      if (!options.worker) usage();
      i += 1;
    } else if (arg === "--ledger") {
      options.ledger = args[i + 1];
      if (!options.ledger) usage();
      i += 1;
    } else if (arg === "--force") {
      options.force = true;
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, options };
}

function now() {
  return new Date().toISOString();
}

function emptyState() {
  return { kind: "tasc.market", version: "0.1", tasks: [] };
}

function loadState(file) {
  if (!fs.existsSync(file)) return emptyState();
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

function compileFile(file) {
  return compile(fs.readFileSync(file, "utf8"));
}

function resolveTask(state, ref) {
  const matches = state.tasks.filter((task) => task.task_hash === ref || task.task_hash.includes(ref));
  if (matches.length === 0) throw new Error(`No task matches '${ref}'`);
  if (matches.length > 1) throw new Error(`Ambiguous task reference '${ref}'`);
  return matches[0];
}

function publish(state, taskFile, buyer) {
  if (!buyer) throw new Error("Missing --buyer");
  const compiled = compileFile(taskFile);
  if (state.tasks.some((task) => task.task_hash === compiled.task_hash)) {
    throw new Error(`Task already published: ${compiled.task_hash}`);
  }
  const record = {
    task_hash: compiled.task_hash,
    status: "funded",
    buyer,
    worker: null,
    task: compiled.task,
    escrow: {
      amount: compiled.task.reward.amount,
      currency: compiled.task.reward.currency,
      state: "locked",
    },
    attestations: [],
    events: [
      { type: "published", at: now(), actor: buyer },
      { type: "funded", at: now(), amount: compiled.task.reward.amount, currency: compiled.task.reward.currency },
    ],
  };
  state.tasks.push(record);
  return record;
}

function claim(state, ref, worker) {
  if (!worker) throw new Error("Missing --worker");
  const task = resolveTask(state, ref);
  if (task.status !== "funded") throw new Error(`Task is not claimable; status=${task.status}`);
  task.status = "claimed";
  task.worker = worker;
  task.events.push({ type: "claimed", at: now(), actor: worker });
  return task;
}

function attest(state, ref, submissionFile, inputs, ledgerFile) {
  const task = resolveTask(state, ref);
  if (task.status !== "claimed") throw new Error(`Task must be claimed before attestation; status=${task.status}`);
  const submission = fs.readFileSync(submissionFile, "utf8");
  const compiled = { task: task.task, task_hash: task.task_hash };
  const attestation = verifyCompiledTask(compiled, submission, inputs, ledgerFile);
  task.attestations.push(attestation);
  task.status = attestation.verdict === "pass" ? "passed" : "failed";
  task.events.push({
    type: "attested",
    at: now(),
    verifier: attestation.verifier,
    verdict: attestation.verdict,
    result_hash: attestation.result_hash,
  });
  return { task, attestation };
}

function release(state, ref) {
  const task = resolveTask(state, ref);
  if (task.status !== "passed") throw new Error(`Task is not releasable; status=${task.status}`);
  task.status = "released";
  task.escrow.state = "released";
  task.payout = {
    to: task.worker,
    amount: task.escrow.amount,
    currency: task.escrow.currency,
  };
  task.events.push({ type: "released", at: now(), to: task.worker, amount: task.escrow.amount, currency: task.escrow.currency });
  return task;
}

function summarize(state) {
  return state.tasks.map((task) => ({
    task_hash: task.task_hash,
    name: task.task.name,
    status: task.status,
    reward: task.task.reward,
    buyer: task.buyer,
    worker: task.worker,
  }));
}

function demo(taskFile, submissionFile, options) {
  const state = emptyState();
  const record = publish(state, taskFile, options.buyer || "buyer.demo");
  claim(state, record.task_hash, options.worker || "worker.demo");
  attest(state, record.task_hash, submissionFile, options.inputs, options.ledger);
  release(state, record.task_hash);
  return state.tasks[0];
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();
  const { positionals, options } = parseOptions(rest);

  if (command === "demo") {
    const [taskFile, submissionFile] = positionals;
    if (!taskFile || !submissionFile) usage();
    process.stdout.write(`${JSON.stringify(demo(taskFile, submissionFile, options), null, 2)}\n`);
    return;
  }

  if (command === "init") {
    if (fs.existsSync(options.state) && !options.force) {
      throw new Error(`State already exists: ${options.state}`);
    }
    const state = emptyState();
    saveState(options.state, state);
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }

  const state = loadState(options.state);
  let result;

  if (command === "publish") {
    const [taskFile] = positionals;
    if (!taskFile) usage();
    result = publish(state, taskFile, options.buyer);
  } else if (command === "claim") {
    const [ref] = positionals;
    if (!ref) usage();
    result = claim(state, ref, options.worker);
  } else if (command === "attest") {
    const [ref, submissionFile] = positionals;
    if (!ref || !submissionFile) usage();
    result = attest(state, ref, submissionFile, options.inputs, options.ledger);
  } else if (command === "release") {
    const [ref] = positionals;
    if (!ref) usage();
    result = release(state, ref);
  } else if (command === "list") {
    result = summarize(state);
  } else {
    usage();
  }

  if (command !== "list") saveState(options.state, state);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`tascmarket: ${error.message}`);
    process.exit(1);
  }
}
