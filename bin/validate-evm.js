#!/usr/bin/env node

const fs = require("fs");
const { compile } = require("./tasclang");

const CONTRACT_FILE = "contracts/TascEscrow.sol";
const ABI_FILE = "abi/TascEscrow.abi.json";
const EXAMPLE_TASK = "examples/summarize_url.tasc";

const REQUIRED_FUNCTIONS = {
  fund: ["bytes32", "address", "uint256", "uint64"],
  claim: ["bytes32"],
  attest: ["bytes32", "bytes32", "bool"],
  release: ["bytes32"],
  refund: ["bytes32"],
  openDispute: ["bytes32"],
  resolveDispute: ["bytes32", "bool"],
  getTask: ["bytes32"],
  setVerifier: ["address", "bool"],
  transferOwnership: ["address"],
};

const REQUIRED_EVENTS = [
  "Funded",
  "Claimed",
  "Attested",
  "Released",
  "Refunded",
  "Disputed",
  "DisputeResolved",
  "VerifierSet",
  "OwnershipTransferred",
];

const REQUIRED_STATUSES = [
  "None",
  "Funded",
  "Claimed",
  "Passed",
  "Failed",
  "Released",
  "Refunded",
  "Disputed",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function functionsByName(abi) {
  const map = new Map();
  for (const item of abi) {
    if (item.type === "function") map.set(item.name, item);
  }
  return map;
}

function eventsByName(abi) {
  const map = new Map();
  for (const item of abi) {
    if (item.type === "event") map.set(item.name, item);
  }
  return map;
}

function validateAbi(abi) {
  const funcs = functionsByName(abi);
  for (const [name, types] of Object.entries(REQUIRED_FUNCTIONS)) {
    const item = funcs.get(name);
    assert(item, `ABI missing function ${name}`);
    const actual = item.inputs.map((input) => input.type);
    assert(JSON.stringify(actual) === JSON.stringify(types), `ABI function ${name} inputs ${actual.join(",")} != ${types.join(",")}`);
  }

  const events = eventsByName(abi);
  for (const name of REQUIRED_EVENTS) {
    assert(events.has(name), `ABI missing event ${name}`);
  }
}

function validateContractSource(source) {
  assert(source.includes("contract TascEscrow"), "contract source missing TascEscrow");
  assert(source.includes("interface IERC20"), "contract source missing local IERC20 interface");
  assert(!source.includes("\nimport "), "contract should stay import-free for V1 surface");
  assert(source.includes("modifier nonReentrant"), "contract missing nonReentrant modifier");
  assert(source.includes("mapping(address => bool) public verifiers"), "contract missing verifier allowlist");
  assert(source.includes("function _release"), "contract missing internal release helper");
  assert(source.includes("function _refund"), "contract missing internal refund helper");

  for (const status of REQUIRED_STATUSES) {
    assert(source.includes(status), `contract missing status ${status}`);
  }

  for (const name of Object.keys(REQUIRED_FUNCTIONS)) {
    assert(source.includes(`function ${name}`), `contract source missing function ${name}`);
  }
}

function validateHashBoundary() {
  const compiled = compile(fs.readFileSync(EXAMPLE_TASK, "utf8"));
  assert(compiled.task_hash.startsWith("sha256:"), "compiler task hash missing sha256 prefix");
  const raw = compiled.task_hash.slice("sha256:".length);
  assert(/^[a-f0-9]{64}$/.test(raw), "compiler task hash is not 32 bytes of lowercase hex");
  const evmBytes32 = `0x${raw}`;
  assert(evmBytes32.length === 66, "EVM bytes32 boundary must be 0x + 64 hex chars");
  return { task_hash: compiled.task_hash, evm_bytes32: evmBytes32 };
}

function simulateLifecycle() {
  const transitions = [];
  let status = "None";

  function move(from, to, event) {
    assert(status === from, `bad lifecycle: expected ${from}, got ${status}`);
    status = to;
    transitions.push({ event, status });
  }

  move("None", "Funded", "fund");
  move("Funded", "Claimed", "claim");
  move("Claimed", "Passed", "attest(pass)");
  move("Passed", "Released", "release");

  assert(status === "Released", "happy path did not release");
  return transitions;
}

function main() {
  const abi = readJson(ABI_FILE);
  const source = fs.readFileSync(CONTRACT_FILE, "utf8");

  validateAbi(abi);
  validateContractSource(source);
  const hashBoundary = validateHashBoundary();
  const happyPath = simulateLifecycle();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    contract: CONTRACT_FILE,
    abi: ABI_FILE,
    hashBoundary,
    happyPath,
    note: "Static ABI/source validation passed. Run npm run compile:solidity for compiler-checked bytecode artifacts.",
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-evm: ${error.message}`);
    process.exit(1);
  }
}
