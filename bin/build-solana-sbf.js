#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const MANIFEST = "programs/solana-tasc/Cargo.toml";
const OUT_DIR = "build/solana";
const MANIFEST_OUT = "build/solana-tasc.sbf.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
    ...options,
  });
  return {
    command,
    args,
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error ? result.error.message : null,
  };
}

function commandExists(command) {
  return run("which", [command]).status === 0;
}

function commandVersion(command, args = ["--version"]) {
  if (!commandExists(command)) return null;
  const result = run(command, args);
  return (result.stdout || result.stderr || "").split(/\r?\n/)[0].trim() || null;
}

function compareVersionDirs(a, b) {
  const parse = (value) => value.replace(/^v/, "").split(".").map((part) => Number(part) || 0);
  const av = parse(a);
  const bv = parse(b);
  for (let index = 0; index < Math.max(av.length, bv.length); index += 1) {
    const delta = (bv[index] || 0) - (av[index] || 0);
    if (delta !== 0) return delta;
  }
  return a.localeCompare(b);
}

function findPlatformTools() {
  const cacheDir = path.join(os.homedir(), ".cache", "solana");
  if (!fs.existsSync(cacheDir)) return null;

  const versions = fs.readdirSync(cacheDir)
    .filter((entry) => /^v\d+\./.test(entry))
    .sort(compareVersionDirs);

  for (const version of versions) {
    const root = path.join(cacheDir, version, "platform-tools");
    const cargo = path.join(root, "rust", "bin", "cargo");
    const rustc = path.join(root, "rust", "bin", "rustc");
    const readelf = path.join(root, "llvm", "bin", "llvm-readelf");
    if (fs.existsSync(cargo) && fs.existsSync(rustc)) {
      return {
        version,
        root,
        cargo,
        rustc,
        readelf: fs.existsSync(readelf) ? readelf : null,
      };
    }
  }

  return null;
}

function listSoFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((entry) => entry.endsWith(".so"))
    .map((entry) => path.join(directory, entry));
}

function secureGeneratedKeypairs(directory) {
  if (!fs.existsSync(directory)) return 0;
  let secured = 0;
  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith("-keypair.json")) continue;
    fs.chmodSync(path.join(directory, entry), 0o600);
    secured += 1;
  }
  return secured;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function checkEntrypointSymbol(artifact, readelf) {
  if (!readelf) {
    return {
      checked: false,
      ok: null,
      reason: "llvm-readelf not found in Solana platform tools",
    };
  }
  const result = run(readelf, ["-s", artifact]);
  if (result.status !== 0) {
    return {
      checked: true,
      ok: false,
      reason: result.stderr || result.stdout || result.error || "llvm-readelf failed",
    };
  }
  return {
    checked: true,
    ok: /\bentrypoint\b/.test(result.stdout),
  };
}

function main() {
  assert(fs.existsSync(MANIFEST), `missing ${MANIFEST}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const platformTools = findPlatformTools();
  const builder = commandExists("cargo-build-sbf")
    ? { command: "cargo-build-sbf", prefixArgs: [] }
    : { command: "cargo", prefixArgs: ["build-sbf"] };

  assert(commandExists(builder.command), "missing cargo-build-sbf or cargo build-sbf");

  const env = { ...process.env };
  const args = [
    ...builder.prefixArgs,
    "--manifest-path",
    MANIFEST,
    "--sbf-out-dir",
    OUT_DIR,
  ];

  if (platformTools) {
    env.CARGO = platformTools.cargo;
    env.RUSTC = platformTools.rustc;
    args.splice(builder.prefixArgs.length, 0, "--no-rustup-override", "--skip-tools-install");
  }

  const build = run(builder.command, args, { env });
  assert(
    build.status === 0,
    `SBF build failed with status ${build.status}: ${build.stderr || build.stdout || build.error || "unknown error"}`,
  );

  const artifacts = listSoFiles(OUT_DIR);
  assert(artifacts.length > 0, `SBF build completed but no .so artifact was written to ${OUT_DIR}`);
  assert(artifacts.length === 1, `expected one .so artifact in ${OUT_DIR}, found ${artifacts.length}`);

  const artifact = artifacts[0];
  const stat = fs.statSync(artifact);
  const generatedKeypairsSecured = secureGeneratedKeypairs(OUT_DIR);
  const entrypointSymbol = checkEntrypointSymbol(artifact, platformTools ? platformTools.readelf : null);
  assert(entrypointSymbol.ok !== false, "SBF artifact does not expose the required entrypoint symbol");

  const metadata = {
    ok: true,
    manifest: MANIFEST,
    out_dir: OUT_DIR,
    artifact: {
      path: artifact,
      bytes: stat.size,
      sha256: sha256(artifact),
      entrypoint_symbol: entrypointSymbol,
    },
    builder: {
      command: builder.command,
      version: commandVersion(builder.command, builder.command === "cargo" ? ["build-sbf", "--version"] : ["--version"]),
      used_platform_tools: Boolean(platformTools),
      platform_tools_version: platformTools ? platformTools.version : null,
      no_rustup_override: Boolean(platformTools),
      skipped_tool_install: Boolean(platformTools),
    },
    toolchain: {
      solana: commandVersion("solana"),
      cargo: commandVersion("cargo"),
      rustc: commandVersion("rustc"),
    },
    dependency_posture: {
      cargo_dependencies: [],
      npm_dependencies_added: false,
      note: "Uses only Node built-ins and the installed Solana platform toolchain.",
    },
    secret_posture: {
      generated_keypairs_secured_count: generatedKeypairsSecured,
      generated_keypairs_printed: false,
      generated_keypairs_gitignored: true,
    },
  };

  fs.mkdirSync(path.dirname(MANIFEST_OUT), { recursive: true });
  fs.writeFileSync(MANIFEST_OUT, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`build-solana-sbf: ${error.message}`);
    process.exit(1);
  }
}
