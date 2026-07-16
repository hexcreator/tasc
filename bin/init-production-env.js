#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { base58Decode, base58Encode } = require("./run-solana-devnet");
const { DEFAULT_ENV_FILE } = require("./production-env");
const { REQUIRED_ENV, validateProductionEnv } = require("./validate-production-env");
const { associatedTokenAddress } = require("./tascsolana-spl");

const TEMPLATE_FILE = ".env.example";
const DEFAULT_DEPLOY_HANDOFF = ".tascverifier/production-deploy-handoff.json";
const PRIVATE_KEY_RE = /(PRIVATE|SECRET|MNEMONIC|SEED|KEYPAIR|KEYPAIR_JSON|WALLET_KEY)/i;
const TEST_RPC_HOST_RE = /(devnet|testnet|localhost|127\.0\.0\.1|0\.0\.0\.0|(^|\.)example\.(com|net|org|invalid)$)/i;
const ENV_ORDER = [
  REQUIRED_ENV.rpcUrl,
  REQUIRED_ENV.expectedGenesisHash,
  REQUIRED_ENV.programId,
  REQUIRED_ENV.usdcMint,
  REQUIRED_ENV.buyer,
  REQUIRED_ENV.worker,
  REQUIRED_ENV.verifier,
  REQUIRED_ENV.buyerUsdc,
  REQUIRED_ENV.workerUsdc,
];
const PUBLIC_FLAGS = {
  "--expected-genesis-hash": REQUIRED_ENV.expectedGenesisHash,
  "--program-id": REQUIRED_ENV.programId,
  "--usdc-mint": REQUIRED_ENV.usdcMint,
  "--buyer": REQUIRED_ENV.buyer,
  "--worker": REQUIRED_ENV.worker,
  "--verifier": REQUIRED_ENV.verifier,
  "--buyer-usdc-token-account": REQUIRED_ENV.buyerUsdc,
  "--worker-usdc-token-account": REQUIRED_ENV.workerUsdc,
};

function usage() {
  console.error([
    "Usage:",
    "  node bin/init-production-env.js plan [options]",
    "  node bin/init-production-env.js init [options]",
    "  node bin/init-production-env.js --self-test",
    "",
    "Options:",
    "  --env <file>                         env file; default .env.solana-mainnet.local",
    "  --template <file>                    env template; default .env.example",
    "  --from-process-env                   copy required values from the current process env",
    "  --deploy-handoff <file>              public deploy handoff to read program id from",
    "  --no-deploy-handoff                  skip deploy-handoff program-id discovery",
    "  --no-derive-associated-token-accounts",
    "                                      skip standard buyer/worker USDC ATA derivation",
    "  --force                              overwrite selected non-empty keys",
    "  --expected-genesis-hash <hash>       public Solana mainnet genesis hash",
    "  --program-id <address>               public deployed program id",
    "  --usdc-mint <address>                public mainnet USDC mint",
    "  --buyer <address>                    public buyer wallet",
    "  --worker <address>                   public worker wallet",
    "  --verifier <address>                 public verifier wallet",
    "  --buyer-usdc-token-account <address> public buyer USDC token account",
    "  --worker-usdc-token-account <addr>   public worker USDC token account",
    "  --allow-test-rpc-host                allow devnet/test/local-looking RPC hosts for self-tests only",
    "",
    "This command creates only an ignored local env file. It never accepts private keys, never prints RPC URLs, never calls RPC, and never sends transactions.",
  ].join("\n"));
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requireValue(args, index, label) {
  const value = args[index] || "";
  if (!value) throw new Error(`${label} requires a value`);
  return value;
}

function parseArgs(argv) {
  for (const arg of argv) {
    if (PRIVATE_KEY_RE.test(arg)) throw new Error("private key, seed, mnemonic, and keypair inputs are not accepted");
  }
  const options = {
    command: "plan",
    envFile: DEFAULT_ENV_FILE,
    templateFile: TEMPLATE_FILE,
    deployHandoff: DEFAULT_DEPLOY_HANDOFF,
    useDeployHandoff: true,
    deriveAssociatedTokenAccounts: true,
    fromProcessEnv: false,
    force: false,
    publicValues: {},
    allowTestRpcHost: false,
    selfTest: false,
  };
  const args = [...argv];
  if (["plan", "init"].includes(args[0])) options.command = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--env") options.envFile = requireValue(args, ++i, arg);
    else if (arg === "--template") options.templateFile = requireValue(args, ++i, arg);
    else if (arg === "--from-process-env") options.fromProcessEnv = true;
    else if (arg === "--deploy-handoff") options.deployHandoff = requireValue(args, ++i, arg);
    else if (arg === "--no-deploy-handoff") options.useDeployHandoff = false;
    else if (arg === "--no-derive-associated-token-accounts") options.deriveAssociatedTokenAccounts = false;
    else if (arg === "--force") options.force = true;
    else if (arg === "--allow-test-rpc-host") options.allowTestRpcHost = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (PUBLIC_FLAGS[arg]) options.publicValues[PUBLIC_FLAGS[arg]] = requireValue(args, ++i, arg);
    else if (arg === "--help" || arg === "-h") usage();
    else usage();
  }
  return options;
}

