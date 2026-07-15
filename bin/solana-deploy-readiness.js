#!/usr/bin/env node

const fs = require("fs");
const { spawnSync } = require("child_process");

const ENV_FILE = ".env.solana-devnet.local";
const SBF_ARTIFACT = "build/solana/global_tasc_solana_program.so";
const SBF_MANIFEST = "build/solana-tasc.sbf.json";
const REQUIRED_ENV_KEYS = [
  "SOLANA_DEVNET_RPC_URL",
  "GLOBAL_TASC_SOLANA_BUYER_ADDRESS",
  "GLOBAL_TASC_SOLANA_WORKER_ADDRESS",
  "GLOBAL_TASC_SOLANA_VERIFIER_ADDRESS",
];

function commandVersion(command, args = ["--version"]) {
  const exists = spawnSync("which", [command], {
    encoding: "utf8",
  });
  if (exists.status !== 0) {
    return { found: false, path: null, version: null };
  }
  const version = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return {
    found: true,
    path: exists.stdout.trim(),
    version: (version.stdout || version.stderr || "").trim().split(/\r?\n/)[0] || null,
  };
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

function artifactStatus() {
  return {
    path: SBF_ARTIFACT,
    exists: fs.existsSync(SBF_ARTIFACT),
    manifest: SBF_MANIFEST,
    manifest_exists: fs.existsSync(SBF_MANIFEST),
  };
}

function main() {
  const cargo = commandVersion("cargo");
  const rustc = commandVersion("rustc");
  const solana = commandVersion("solana");
  const cargoBuildSbf = commandVersion("cargo-build-sbf");
  const solanaCargoBuildSbf = commandVersion("cargo", ["build-sbf", "--version"]);
  const env = { ...loadEnvFile(ENV_FILE), ...process.env };
  const missingEnv = REQUIRED_ENV_KEYS.filter((key) => !env[key]);
  const hasSbfBuilder = cargoBuildSbf.found || (solanaCargoBuildSbf.version && !/no such command|error/i.test(solanaCargoBuildSbf.version));
  const artifact = artifactStatus();
  const blockers = [];

  if (!cargo.found) blockers.push("Install Rust/Cargo.");
  if (!rustc.found) blockers.push("Install rustc.");
  if (!solana.found) blockers.push("Install Solana CLI and put `solana` on PATH.");
  if (!hasSbfBuilder) blockers.push("Install the Solana SBF build toolchain (`cargo build-sbf` or `cargo-build-sbf`).");
  if (missingEnv.length > 0) blockers.push(`Configure ${ENV_FILE} or environment keys: ${missingEnv.join(", ")}.`);

  const ready = blockers.length === 0;
  const result = {
    ok: true,
    ready,
    toolchain: {
      cargo,
      rustc,
      solana,
      cargo_build_sbf: cargoBuildSbf,
      cargo_build_sbf_subcommand: solanaCargoBuildSbf,
    },
    env: {
      file: ENV_FILE,
      file_exists: fs.existsSync(ENV_FILE),
      missing: missingEnv,
    },
    sbf_artifact: artifact,
    next: ready
      ? artifact.exists
        ? [
          "Deploy the account-mutating fund processor to devnet after explicit approval.",
          "Send the fund instruction against a pre-created task account.",
          "Scan the live task account into tasc.funding.solana.",
        ]
        : [
          "Build the program with `npm run solana:build-sbf`.",
          "Deploy the program to devnet after explicit approval.",
          "Send the fund instruction and scan the live task account into tasc.funding.solana.",
        ]
      : blockers,
    user_needed: ready ? [] : blockers,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`solana-deploy-readiness: ${error.message}`);
    process.exit(1);
  }
}
