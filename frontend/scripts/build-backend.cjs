const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const frontendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(frontendRoot, "..");
const pythonBin = process.env.PYTHON || "python3";
const separator = process.platform === "win32" ? ";" : ":";
const backendDist = path.join(repoRoot, "build", "backend");
const pyinstallerWork = path.join(repoRoot, "build", "pyinstaller");
const pyinstallerConfig = path.join(repoRoot, "build", "pyinstaller-config");
const backendName = "ai-culling-backend";
const staticDir = path.join(repoRoot, "static");
const templatesDir = path.join(repoRoot, "templates");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

fs.rmSync(backendDist, { recursive: true, force: true });
fs.mkdirSync(backendDist, { recursive: true });
fs.mkdirSync(pyinstallerWork, { recursive: true });
fs.mkdirSync(pyinstallerConfig, { recursive: true });

process.env.PYINSTALLER_CONFIG_DIR = pyinstallerConfig;

run(pythonBin, [
  "-m",
  "PyInstaller",
  "--noconfirm",
  "--clean",
  "--name",
  backendName,
  "--onefile",
  "--distpath",
  backendDist,
  "--workpath",
  pyinstallerWork,
  "--specpath",
  pyinstallerWork,
  "--add-data",
  `${staticDir}${separator}static`,
  "--add-data",
  `${templatesDir}${separator}templates`,
  "--exclude-module",
  "pyiqa",
  "--exclude-module",
  "torch",
  "--exclude-module",
  "torchvision",
  "--exclude-module",
  "open_clip",
  "--exclude-module",
  "faiss",
  "--exclude-module",
  "tensorflow",
  "--exclude-module",
  "matplotlib",
  "--exclude-module",
  "pandas",
  "--exclude-module",
  "scipy",
  "app.py",
]);
