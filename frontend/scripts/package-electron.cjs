const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const frontendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(frontendRoot, "..");
const electronCache = path.join(repoRoot, "build", "electron-cache");
const electronBuilderCache = path.join(repoRoot, "build", "electron-builder-cache");
const electronBuilderBin = path.join(
  frontendRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
);

fs.mkdirSync(electronCache, { recursive: true });
fs.mkdirSync(electronBuilderCache, { recursive: true });

const result = spawnSync(electronBuilderBin, process.argv.slice(2), {
  cwd: frontendRoot,
  stdio: "inherit",
  // Node refuses to spawn .cmd files without a shell on Windows.
  shell: process.platform === "win32",
  env: {
    ...process.env,
    ELECTRON_CACHE: electronCache,
    ELECTRON_BUILDER_CACHE: electronBuilderCache,
    CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY || "false",
  },
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
