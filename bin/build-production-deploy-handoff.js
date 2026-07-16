#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  assertBase58Address,
  base58Decode,
  base58Encode,
} = require("./run-solana-devnet");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_ARTIFACT = "build/solana/global_tasc_solana_program.so";
const DEFAULT_MANIFEST = "build/solana-tasc.sbf.json";
const DEFAULT_PROGRAM_KEYPAIR = "build/solana/global_tasc_solana_program-keypair.json";
const DEFAULT_OUT = ".tascverifier/production-deploy-handoff.json";
const DEFAULT_CLUSTER = "solana-mainnet-beta";
const TEST_RPC_HOST_RE = /(devnet|testnet|localhost|127\.0\.0\.1|0\.0\.0\.0)/i;

function usage() {
  console.error([
    "Usage:",
    "  node bin/build-production-deploy-handoff.js plan [options]",
    "  node bin/build-production-deploy-handoff.js build [options]",
    "  node bin/build-production-deploy-handoff.js validate <handoff.json>",
    "  node bin/build-production-deploy-handoff.js --self-test",
    "",
    "Build options:",
    "  --artifact <file>                         SBF artifact; default build/solana/global_tasc_solana_program.so",
    "  --manifest <file>                         SBF manifest; default build/solana-tasc.sbf.json",
    "  --program-keypair <file>                  generated program-id keypair JSON; default build/solana/global_tasc_solana_program-keypair.json",
    "  --program-id <address>                    optional expected program id; must match keypair",
    "  --deployer <address>                      optional mainnet deployer wallet address",
    "  --production-rpc-url <url>                optional mainnet RPC URL; host only is persisted",
    "  --expected-genesis-hash <hash>            optional mainnet genesis hash to carry into preflight",
    "  --out <file>                              output handoff file; default .tascverifier/production-deploy-handoff.json",
    "",
    "This builder creates a sanitized deploy handoff only. It never calls RPC and never sends transactions.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    command: "plan",
    handoffFile: "",
    artifact: DEFAULT_ARTIFACT,
    manifest: DEFAULT_MANIFEST,
    programKeypair: DEFAULT_PROGRAM_KEYPAIR,
    programId: "",
    deployer: "",
    productionRpcUrl: "",
    expectedGenesisHash: "",
    out: DEFAULT_OUT,
    selfTest: false,
    allowTestRpcHost: false,
  };
  const args = [...argv];
  if (["plan", "build", "validate"].includes(args[0])) options.command = args.shift();
  if (options.command === "validate" && args[0] && !args[0].startsWith("--")) options.handoffFile = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--artifact") options.artifact = requireValue(args, ++i, arg);
    else if (arg === "--manifest") options.manifest = requireValue(args, ++i, arg);
    else if (arg === "--program-keypair") options.programKeypair = requireValue(args, ++i, arg);
    else if (arg === "--program-id") options.programId = requireValue(args, ++i, arg);
    else if (arg === "--deployer") options.deployer = requireValue(args, ++i, arg);
    else if (arg === "--production-rpc-url") options.productionRpcUrl = requireValue(args, ++i, arg);
    else if (arg === "--expected-genesis-hash") options.expectedGenesisHash = requireValue(args, ++i, arg);
    else if (arg === "--out") options.out = requireValue(args, ++i, arg);
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  return options;
}

function requireValue(args, index, label) {
  const value = args[index] || "";
  if (!value) throw new Error(`${label} requires a value`);
  return value;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function rel(file) {
  return path.relative(ROOT, path.resolve(file));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertSolanaAddress(value, label) {
  assertBase58Address(value, label);
  assert(base58Decode(value).length === 32, `${label} must decode to 32 bytes`);
  return value;
}

function assertHttpUrl(value, label, allowTestRpcHost = false) {
  assert(typeof value === "string" && value.length > 0, `${label} is required`);
  const url = new URL(value);
  assert(url.protocol === "http:" || url.protocol === "https:", `${label} must be http(s)`);
  if (!allowTestRpcHost && TEST_RPC_HOST_RE.test(url.host)) {
    throw new Error("production RPC host must not look like devnet/testnet/local");
  }
  return url;
}

function parseProgramKeypair(file) {
  assert(fs.existsSync(file), `${file} not found; run npm run solana:build-sbf`);
  const keypair = loadJson(file);
  assert(Array.isArray(keypair), "program keypair JSON must be an array");
  assert(keypair.length >= 64, "program keypair JSON must contain at least 64 bytes");
  const bytes = keypair.map((value, index) => {
    assert(Number.isInteger(value) && value >= 0 && value <= 255, `program keypair byte ${index} must be 0..255`);
    return value;
  });
  return Buffer.from(bytes.slice(-32));
}

function programKeypairPermissions(file) {
  const mode = fs.statSync(file).mode & 0o777;
  const text = mode.toString(8).padStart(3, "0");
  return {
    mode_octal: text,
    private_to_owner: (mode & 0o077) === 0,
  };
}

function readArtifactStatus(artifactFile, manifestFile) {
  assert(fs.existsSync(artifactFile), `${artifactFile} not found; run npm run solana:build-sbf`);
  assert(fs.existsSync(manifestFile), `${manifestFile} not found; run npm run solana:build-sbf`);
  const stat = fs.statSync(artifactFile);
  const sha256 = sha256File(artifactFile);
  const manifest = loadJson(manifestFile);
  const manifestArtifact = manifest.artifact || {};
  assert(manifest.ok === true, "SBF manifest ok must be true");
  assert(manifestArtifact.path === rel(artifactFile), "SBF manifest artifact path mismatch");
  assert(manifestArtifact.sha256 === sha256, "SBF manifest artifact sha256 mismatch");
  assert(manifestArtifact.bytes === stat.size, "SBF manifest artifact byte size mismatch");
  assert(manifestArtifact.entrypoint_symbol && manifestArtifact.entrypoint_symbol.ok === true, "SBF manifest must confirm entrypoint symbol");
  return {
    file: rel(artifactFile),
    bytes: stat.size,
    sha256,
    manifest_file: rel(manifestFile),
    manifest_sha256: sha256File(manifestFile),
    manifest_artifact_sha256: manifestArtifact.sha256,
    manifest_matches_artifact: true,
    entrypoint_symbol: manifestArtifact.entrypoint_symbol,
    builder: manifest.builder || null,
    dependency_posture: manifest.dependency_posture || null,
  };
}

function deployCommand(options) {
  return [
    "solana program deploy",
    rel(options.artifact),
    "--program-id",
    rel(options.programKeypair),
    "--keypair",
    "<mainnet-deployer-keypair>",
    "--url",
    "<mainnet-rpc-url>",
    "--output",
    "json",
  ].join(" ");
}

function buildHandoff(options = {}) {
  const artifactFile = path.resolve(options.artifact || DEFAULT_ARTIFACT);
  const manifestFile = path.resolve(options.manifest || DEFAULT_MANIFEST);
  const programKeypairFile = path.resolve(options.programKeypair || DEFAULT_PROGRAM_KEYPAIR);
  const artifact = readArtifactStatus(artifactFile, manifestFile);
  const publicKey = parseProgramKeypair(programKeypairFile);
  const programId = base58Encode(publicKey);
  assertSolanaAddress(programId, "program_id");
  const permissions = programKeypairPermissions(programKeypairFile);
  assert(permissions.private_to_owner, "program keypair file must not be group/world readable");
  if (options.programId) assert(assertSolanaAddress(options.programId, "program_id") === programId, "program_id must match generated program keypair");
  const rpcHost = options.productionRpcUrl
    ? assertHttpUrl(options.productionRpcUrl, "production_rpc_url", options.allowTestRpcHost).host
    : null;
  const deployer = options.deployer ? assertSolanaAddress(options.deployer, "deployer") : "";
  return {
    ok: true,
    kind: "tasc.production_deploy.handoff",
    version: "0.1",
    generated_at: new Date().toISOString(),
    cluster: DEFAULT_CLUSTER,
    network_type: "mainnet",
    program: {
      id: programId,
      artifact,
      program_keypair_file: rel(programKeypairFile),
      program_keypair_permissions: permissions,
      program_keypair_bytes_printed: false,
      program_keypair_material_persisted_in_handoff: false,
    },
    deploy: {
      deployer: deployer || "<mainnet-deployer-wallet>",
      command: deployCommand({
        artifact: artifactFile,
        programKeypair: programKeypairFile,
      }),
      expected_genesis_hash: options.expectedGenesisHash || "<mainnet-genesis-hash>",
      production_rpc_host: rpcHost,
      production_rpc_url_set: Boolean(options.productionRpcUrl),
      production_rpc_url_persisted: false,
      capture: [
        "mainnet deploy transaction signature",
        "deployed executable program account",
        "program data account or upgrade authority details from Solana CLI output",
      ],
      next_preflight_command: [
        "npm run real:preflight --",
        " --production-rpc-url <mainnet-rpc-url>",
        ` --expected-genesis-hash ${options.expectedGenesisHash || "<mainnet-genesis-hash>"}`,
        ` --program-id ${programId}`,
        " --usdc-mint <mainnet-usdc-mint>",
        " --buyer <buyer-wallet>",
        " --worker <worker-wallet>",
        " --verifier <verifier-wallet>",
        " --buyer-usdc-token-account <buyer-usdc-account>",
        " --worker-usdc-token-account <worker-usdc-account>",
      ].join(""),
    },
    source: {
      built_by: "bin/build-production-deploy-handoff.js",
      sends_transactions: false,
      calls_rpc: false,
      writes_files: true,
      accepts_deployer_private_keys: false,
      reads_program_keypair_file: true,
      key_material_printed: false,
      rpc_url_printed: false,
      full_rpc_url_persisted: false,
      no_new_dependencies: true,
    },
  };
}

function validateHandoff(handoff) {
  assert(handoff && typeof handoff === "object", "handoff must be a JSON object");
  assert(handoff.kind === "tasc.production_deploy.handoff", "handoff kind mismatch");
  assert(handoff.version === "0.1", "handoff version mismatch");
  assert(handoff.cluster === DEFAULT_CLUSTER, "handoff cluster must be solana-mainnet-beta");
  assert(handoff.network_type === "mainnet", "handoff network_type must be mainnet");
  const program = handoff.program || {};
  assertSolanaAddress(program.id, "program.id");
  const artifact = program.artifact || {};
  assert(typeof artifact.file === "string" && artifact.file.endsWith(".so"), "artifact file must be a .so");
  assert(Number.isInteger(artifact.bytes) && artifact.bytes > 0, "artifact bytes must be positive");
  assert(/^[a-f0-9]{64}$/.test(artifact.sha256 || ""), "artifact sha256 must be hex");
  assert(/^[a-f0-9]{64}$/.test(artifact.manifest_sha256 || ""), "manifest sha256 must be hex");
  assert(artifact.manifest_artifact_sha256 === artifact.sha256, "manifest artifact sha must match artifact sha");
  assert(artifact.manifest_matches_artifact === true, "manifest must match artifact");
  assert(artifact.entrypoint_symbol && artifact.entrypoint_symbol.ok === true, "entrypoint symbol must be confirmed");
  assert(program.program_keypair_permissions && program.program_keypair_permissions.private_to_owner === true, "program keypair file must be owner-private");
  assert(program.program_keypair_bytes_printed === false, "program keypair bytes must not be printed");
  assert(program.program_keypair_material_persisted_in_handoff === false, "program keypair material must not persist in handoff");
  const deploy = handoff.deploy || {};
  assert(typeof deploy.command === "string" && deploy.command.includes("solana program deploy"), "deploy command is required");
  assert(deploy.command.includes("--program-id"), "deploy command must include --program-id");
  assert(deploy.command.includes("--url <mainnet-rpc-url>"), "deploy command must keep RPC URL as placeholder");
  assert(deploy.production_rpc_url_persisted === false, "deploy block must not persist full RPC URL");
  const source = handoff.source || {};
  assert(source.sends_transactions === false, "builder must not send transactions");
  assert(source.calls_rpc === false, "builder must not call RPC");
  assert(source.accepts_deployer_private_keys === false, "builder must not accept deployer private keys");
  assert(source.reads_program_keypair_file === true, "builder should derive program id from program keypair file");
  assert(source.key_material_printed === false, "builder must not print key material");
  assert(source.full_rpc_url_persisted === false, "builder must not persist full RPC URL");
  assert(source.no_new_dependencies === true, "builder must not add dependencies");
  const text = JSON.stringify(handoff);
  assert(!text.includes("credential="), "handoff must not persist RPC query strings");
  assert(!text.includes("/sensitive/rpc"), "handoff must not persist full RPC paths");
  assert(!/"keypair_bytes"\s*:/.test(text), "handoff must not include program keypair byte arrays");
  return {
    ok: true,
    kind: "tasc.production_deploy.handoff.validation",
    version: "0.1",
    program_id: program.id,
    artifact_sha256: artifact.sha256,
    sends_transactions: false,
    calls_rpc: false,
    key_material_printed: false,
    no_new_dependencies: true,
  };
}

function build(options = {}) {
  const handoff = buildHandoff(options);
  validateHandoff(handoff);
  const out = path.resolve(options.out || DEFAULT_OUT);
  writeJson(out, handoff);
  return {
    ok: true,
    kind: "tasc.production_deploy.handoff.build_result",
    version: "0.1",
    handoff_file: rel(out),
    program_id: handoff.program.id,
    artifact_sha256: handoff.program.artifact.sha256,
    sends_transactions: false,
    calls_rpc: false,
    key_material_printed: false,
    full_rpc_url_persisted: false,
    no_new_dependencies: true,
  };
}

function plan(options = {}) {
  return {
    ok: true,
    kind: "tasc.production_deploy.handoff.plan",
    version: "0.1",
    goal: "prepare a sanitized Solana mainnet program deploy handoff before real 10 USDC funding",
    cluster: DEFAULT_CLUSTER,
    network_type: "mainnet",
    default_artifact: options.artifact || DEFAULT_ARTIFACT,
    default_manifest: options.manifest || DEFAULT_MANIFEST,
    default_program_keypair: options.programKeypair || DEFAULT_PROGRAM_KEYPAIR,
    default_output: options.out || DEFAULT_OUT,
    sends_transactions: false,
    calls_rpc: false,
    writes_files: false,
    accepts_deployer_private_keys: false,
    reads_program_keypair_file_on_build: true,
    key_material_printed: false,
    full_rpc_url_persisted: false,
    required_inputs: [
      "SBF artifact from npm run solana:build-sbf",
      "SBF manifest whose sha256 matches the artifact",
      "generated program-id keypair file with owner-private permissions",
      "mainnet deployer wallet with enough SOL, supplied to Solana CLI outside this handoff",
    ],
    commands: {
      build_handoff: "npm run real:deploy:build -- --production-rpc-url <mainnet-rpc-url> --expected-genesis-hash <mainnet-genesis-hash>",
      validate_handoff: "npm run real:deploy:validate -- .tascverifier/production-deploy-handoff.json",
      deploy_program: "solana program deploy build/solana/global_tasc_solana_program.so --program-id build/solana/global_tasc_solana_program-keypair.json --keypair <mainnet-deployer-keypair> --url <mainnet-rpc-url> --output json",
    },
  };
}

function sampleAddress(byte) {
  return base58Encode(Buffer.alloc(32, byte));
}

function writeProgramKeypair(file, publicKeyByte = 7) {
  const bytes = [...Buffer.alloc(32, 3), ...Buffer.alloc(32, publicKeyByte)];
  writeJson(file, bytes);
  fs.chmodSync(file, 0o600);
  return base58Encode(Buffer.alloc(32, publicKeyByte));
}

async function selfTest() {
  fs.mkdirSync(path.join(ROOT, ".tascverifier"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, ".tascverifier", "production-deploy-"));
  const artifactFile = path.join(dir, "global_tasc_solana_program.so");
  const manifestFile = path.join(dir, "solana-tasc.sbf.json");
  const keypairFile = path.join(dir, "global_tasc_solana_program-keypair.json");
  fs.writeFileSync(artifactFile, Buffer.from("fake-sbf-artifact-with-entrypoint"));
  const artifactSha = sha256File(artifactFile);
  const programId = writeProgramKeypair(keypairFile);
  writeJson(manifestFile, {
    ok: true,
    artifact: {
      path: rel(artifactFile),
      bytes: fs.statSync(artifactFile).size,
      sha256: artifactSha,
      entrypoint_symbol: {
        checked: true,
        ok: true,
      },
    },
    dependency_posture: {
      cargo_dependencies: [],
      npm_dependencies_added: false,
    },
  });

  const planResult = plan();
  assert(planResult.sends_transactions === false, "plan must not send transactions");
  assert(planResult.calls_rpc === false, "plan must not call RPC");
  assert(planResult.writes_files === false, "plan must not write files");

  const buildResult = build({
    artifact: artifactFile,
    manifest: manifestFile,
    programKeypair: keypairFile,
    programId,
    productionRpcUrl: "https://mainnet.example.com/sensitive/rpc?credential=do-not-store",
    expectedGenesisHash: "mainnet-self-test-genesis",
    out: path.join(dir, "production-deploy-handoff.json"),
  });
  assert(buildResult.ok === true, "build should succeed");
  const handoff = loadJson(path.join(dir, "production-deploy-handoff.json"));
  const validation = validateHandoff(handoff);
  assert(validation.ok === true, "validation should succeed");
  assert(handoff.program.id === programId, "program id should come from keypair public key");
  const handoffText = JSON.stringify(handoff);
  assert(!handoffText.includes("do-not-store"), "handoff must not store RPC query credential");
  assert(!handoffText.includes("/sensitive/rpc"), "handoff must not store full RPC path");

  let rejectedBadProgramId = false;
  try {
    buildHandoff({
      artifact: artifactFile,
      manifest: manifestFile,
      programKeypair: keypairFile,
      programId: sampleAddress(9),
    });
  } catch {
    rejectedBadProgramId = true;
  }
  assert(rejectedBadProgramId, "bad program id should be rejected");

  let rejectedManifestMismatch = false;
  const badManifest = path.join(dir, "bad-manifest.json");
  writeJson(badManifest, {
    ok: true,
    artifact: {
      path: rel(artifactFile),
      bytes: fs.statSync(artifactFile).size,
      sha256: "00".repeat(32),
      entrypoint_symbol: {
        checked: true,
        ok: true,
      },
    },
  });
  try {
    buildHandoff({
      artifact: artifactFile,
      manifest: badManifest,
      programKeypair: keypairFile,
    });
  } catch {
    rejectedManifestMismatch = true;
  }
  assert(rejectedManifestMismatch, "manifest mismatch should be rejected");

  let rejectedTestRpcHost = false;
  try {
    buildHandoff({
      artifact: artifactFile,
      manifest: manifestFile,
      programKeypair: keypairFile,
      productionRpcUrl: "https://api.devnet.solana.com",
    });
  } catch {
    rejectedTestRpcHost = true;
  }
  assert(rejectedTestRpcHost, "test RPC host should be rejected");

  return {
    ok: true,
    self_test: true,
    plan_safe: true,
    build_handoff: true,
    validate_handoff: true,
    program_id_from_keypair: true,
    rejected_bad_program_id: rejectedBadProgramId,
    rejected_manifest_mismatch: rejectedManifestMismatch,
    rejected_test_rpc_host: rejectedTestRpcHost,
    sends_transactions: false,
    calls_rpc: false,
    key_material_printed: false,
    rpc_url_persisted: false,
    no_new_dependencies: true,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    process.stdout.write(`${JSON.stringify(await selfTest(), null, 2)}\n`);
    return;
  }
  if (options.command === "plan") {
    process.stdout.write(`${JSON.stringify(plan(options), null, 2)}\n`);
    return;
  }
  if (options.command === "build") {
    process.stdout.write(`${JSON.stringify(build(options), null, 2)}\n`);
    return;
  }
  if (options.command === "validate") {
    assert(options.handoffFile, "validate requires a handoff file");
    process.stdout.write(`${JSON.stringify(validateHandoff(loadJson(options.handoffFile)), null, 2)}\n`);
    return;
  }
  usage();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`build-production-deploy-handoff: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  build,
  buildHandoff,
  plan,
  selfTest,
  validateHandoff,
};