function rel(file) {
  const absolute = path.resolve(file);
  const relative = path.relative(process.cwd(), absolute);
  return relative.startsWith("..") ? absolute : relative || ".";
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    env[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return env;
}

function envFileMode(file) {
  if (!fs.existsSync(file)) return null;
  return (fs.statSync(file).mode & 0o777).toString(8).padStart(3, "0");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertSolanaAddress(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} is required`);
  assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value), `${label} must be base58`);
  assert(base58Decode(value).length === 32, `${label} must decode to 32 bytes`);
  return value;
}

function assertHttpUrl(value, label, allowTestRpcHost = false) {
  assert(typeof value === "string" && value.length > 0, `${label} is required`);
  assert(!/[\r\n]/.test(value), `${label} must be one line`);
  const url = new URL(value);
  assert(url.protocol === "http:" || url.protocol === "https:", `${label} must be http(s)`);
  if (!allowTestRpcHost && TEST_RPC_HOST_RE.test(url.host)) {
    throw new Error(`${label} must not look like devnet/testnet/local/example`);
  }
  return url;
}

function assertEnvValue(key, value, options) {
  assert(!/[\r\n]/.test(value), `${key} must be one line`);
  if (key === REQUIRED_ENV.rpcUrl) assertHttpUrl(value, key, options.allowTestRpcHost);
  else assertSolanaAddress(value, key);
  return value;
}

function privateKeyKeys(env) {
  return Object.keys(env).filter((key) => env[key] && PRIVATE_KEY_RE.test(key));
}

function selectedValues(options, processEnv = process.env) {
  const values = {};
  const sources = {};
  function setCandidate(key, value, source) {
    if (!value) return;
    const normalized = String(value).trim();
    if (!normalized) return;
    assertEnvValue(key, normalized, options);
    values[key] = normalized;
    sources[key] = source;
  }

  if (options.fromProcessEnv) {
    for (const key of ENV_ORDER) setCandidate(key, processEnv[key] || "", "process-env");
  }
  if (options.useDeployHandoff && fs.existsSync(options.deployHandoff)) {
    const handoff = readJson(options.deployHandoff);
    setCandidate(REQUIRED_ENV.programId, handoff.program && handoff.program.id, `deploy-handoff:${rel(options.deployHandoff)}`);
  }
  for (const [key, value] of Object.entries(options.publicValues)) setCandidate(key, value, "cli-public-flag");
  if (options.deriveAssociatedTokenAccounts) {
    const effective = {
      ...loadEnvFile(options.envFile || DEFAULT_ENV_FILE),
      ...(options.fromProcessEnv ? processEnv : {}),
      ...values,
    };
    if (!values[REQUIRED_ENV.buyerUsdc] && (!effective[REQUIRED_ENV.buyerUsdc] || options.force) && effective[REQUIRED_ENV.buyer] && effective[REQUIRED_ENV.usdcMint]) {
      setCandidate(
        REQUIRED_ENV.buyerUsdc,
        associatedTokenAddress(effective[REQUIRED_ENV.buyer], effective[REQUIRED_ENV.usdcMint]),
        "associated-token-account:buyer+mint",
      );
    }
    if (!values[REQUIRED_ENV.workerUsdc] && (!effective[REQUIRED_ENV.workerUsdc] || options.force) && effective[REQUIRED_ENV.worker] && effective[REQUIRED_ENV.usdcMint]) {
      setCandidate(
        REQUIRED_ENV.workerUsdc,
        associatedTokenAddress(effective[REQUIRED_ENV.worker], effective[REQUIRED_ENV.usdcMint]),
        "associated-token-account:worker+mint",
      );
    }
  }
  return { values, sources };
}

function missingRequired(env, processEnv = {}) {
  return ENV_ORDER.filter((key) => !(env[key] || processEnv[key]));
}

function commandBlock(envFile) {
  return {
    env_init: `npm run real:env:init -- --env ${envFile}`,
    env_init_plan: `npm run real:env:init:plan -- --env ${envFile}`,
    env_plan: `npm run real:env:plan -- --env ${envFile}`,
    env_validate: `npm run real:env:validate -- --env ${envFile}`,
    preflight: `npm run real:preflight -- --env ${envFile}`,
    packet_build: `npm run real:packet:build -- --env ${envFile} --timed-proof examples/solana-devnet/proofs/<run-id>/proof-summary.json`,
  };
}

function baseTemplate(options) {
  if (fs.existsSync(options.envFile)) return fs.readFileSync(options.envFile, "utf8");
  if (fs.existsSync(options.templateFile)) return fs.readFileSync(options.templateFile, "utf8");
  return `${ENV_ORDER.map((key) => `${key}=`).join("\n")}\n`;
}

function updateEnvText(text, candidateValues, existingValues, force) {
  const seen = new Set();
  const updatedKeys = [];
  const preservedKeys = [];
  const lines = text.split(/\r?\n/).map((line) => {
    const match = line.match(/^(\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)(.*)$/);
    if (!match) return line;
    const [, prefix, key, rawValue] = match;
    if (!ENV_ORDER.includes(key)) return line;
    seen.add(key);
    if (!Object.prototype.hasOwnProperty.call(candidateValues, key)) return line;
    const currentValue = rawValue.trim();
    if (currentValue && !force) {
      preservedKeys.push(key);
      return line;
    }
    if (existingValues[key] && !force) {
      preservedKeys.push(key);
      return line;
    }
    updatedKeys.push(key);
    return `${prefix}${candidateValues[key]}`;
  });
  for (const key of ENV_ORDER) {
    if (seen.has(key)) continue;
    const value = candidateValues[key] || "";
    if (value) updatedKeys.push(key);
    lines.push(`${key}=${value}`);
  }
  return {
    text: `${lines.join("\n").replace(/\n*$/, "")}\n`,
    updatedKeys: [...new Set(updatedKeys)],
    preservedKeys: [...new Set(preservedKeys)],
  };
}

function initProductionEnv(options = {}, processEnv = process.env) {
  options = {
    command: "plan",
    envFile: DEFAULT_ENV_FILE,
    templateFile: TEMPLATE_FILE,
    deployHandoff: DEFAULT_DEPLOY_HANDOFF,
    useDeployHandoff: true,
    deriveAssociatedTokenAccounts: true,
    fromProcessEnv: false,
    force: false,
    publicValues: {},
    allowTestRpcHost: false,
    ...options,
  };
  const envFile = options.envFile || DEFAULT_ENV_FILE;
  const envExistsBefore = fs.existsSync(envFile);
  const existingValues = loadEnvFile(envFile);
  const privateKeys = privateKeyKeys(existingValues);
  if (privateKeys.length > 0) {
    throw new Error(`production env file contains private-key-like entries: ${privateKeys.join(", ")}`);
  }
  const selected = selectedValues(options, processEnv);
  const valuesBefore = { ...existingValues };
  const missingBefore = missingRequired(valuesBefore, options.fromProcessEnv ? processEnv : {});

  if (options.command === "plan") {
    return {
      ok: true,
      kind: "tasc.production_env.init_plan",
      version: "0.1",
      mode: "plan",
      env_file: rel(envFile),
      env_file_exists: envExistsBefore,
      env_file_mode_octal: envFileMode(envFile),
      template_file: rel(options.templateFile || TEMPLATE_FILE),
      template_file_exists: fs.existsSync(options.templateFile || TEMPLATE_FILE),
      deploy_handoff_file: options.useDeployHandoff ? rel(options.deployHandoff || DEFAULT_DEPLOY_HANDOFF) : null,
      deploy_handoff_exists: options.useDeployHandoff ? fs.existsSync(options.deployHandoff || DEFAULT_DEPLOY_HANDOFF) : false,
      derives_associated_token_accounts: options.deriveAssociatedTokenAccounts,
      writes_files: false,
      sends_transactions: false,
      calls_rpc: false,
      accepts_private_keys: false,
      accepts_rpc_url_cli: false,
      rpc_url_printed: false,
      full_rpc_url_persisted_in_json: false,
      selected_keys: Object.keys(selected.values),
      selected_key_sources: selected.sources,
      would_create_env_file: !envExistsBefore,
      would_chmod_0600: true,
      missing_required_keys_before: missingBefore,
      commands: commandBlock(rel(envFile)),
      no_new_dependencies: true,
    };
  }

  const template = baseTemplate(options);
  const updated = updateEnvText(template, selected.values, existingValues, options.force);
  fs.mkdirSync(path.dirname(path.resolve(envFile)), { recursive: true });
  fs.writeFileSync(envFile, updated.text, { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  const fileEnvAfter = loadEnvFile(envFile);
  const validation = validateProductionEnv({
    envFile,
    command: "validate",
    allowTestRpcHost: options.allowTestRpcHost,
  }, options.fromProcessEnv ? processEnv : {});
  return {
    ok: true,
    kind: "tasc.production_env.init",
    version: "0.1",
    mode: "init",
    env_file: rel(envFile),
    env_file_exists_before: envExistsBefore,
    env_file_exists_after: fs.existsSync(envFile),
    env_file_mode_octal: envFileMode(envFile),
    created_env_file: !envExistsBefore,
    updated_keys: updated.updatedKeys,
    preserved_keys: updated.preservedKeys,
    selected_keys: Object.keys(selected.values),
    selected_key_sources: selected.sources,
    missing_required_keys_after: missingRequired(fileEnvAfter, options.fromProcessEnv ? processEnv : {}),
    ready_for_preflight: validation.ready_for_preflight,
    ready_for_packet_build: validation.ready_for_packet_build,
    blockers: validation.blockers,
    warnings: validation.warnings,
    writes_files: true,
    sends_transactions: false,
    calls_rpc: false,
    accepts_private_keys: false,
    accepts_rpc_url_cli: false,
    rpc_url_printed: false,
    full_rpc_url_persisted_in_json: false,
    private_env_file_may_store_rpc_url: true,
    derives_associated_token_accounts: options.deriveAssociatedTokenAccounts,
    commands: commandBlock(rel(envFile)),
    no_new_dependencies: true,
  };
}

function sampleAddress(byte) {
  return base58Encode(Buffer.alloc(32, byte));
}

async function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasc-production-env-init-"));
  const envFile = path.join(dir, ".env.solana-mainnet.local");
  const templateFile = path.join(dir, ".env.example");
  const deployHandoff = path.join(dir, "production-deploy-handoff.json");
  fs.writeFileSync(templateFile, `${ENV_ORDER.map((key) => `${key}=`).join("\n")}\n`);
  fs.writeFileSync(deployHandoff, `${JSON.stringify({ program: { id: sampleAddress(3) } }, null, 2)}\n`);

  const sensitiveRpc = "https://mainnet.rpc.invalid/sensitive/path?api-key=do-not-print";
  const plan = initProductionEnv({
    command: "plan",
    envFile,
    templateFile,
    deployHandoff,
    fromProcessEnv: true,
    allowTestRpcHost: true,
  }, {
    [REQUIRED_ENV.rpcUrl]: sensitiveRpc,
    [REQUIRED_ENV.expectedGenesisHash]: sampleAddress(1),
    [REQUIRED_ENV.usdcMint]: sampleAddress(4),
    [REQUIRED_ENV.buyer]: sampleAddress(5),
    [REQUIRED_ENV.worker]: sampleAddress(6),
    [REQUIRED_ENV.verifier]: sampleAddress(7),
  });
  assert(plan.writes_files === false, "plan must not write files");
  assert(!fs.existsSync(envFile), "plan must not create env file");

  const result = initProductionEnv({
    command: "init",
    envFile,
    templateFile,
    deployHandoff,
    fromProcessEnv: true,
    allowTestRpcHost: true,
  }, {
    [REQUIRED_ENV.rpcUrl]: sensitiveRpc,
    [REQUIRED_ENV.expectedGenesisHash]: sampleAddress(1),
    [REQUIRED_ENV.usdcMint]: sampleAddress(4),
    [REQUIRED_ENV.buyer]: sampleAddress(5),
    [REQUIRED_ENV.worker]: sampleAddress(6),
    [REQUIRED_ENV.verifier]: sampleAddress(7),
  });
  assert(result.created_env_file === true, "init should create env file");
  assert(result.env_file_mode_octal === "600", "env file should be chmod 600");
  assert(result.updated_keys.includes(REQUIRED_ENV.rpcUrl), "RPC URL should be copied from process env when requested");
  assert(result.updated_keys.includes(REQUIRED_ENV.programId), "program id should be copied from deploy handoff");
  assert(result.updated_keys.includes(REQUIRED_ENV.buyerUsdc), "buyer USDC ATA should be derived from buyer and mint");
  assert(result.updated_keys.includes(REQUIRED_ENV.workerUsdc), "worker USDC ATA should be derived from worker and mint");
  const loaded = loadEnvFile(envFile);
  assert(loaded[REQUIRED_ENV.buyerUsdc] === associatedTokenAddress(sampleAddress(5), sampleAddress(4)), "buyer USDC ATA mismatch");
  assert(loaded[REQUIRED_ENV.workerUsdc] === associatedTokenAddress(sampleAddress(6), sampleAddress(4)), "worker USDC ATA mismatch");
  const serialized = JSON.stringify(result);
  assert(!serialized.includes("do-not-print"), "init result must not print RPC credential");
  assert(!serialized.includes("/sensitive/path"), "init result must not print RPC path");

  const preserveEnv = path.join(dir, "preserve.env");
  fs.writeFileSync(preserveEnv, `${REQUIRED_ENV.buyer}=${sampleAddress(11)}\n`);
  const preserve = initProductionEnv({
    command: "init",
    envFile: preserveEnv,
    templateFile,
    useDeployHandoff: false,
    publicValues: { [REQUIRED_ENV.buyer]: sampleAddress(12) },
  }, {});
  assert(preserve.preserved_keys.includes(REQUIRED_ENV.buyer), "existing values should be preserved by default");
  assert(loadEnvFile(preserveEnv)[REQUIRED_ENV.buyer] === sampleAddress(11), "preserved buyer should remain");

  const force = initProductionEnv({
    command: "init",
    envFile: preserveEnv,
    templateFile,
    useDeployHandoff: false,
    force: true,
    publicValues: { [REQUIRED_ENV.buyer]: sampleAddress(12) },
  }, {});
  assert(force.updated_keys.includes(REQUIRED_ENV.buyer), "force should overwrite selected keys");
  assert(loadEnvFile(preserveEnv)[REQUIRED_ENV.buyer] === sampleAddress(12), "forced buyer should be written");

  const noDeriveEnv = path.join(dir, "no-derive.env");
  const noDerive = initProductionEnv({
    command: "init",
    envFile: noDeriveEnv,
    templateFile,
    useDeployHandoff: false,
    deriveAssociatedTokenAccounts: false,
    publicValues: {
      [REQUIRED_ENV.usdcMint]: sampleAddress(4),
      [REQUIRED_ENV.buyer]: sampleAddress(5),
      [REQUIRED_ENV.worker]: sampleAddress(6),
    },
  }, {});
  assert(!noDerive.updated_keys.includes(REQUIRED_ENV.buyerUsdc), "ATA derivation should be skippable");

  const privateEnv = path.join(dir, "private.env");
  fs.writeFileSync(privateEnv, `${REQUIRED_ENV.buyer}= ${sampleAddress(13)}\nGLOBAL_TASC_SOLANA_MAINNET_BUYER_PRIVATE_KEY=never\n`);
  let privateRejected = false;
  try {
    initProductionEnv({ command: "init", envFile: privateEnv, templateFile, useDeployHandoff: false }, {});
  } catch (error) {
    privateRejected = /private-key-like/.test(error.message);
  }
  assert(privateRejected, "private-key-like env entries should be rejected");

  let privateFlagRejected = false;
  try {
    parseArgs(["init", "--buyer-private-key", "never"]);
  } catch (error) {
    privateFlagRejected = /private key/.test(error.message);
  }
  assert(privateFlagRejected, "private-key-like cli flags should be rejected");

  return {
    ok: true,
    self_test: true,
    plan_writes_files: plan.writes_files,
    created_env_file: result.created_env_file,
    chmod_0600: result.env_file_mode_octal === "600",
    deploy_handoff_program_id_loaded: result.updated_keys.includes(REQUIRED_ENV.programId),
    process_env_loaded: result.updated_keys.includes(REQUIRED_ENV.rpcUrl),
    associated_token_accounts_derived: result.updated_keys.includes(REQUIRED_ENV.buyerUsdc) && result.updated_keys.includes(REQUIRED_ENV.workerUsdc),
    associated_token_account_derivation_skippable: !noDerive.updated_keys.includes(REQUIRED_ENV.buyerUsdc),
    existing_values_preserved: preserve.preserved_keys.includes(REQUIRED_ENV.buyer),
    force_overwrite_supported: force.updated_keys.includes(REQUIRED_ENV.buyer),
    private_env_entries_rejected: privateRejected,
    private_cli_flags_rejected: privateFlagRejected,
    rpc_url_printed: false,
    no_new_dependencies: true,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    process.stdout.write(`${JSON.stringify(await selfTest(), null, 2)}\n`);
    return;
  }
  const result = initProductionEnv(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`init-production-env: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  initProductionEnv,
  parseArgs,
  selfTest,
};
