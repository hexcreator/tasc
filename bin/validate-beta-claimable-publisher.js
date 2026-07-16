#!/usr/bin/env node

const fs = require("fs");
const { ALLOW_ENV, plan } = require("./publish-beta-claimable");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const result = plan({
    runId: "claimable_validate",
    outDir: "examples/solana-devnet/claimable/claimable_validate",
    publishDir: "web/feed",
    deadline: "60s",
    mintAmount: "10000000",
  });
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const gitignore = fs.readFileSync(".gitignore", "utf8");
  const app = fs.readFileSync("web/app.js", "utf8");

  assert(result.ok, "claimable publisher plan must be ok");
  assert(result.sends_transactions === false, "claimable publisher plan must not send transactions");
  assert(result.guard_for_live_run === `${ALLOW_ENV}=1`, "claimable publisher guard mismatch");
  assert(result.no_new_dependencies === true, "claimable publisher must not add dependencies");
  assert(result.output_dir_gitignored === true, "claimable publisher output dir must be gitignored");
  assert(result.task_deadline === "60s", "claimable publisher should default to a 60s task");
  assert(result.live_run_leaves_task_status === "Funded", "claimable publisher should leave task Funded");
  assert(result.claimable_feed_file === "web/feed/claimable-feed.json", "claimable feed file mismatch");
  assert(gitignore.includes("examples/solana-devnet/claimable/"), "claimable artifact directory must be ignored");
  assert(packageJson.scripts["beta:claimable:plan"], "missing beta:claimable:plan script");
  assert(packageJson.scripts["beta:claimable"], "missing beta:claimable script");
  assert(app.includes("./feed/claimable-feed.json"), "static app should prefer active claimable feed");
  assert(app.includes("./feed/proof-feed.json"), "static app should fall back to proof feed");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    publisher: "bin/publish-beta-claimable.js",
    plan_mode_sends_transactions: result.sends_transactions,
    live_guard: result.guard_for_live_run,
    claimable_feed_file: result.claimable_feed_file,
    claimable_index_file: result.claimable_index_file,
    task_deadline: result.task_deadline,
    no_new_dependencies: true,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(`validate-beta-claimable-publisher: ${error.message}`);
  process.exit(1);
}
