#!/usr/bin/env node

const fs = require("fs");
const { ALLOW_ENV } = require("./publish-beta-claimable");
const { ACTIVE_INDEX_FILE, QA_COMMAND, plan } = require("./run-private-beta-session");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const result = plan({
    runId: "session_validate",
    outDir: "examples/solana-devnet/claimable/session_validate",
    publishDir: "web/feed",
    deadline: "60s",
    mintAmount: "10000000",
    token: "validate-session-token",
  });
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const runnerSource = fs.readFileSync("bin/run-private-beta-session.js", "utf8");

  assert(result.ok, "session runner plan must be ok");
  assert(result.sends_transactions === false, "session runner plan must not send transactions");
  assert(result.active_publish.sends_transactions === false, "active publisher plan must not send transactions");
  assert(result.guard_for_live_run === `${ALLOW_ENV}=1`, "session runner guard mismatch");
  assert(result.no_new_dependencies === true, "session runner must not add dependencies");
  assert(result.active_publish.no_new_dependencies === true, "active publisher must not add dependencies");
  assert(result.verifier_trusted_index === ACTIVE_INDEX_FILE, "session runner must trust active claimable index");
  assert(result.local_session.trusted_index === ACTIVE_INDEX_FILE, "local verifier trusted index mismatch");
  assert(result.active_publish.claimable_feed_file === "web/feed/claimable-feed.json", "claimable feed file mismatch");
  assert(result.active_publish.claimable_index_file === ACTIVE_INDEX_FILE, "claimable active index file mismatch");
  assert(result.app_action === "Load Hosted Feed", "operator app action mismatch");
  assert(result.command_path.qa === QA_COMMAND, "QA command mismatch");
  assert(result.run_sequence[0] === "preflight localhost web/verifier ports", "run sequence should preflight local ports first");
  assert(result.operator_steps.some((step) => step.includes("Load Hosted Feed")), "operator steps should load hosted feed");
  assert(result.operator_steps.some((step) => step.includes(QA_COMMAND)), "operator steps should include strict QA validation");
  assert(result.local_session.verifier_bearer_token === "validate-session-token", "local session token mismatch");
  assert(packageJson.scripts["beta:session:plan"] === "node bin/run-private-beta-session.js plan", "missing beta:session:plan script");
  assert(packageJson.scripts["beta:session"] === "node bin/run-private-beta-session.js run", "missing beta:session script");
  assert(packageJson.scripts["validate:private-beta-session-runner"] === "node bin/validate-private-beta-session-runner.js", "missing validator script");
  assert(packageJson.scripts.demo.includes("validate:private-beta-session-runner"), "demo should include session runner validation");
  assert(runnerSource.includes("publishClaimable.run"), "live session runner should call active publisher");
  assert(runnerSource.includes("startPrivateBetaSession"), "live session runner should start local private beta session");
  assert(runnerSource.indexOf("assertLiveGuard()") < runnerSource.indexOf("await preflightLocalPorts(options)"), "live run should check guard before port preflight");
  assert(runnerSource.indexOf("await preflightLocalPorts(options)") < runnerSource.indexOf("publishClaimable.run"), "live run should preflight before publish");
  assert(runnerSource.includes(ACTIVE_INDEX_FILE), "runner should pin active claimable index");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    runner: "bin/run-private-beta-session.js",
    plan_mode_sends_transactions: result.sends_transactions,
    live_guard: result.guard_for_live_run,
    claimable_feed_file: result.active_publish.claimable_feed_file,
    verifier_trusted_index: result.verifier_trusted_index,
    app_action: result.app_action,
    preflight: result.run_sequence[0],
    qa_command: result.command_path.qa,
    no_new_dependencies: true,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(`validate-private-beta-session-runner: ${error.message}`);
  process.exit(1);
}
