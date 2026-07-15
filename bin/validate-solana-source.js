#!/usr/bin/env node

const fs = require("fs");
const { spawnSync } = require("child_process");
const { spec } = require("./tascsolana-program");

const MANIFEST = "programs/solana-tasc/Cargo.toml";
const SOURCE = "programs/solana-tasc/src/lib.rs";
const TARGET_DIR = "/tmp/global-tasc-solana-tasc-target";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function commandExists(command) {
  const result = spawnSync("which", [command], {
    encoding: "utf8",
  });
  return result.status === 0;
}

function runCargoTest() {
  if (!commandExists("cargo")) {
    return {
      ran: false,
      ok: false,
      reason: "cargo not found",
    };
  }
  const result = spawnSync("cargo", ["test", "--manifest-path", MANIFEST], {
    encoding: "utf8",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: TARGET_DIR,
    },
    maxBuffer: 1024 * 1024 * 8,
  });
  return {
    ran: true,
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function extractConst(source, name) {
  const match = source.match(new RegExp(`pub const ${name}: [^=]+ = ([^;]+);`));
  assert(match, `missing Rust const ${name}`);
  return match[1].trim();
}

function parseNumber(value) {
  const raw = value.replace(/_/g, "");
  assert(/^\d+$/.test(raw), `expected numeric const, got ${value}`);
  return Number(raw);
}

function main() {
  assert(fs.existsSync(MANIFEST), `missing ${MANIFEST}`);
  assert(fs.existsSync(SOURCE), `missing ${SOURCE}`);
  const abi = spec();
  const source = fs.readFileSync(SOURCE, "utf8");

  const taskSize = parseNumber(extractConst(source, "TASK_ACCOUNT_SIZE"));
  const fundInstructionSize = parseNumber(extractConst(source, "FUND_INSTRUCTION_SIZE"));
  const attestInstructionSize = parseNumber(extractConst(source, "ATTEST_INSTRUCTION_SIZE"));
  const claimAccountCount = parseNumber(extractConst(source, "RUNTIME_CLAIM_ACCOUNTS"));
  const settlementAccountCount = parseNumber(extractConst(source, "RUNTIME_SETTLEMENT_ACCOUNTS"));
  const timeoutRefundAccountCount = parseNumber(extractConst(source, "RUNTIME_TIMEOUT_REFUND_ACCOUNTS"));
  const tagFund = parseNumber(extractConst(source, "TAG_FUND"));
  const tagClaim = parseNumber(extractConst(source, "TAG_CLAIM"));
  const tagAttest = parseNumber(extractConst(source, "TAG_ATTEST"));
  const tagRelease = parseNumber(extractConst(source, "TAG_RELEASE"));
  const tagRefund = parseNumber(extractConst(source, "TAG_REFUND"));
  const statusFunded = parseNumber(extractConst(source, "STATUS_FUNDED"));
  const statusClaimed = parseNumber(extractConst(source, "STATUS_CLAIMED"));
  const statusPassed = parseNumber(extractConst(source, "STATUS_PASSED"));
  const statusFailed = parseNumber(extractConst(source, "STATUS_FAILED"));
  const statusReleased = parseNumber(extractConst(source, "STATUS_RELEASED"));
  const statusRefunded = parseNumber(extractConst(source, "STATUS_REFUNDED"));
  const amountOffset = parseNumber(extractConst(source, "AMOUNT_OFFSET"));
  const updatedSlotOffset = parseNumber(extractConst(source, "UPDATED_SLOT_OFFSET"));

  const discriminatorMatch = source.includes("0xfe, 0x5a, 0x9b, 0x1a, 0x20, 0xf0, 0x8f, 0x03");
  const clockSysvarMatch = source.includes("6, 167, 213, 23, 24, 199, 116, 201");
  assert(discriminatorMatch, "Rust discriminator does not match JS ABI");
  assert(clockSysvarMatch, "Rust Clock sysvar does not match JS ABI");
  assert(taskSize === abi.task_account.size, "Rust task account size does not match JS ABI");
  assert(fundInstructionSize === 121, "Rust fund instruction size mismatch");
  assert(attestInstructionSize === 34, "Rust attest instruction size mismatch");
  assert(claimAccountCount === 3, "Rust claim account count mismatch");
  assert(settlementAccountCount === 7, "Rust settlement account count mismatch");
  assert(timeoutRefundAccountCount === 8, "Rust timeout refund account count mismatch");
  assert(tagFund === abi.instructions.tags.fund, "Rust fund tag does not match JS ABI");
  assert(tagClaim === abi.instructions.tags.claim, "Rust claim tag does not match JS ABI");
  assert(tagAttest === abi.instructions.tags.attest, "Rust attest tag does not match JS ABI");
  assert(tagRelease === abi.instructions.tags.release, "Rust release tag does not match JS ABI");
  assert(tagRefund === abi.instructions.tags.refund, "Rust refund tag does not match JS ABI");
  assert(statusFunded === abi.task_account.statuses.Funded, "Rust Funded status does not match JS ABI");
  assert(statusClaimed === abi.task_account.statuses.Claimed, "Rust Claimed status does not match JS ABI");
  assert(statusPassed === abi.task_account.statuses.Passed, "Rust Passed status does not match JS ABI");
  assert(statusFailed === abi.task_account.statuses.Failed, "Rust Failed status does not match JS ABI");
  assert(statusReleased === abi.task_account.statuses.Released, "Rust Released status does not match JS ABI");
  assert(statusRefunded === abi.task_account.statuses.Refunded, "Rust Refunded status does not match JS ABI");
  assert(amountOffset === 204, "Rust amount offset mismatch");
  assert(updatedSlotOffset === 268, "Rust updated_slot offset mismatch");

  const cargo = runCargoTest();
  assert(cargo.ok, cargo.ran ? `cargo test failed: ${cargo.stderr || cargo.stdout}` : cargo.reason);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    manifest: MANIFEST,
    source: SOURCE,
    rust_checks: {
      task_account_size: taskSize,
      fund_instruction_size: fundInstructionSize,
      attest_instruction_size: attestInstructionSize,
      claim_account_count: claimAccountCount,
      settlement_account_count: settlementAccountCount,
      timeout_refund_account_count: timeoutRefundAccountCount,
      discriminator: abi.task_account.discriminator_hex,
      clock_sysvar: abi.sysvars.clock,
      status_funded: statusFunded,
      lifecycle_statuses: {
        funded: statusFunded,
        claimed: statusClaimed,
        passed: statusPassed,
        failed: statusFailed,
        released: statusReleased,
        refunded: statusRefunded,
      },
      instruction_tags: {
        fund: tagFund,
        claim: tagClaim,
        attest: tagAttest,
        release: tagRelease,
        refund: tagRefund,
      },
      amount_offset: amountOffset,
      updated_slot_offset: updatedSlotOffset,
    },
    cargo_test: {
      ran: cargo.ran,
      ok: cargo.ok,
      target_dir: TARGET_DIR,
    },
    dependency_posture: {
      cargo_dependencies: [],
      npm_production_dependencies_added: false,
    },
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-solana-source: ${error.message}`);
    process.exit(1);
  }
}
