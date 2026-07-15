#!/usr/bin/env node

const fs = require("fs");

const ALLOWED_DIRECT_DEV_DEPENDENCIES = new Set(["ethers", "solc"]);
const REQUIRED_OVERRIDES = {
  tmp: "0.2.7",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main() {
  const pkg = loadJson("package.json");
  const lock = loadJson("package-lock.json");
  const direct = Object.keys(pkg.devDependencies || {});
  const disallowed = direct.filter((name) => !ALLOWED_DIRECT_DEV_DEPENDENCIES.has(name));
  assert(disallowed.length === 0, `disallowed direct dev dependencies: ${disallowed.join(", ")}`);
  assert(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, "production dependencies should stay empty for now");

  for (const [name, version] of Object.entries(REQUIRED_OVERRIDES)) {
    assert(pkg.overrides?.[name] === version, `package.json must override ${name} to ${version}`);
  }

  const packages = lock.packages || {};
  assert(!packages["node_modules/ganache"], "ganache must not be present in package-lock");
  assert(packages["node_modules/tmp"]?.version === REQUIRED_OVERRIDES.tmp, `tmp lockfile version must be ${REQUIRED_OVERRIDES.tmp}`);

  const missingIntegrity = Object.entries(packages)
    .filter(([name]) => name !== "")
    .filter(([, entry]) => !entry.link && !entry.integrity)
    .map(([name]) => name);
  assert(missingIntegrity.length === 0, `lockfile packages missing integrity: ${missingIntegrity.join(", ")}`);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    direct_dev_dependencies: direct,
    production_dependencies: Object.keys(pkg.dependencies || {}),
    required_overrides: REQUIRED_OVERRIDES,
    lockfile_packages: Object.keys(packages).length - 1,
    note: "Offline dependency policy passed. Run npm audit and npm audit signatures for current registry advisory/signature checks.",
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`validate-dependencies: ${error.message}`);
    process.exit(1);
  }
}
