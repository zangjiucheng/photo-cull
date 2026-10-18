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

// torch's Windows DLLs need the Visual C++ runtime, which a clean Windows lacks. Ship Microsoft's
// redistributable DLLs (Visual Studio's VC\Redist folder, meant for app-local deployment) so the AI
// runtime can place them next to torch without an admin install.
function collectVcRuntime() {
  const target = path.join(repoRoot, "build", "vc-runtime");
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  const install = fs.existsSync(vswhere)
    ? spawnSync(vswhere, ["-latest", "-products", "*", "-property", "installationPath"], { encoding: "utf8" }).stdout.trim()
    : "";
  const redist = install && path.join(install, "VC", "Redist", "MSVC");
  const versions = redist && fs.existsSync(redist)
    ? fs.readdirSync(redist).filter((name) => /^\d+\./.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    : [];
  for (const version of versions) {
    const x64 = path.join(redist, version, "x64");
    const crt = fs.existsSync(x64) && fs.readdirSync(x64).find((name) => /^Microsoft\.VC\d+\.CRT$/.test(name));
    if (!crt) continue;
    const dlls = fs.readdirSync(path.join(x64, crt)).filter((name) => name.toLowerCase().endsWith(".dll"));
    for (const name of dlls) fs.copyFileSync(path.join(x64, crt, name), path.join(target, name));
    console.log(`Bundling the Visual C++ runtime from ${path.join(x64, crt)}: ${dlls.join(", ")}`);
    return;
  }
  throw new Error("Visual C++ runtime DLLs not found. Install Visual Studio Build Tools with the C++ workload.");
}

if (process.argv.includes("--win")) collectVcRuntime();
const { writeBuildInfo, describeBuild } = require("../electron/build-info.cjs");
const buildInfo = writeBuildInfo(repoRoot);
console.log(`Packaging ${describeBuild(require("../package.json").version, buildInfo)}`);
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
