const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const appName = "AI Photo Culling";
const bundleIdentifier = "com.ai-photo-culling.dev";
const frontendRoot = path.resolve(__dirname, "..");
const mainEntry = path.join(frontendRoot, "electron", "main.cjs");

function patchPlist(plistPath) {
  let plist = fs.readFileSync(plistPath, "utf8");
  const replacements = new Map([
    ["CFBundleDisplayName", appName],
    ["CFBundleIdentifier", bundleIdentifier],
  ]);

  for (const [key, value] of replacements) {
    plist = plist.replace(
      new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`),
      `$1${value}$3`
    );
  }

  fs.writeFileSync(plistPath, plist);
}

function signMacBundle(appPath) {
  const result = spawnSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to codesign ${appPath}: ${result.stderr || result.stdout}`);
  }
}

function copyMacBundle(sourceApp, targetApp) {
  const result = spawnSync("ditto", [sourceApp, targetApp], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to copy Electron app bundle: ${result.stderr || result.stdout}`);
  }
}

function launchMac() {
  const electronExecutable = require("electron");
  const sourceApp = path.resolve(electronExecutable, "..", "..", "..");
  const targetApp = path.join(frontendRoot, ".electron-dev", `${appName}.app`);
  const icuDataPath = path.join(sourceApp, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources", "icudtl.dat");

  if (!fs.existsSync(icuDataPath)) {
    throw new Error(`Electron app bundle is missing ICU data: ${icuDataPath}`);
  }

  fs.rmSync(targetApp, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetApp), { recursive: true });
  copyMacBundle(sourceApp, targetApp);
  patchPlist(path.join(targetApp, "Contents", "Info.plist"));
  signMacBundle(targetApp);

  const brandedExecutable = path.join(targetApp, "Contents", "MacOS", "Electron");
  return spawn(brandedExecutable, [mainEntry], {
    cwd: frontendRoot,
    env: process.env,
    stdio: "inherit",
  });
}

function launchDefault() {
  const electronExecutable = require("electron");
  return spawn(electronExecutable, [mainEntry], {
    cwd: frontendRoot,
    env: process.env,
    stdio: "inherit",
  });
}

const child = process.platform === "darwin" ? launchMac() : launchDefault();

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
