#!/usr/bin/env node

const fs = require("fs");
const { ALLOW_ENV, DEFAULT_DEVNET_PROGRAM_ID, plan } = require("./prove-solana-devnet");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const result = plan({
    runId: "proof_validate",
    outDir: "examples/solana-devnet/proofs/proof_validate",
  });
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const gitignore = fs.readFileSync(".gitignore", "utf8");

  assert(result.ok, "proof runner plan must be ok");
  assert(result.sends_transactions === false, "proof runner plan must not send transactions");
  assert(result.guard_for_live_run === `${ALLOW_ENV}=1`, "proof runner guard mismatch");
  assert(result.no_new_dependencies === true, "proof runner must not add dependencies");
  assert(result.default_program_id === DEFAULT_DEVNET_PROGRAM_ID, "default devnet program id mismatch");
  assert(result.output_dir_gitignored === true, "default proof output dir must be gitignored");
  assert(gitignore.includes("examples/solana-devnet/proofs/"), "proof output directory must be ignored");
  assert(packageJson.scripts["prove:solana-devnet:plan"], "missing prove:solana-devnet:plan script");
  assert(packageJson.scripts["prove:solana-devnet"], "missing prove:solana-devnet script");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    proof_runner: "bin/prove-solana-devnet.js",
    plan_mode_sends_transactions: result.sends_transactions,
    live_guard: result.guard_for_live_run,
    output_dir: result.output_dir,
    default_program_id: result.default_program_id,
    no_new_dependencies: true,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(`validate-solana-proof-runner: ${error.message}`);
  process.exit(1);
}
