#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const solc = require("solc");

const CONTRACT_FILE = "contracts/TascEscrow.sol";
const CONTRACT_NAME = "TascEscrow";
const ABI_FILE = "abi/TascEscrow.abi.json";
const BUILD_DIR = "build";
const ARTIFACT_FILE = path.join(BUILD_DIR, "TascEscrow.json");
const EXTRA_CONTRACT_FILES = ["contracts/MockUSDC.sol"];

function normalizeAbiEntry(entry) {
  const normalized = { ...entry };
  if (Array.isArray(normalized.inputs)) {
    normalized.inputs = normalized.inputs.map(normalizeParam);
  }
  if (Array.isArray(normalized.outputs)) {
    normalized.outputs = normalized.outputs.map(normalizeParam);
  }
  return normalized;
}

function normalizeParam(param) {
  const normalized = {
    name: param.name || "",
    type: param.type,
  };
  if (param.indexed !== undefined) normalized.indexed = param.indexed;
  if (param.internalType !== undefined) normalized.internalType = param.internalType;
  if (Array.isArray(param.components)) {
    normalized.components = param.components.map(normalizeParam);
  }
  return normalized;
}

function abiKey(entry) {
  const inputs = (entry.inputs || []).map((input) => `${input.name}:${input.type}`).join(",");
  return `${entry.type}:${entry.name || "constructor"}(${inputs})`;
}

function comparableAbi(abi) {
  return abi
    .map(normalizeAbiEntry)
    .sort((a, b) => abiKey(a).localeCompare(abiKey(b)));
}

function assertAbiMatches(compiledAbi, checkedInAbi) {
  const compiledComparable = comparableAbi(compiledAbi);
  const checkedComparable = comparableAbi(checkedInAbi);
  const compiledJson = JSON.stringify(compiledComparable, null, 2);
  const checkedJson = JSON.stringify(checkedComparable, null, 2);
  if (compiledJson !== checkedJson) {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
    fs.writeFileSync(path.join(BUILD_DIR, "TascEscrow.compiled.abi.json"), `${JSON.stringify(compiledAbi, null, 2)}\n`);
    throw new Error(`Compiled ABI differs from ${ABI_FILE}. Wrote compiled ABI to build/TascEscrow.compiled.abi.json`);
  }
}

function compile() {
  const sources = {};
  for (const file of [CONTRACT_FILE, ...EXTRA_CONTRACT_FILES]) {
    sources[file] = { content: fs.readFileSync(file, "utf8") };
  }

  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((item) => item.severity === "error");
  const warnings = (output.errors || []).filter((item) => item.severity === "warning");
  if (errors.length > 0) {
    for (const error of errors) console.error(error.formattedMessage || error.message);
    throw new Error("Solidity compilation failed");
  }

  const compiled = output.contracts?.[CONTRACT_FILE]?.[CONTRACT_NAME];
  if (!compiled) throw new Error(`Missing compiled contract ${CONTRACT_NAME}`);
  if (!compiled.evm?.bytecode?.object) throw new Error("Compiled bytecode is empty");

  const checkedInAbi = JSON.parse(fs.readFileSync(ABI_FILE, "utf8"));
  assertAbiMatches(compiled.abi, checkedInAbi);

  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const writtenArtifacts = [];
  for (const [sourceName, contracts] of Object.entries(output.contracts || {})) {
    for (const [contractName, contract] of Object.entries(contracts)) {
      if (!contract.evm?.bytecode?.object) continue;
      const artifact = {
        contractName,
        sourceName,
        compiler: {
          version: solc.version(),
          optimizer: { enabled: true, runs: 200 },
        },
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
        metadata: JSON.parse(contract.metadata),
      };
      const artifactFile = path.join(BUILD_DIR, `${contractName}.json`);
      fs.writeFileSync(artifactFile, `${JSON.stringify(artifact, null, 2)}\n`);
      writtenArtifacts.push({
        contractName,
        artifact: artifactFile,
        bytecode_bytes: artifact.bytecode.length >= 2 ? (artifact.bytecode.length - 2) / 2 : 0,
        deployed_bytecode_bytes: artifact.deployedBytecode.length >= 2 ? (artifact.deployedBytecode.length - 2) / 2 : 0,
        abi_entries: artifact.abi.length,
      });
    }
  }

  return {
    ok: true,
    contract: CONTRACT_FILE,
    artifact: ARTIFACT_FILE,
    compiler: solc.version(),
    artifacts: writtenArtifacts,
    warnings: warnings.map((warning) => warning.formattedMessage || warning.message),
  };
}

function main() {
  const result = compile();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`compile-solidity: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  compile,
  comparableAbi,
};
