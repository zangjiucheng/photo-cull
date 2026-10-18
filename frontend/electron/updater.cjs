const { app, dialog, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { compareVersions, normalizeAssetName, parseChecksums, selectZipAsset } = require("./update-utils.cjs");

// Builds are not Developer ID signed, so Squirrel.Mac (electron-updater) cannot be used. Instead the
// release zip is downloaded, checked against the published SHA256SUMS.txt, and swapped in for the
// running .app bundle by a small shell script once this process exits.
const releaseRepo = "zangjiucheng/photo-cull";
const latestReleaseUrl = `https://api.github.com/repos/${releaseRepo}/releases/latest`;
const startupCheckDelayMs = 5000;

let getWindow = () => null;
let checking = false;
let downloading = false;
// Set once an update has been downloaded and extracted; installed on restart or on the next quit.
let pendingInstall = null;
let installScheduled = false;

function updaterStatePath() {
  return path.join(app.getPath("userData"), "updater.json");
}

function readUpdaterState() {
  try {
    return JSON.parse(fs.readFileSync(updaterStatePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeUpdaterState(updates) {
  const state = { ...readUpdaterState(), ...updates };
  fs.mkdirSync(path.dirname(updaterStatePath()), { recursive: true });
  fs.writeFileSync(updaterStatePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function writeUpdaterLog(message) {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "updater.log"), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Logging must never break the app.
  }
}

function updatesSupported() {
  return app.isPackaged && process.platform === "darwin" && !process.env.AI_CULLING_DISABLE_UPDATES;
}

function currentBundlePath() {
  // .../AI Photo Culling.app/Contents/MacOS/AI Photo Culling
  return path.resolve(path.dirname(process.execPath), "..", "..");
}

// Returns a user-facing reason when the running bundle cannot be replaced in place.
function bundleNotReplaceableReason(bundlePath) {
  if (!bundlePath.endsWith(".app")) {
    return "The running app is not inside an .app bundle.";
  }
  if (bundlePath.includes("/AppTranslocation/") || bundlePath.startsWith("/Volumes/")) {
    return "Move AI Photo Culling to the Applications folder, then open it from there to enable updates.";
  }
  try {
    fs.accessSync(path.dirname(bundlePath), fs.constants.W_OK);
    fs.accessSync(bundlePath, fs.constants.W_OK);
  } catch {
    return `No permission to replace ${bundlePath}.`;
  }
  return null;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `${app.getName()}/${app.getVersion()}`,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub responded ${response.status} for ${url}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "User-Agent": `${app.getName()}/${app.getVersion()}` } });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  return response.text();
}

async function downloadFile(url, targetPath, onProgress) {
  const response = await fetch(url, { headers: { "User-Agent": `${app.getName()}/${app.getVersion()}` } });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const output = fs.createWriteStream(targetPath);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!output.write(chunk)) {
        await new Promise((resolve) => output.once("drain", resolve));
      }
      if (total) {
        onProgress(received / total);
      }
    }
  } finally {
    await new Promise((resolve) => output.end(resolve));
  }
  return hash.digest("hex");
}

function runChecked(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout;
}

async function fetchLatestRelease() {
  const release = await fetchJson(latestReleaseUrl);
  const version = String(release.tag_name || "").replace(/^v/, "");
  return {
    version,
    notes: String(release.body || "").trim(),
    url: release.html_url,
    zip: selectZipAsset(release.assets, process.arch),
    checksums: (release.assets || []).find((asset) => asset.name === "SHA256SUMS.txt") || null,
  };
}

function releaseNotesPreview(notes) {
  const preview = notes.split(/\r?\n/).filter((line) => line.trim()).slice(0, 12).join("\n");
  return preview.length > 900 ? `${preview.slice(0, 900)}…` : preview;
}

async function showMessage(options) {
  const win = getWindow();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

async function downloadAndStage(release) {
  const win = getWindow();
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-culling-update-"));
  const zipPath = path.join(stagingDir, normalizeAssetName(release.zip.name));
  downloading = true;
  try {
    const checksums = parseChecksums(await fetchText(release.checksums.browser_download_url));
    const expected = checksums.get(normalizeAssetName(release.zip.name));
    if (!expected) {
      throw new Error(`SHA256SUMS.txt has no entry for ${release.zip.name}.`);
    }

    writeUpdaterLog(`downloading ${release.zip.browser_download_url}`);
    const actual = await downloadFile(release.zip.browser_download_url, zipPath, (fraction) => {
      win?.setProgressBar(fraction);
    });
    if (actual !== expected) {
      throw new Error(`Checksum mismatch for ${release.zip.name} (expected ${expected}, got ${actual}).`);
    }

    const extractDir = path.join(stagingDir, "app");
    runChecked("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir]);
    fs.rmSync(zipPath, { force: true });
    const bundleName = fs.readdirSync(extractDir).find((name) => name.endsWith(".app"));
    if (!bundleName) {
      throw new Error("The downloaded update does not contain an .app bundle.");
    }
    const newBundlePath = path.join(extractDir, bundleName);
    const bundleVersion = runChecked("/usr/bin/plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      path.join(newBundlePath, "Contents", "Info.plist"),
    ]).trim();
    if (compareVersions(bundleVersion, release.version) !== 0) {
      throw new Error(`The downloaded app reports version ${bundleVersion}, expected ${release.version}.`);
    }
    spawnSync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", newBundlePath]);
    writeUpdaterLog(`staged ${release.version} at ${newBundlePath}`);
    return { version: release.version, stagingDir, newBundlePath };
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  } finally {
    downloading = false;
    win?.setProgressBar(-1);
  }
}

// Spawns a detached script that waits for this process to exit, swaps the bundle, and optionally relaunches.
function scheduleInstall(relaunch) {
  if (!pendingInstall || installScheduled) {
    return;
  }
  installScheduled = true;
  const targetBundlePath = currentBundlePath();
  const backupPath = path.join(pendingInstall.stagingDir, "previous.app");
  const logPath = path.join(app.getPath("userData"), "updater.log");
  const script = [
    "pid=\"$1\"; new_app=\"$2\"; target=\"$3\"; backup=\"$4\"; relaunch=\"$5\"; staging=\"$6\"",
    "for _ in $(seq 1 120); do kill -0 \"$pid\" 2>/dev/null || break; sleep 0.5; done",
    "if mv \"$target\" \"$backup\" && mv \"$new_app\" \"$target\"; then",
    "  echo \"installed update into $target\"",
    "  rm -rf \"$staging\"",
    "else",
    "  echo \"update install failed; restoring previous app\"",
    "  [ -d \"$target\" ] || mv \"$backup\" \"$target\"",
    "fi",
    "[ \"$relaunch\" = 1 ] && /usr/bin/open \"$target\"",
    "exit 0",
  ].join("\n");
  const logFd = fs.openSync(logPath, "a");
  const child = spawn("/bin/bash", [
    "-c",
    script,
    "ai-culling-update",
    String(process.pid),
    pendingInstall.newBundlePath,
    targetBundlePath,
    backupPath,
    relaunch ? "1" : "0",
    pendingInstall.stagingDir,
  ], { detached: true, stdio: ["ignore", logFd, logFd] });
  child.unref();
  fs.closeSync(logFd);
  writeUpdaterLog(`scheduled install of ${pendingInstall.version} (relaunch=${relaunch})`);
}

async function promptRestart() {
  const { response } = await showMessage({
    type: "info",
    buttons: ["Restart Now", "Install on Quit"],
    defaultId: 0,
    cancelId: 1,
    message: `AI Photo Culling ${pendingInstall.version} is ready to install.`,
    detail: "Restart now to finish updating, or the update will be installed the next time you quit.",
  });
  if (response === 0) {
    scheduleInstall(true);
    app.quit();
  }
}

async function checkForUpdates({ manual = false } = {}) {
  if (!updatesSupported()) {
    if (manual) {
      await showMessage({ type: "info", message: "Updates are only available in the packaged macOS app." });
    }
    return;
  }
  if (pendingInstall) {
    await promptRestart();
    return;
  }
  if (checking || downloading) {
    return;
  }
  checking = true;
  let userStartedUpdate = false;
  try {
    const currentVersion = app.getVersion();
    const release = await fetchLatestRelease();
    writeUpdaterLog(`current=${currentVersion} latest=${release.version}`);
    if (compareVersions(release.version, currentVersion) <= 0) {
      if (manual) {
        await showMessage({ type: "info", message: "You're up to date.", detail: `AI Photo Culling ${currentVersion} is the latest version.` });
      }
      return;
    }
    if (!manual && readUpdaterState().skippedVersion === release.version) {
      return;
    }

    const notReplaceable = bundleNotReplaceableReason(currentBundlePath());
    const canInstall = !notReplaceable && release.zip && release.checksums;
    const notes = releaseNotesPreview(release.notes);
    const { response } = await showMessage({
      type: "info",
      buttons: canInstall ? ["Update", "Later", "Skip This Version"] : ["Open Release Page", "Later", "Skip This Version"],
      defaultId: 0,
      cancelId: 1,
      message: `AI Photo Culling ${release.version} is available.`,
      detail: [
        `You have ${currentVersion}.`,
        notes,
        canInstall ? "" : notReplaceable || "This release has no automatic update package; download it from the release page.",
      ].filter(Boolean).join("\n\n"),
    });
    if (response === 2) {
      writeUpdaterState({ skippedVersion: release.version });
      return;
    }
    if (response !== 0) {
      return;
    }
    if (!canInstall) {
      await shell.openExternal(release.url);
      return;
    }

    userStartedUpdate = true;
    pendingInstall = await downloadAndStage(release);
    await promptRestart();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeUpdaterLog(`error: ${message}`);
    if (manual || userStartedUpdate) {
      await showMessage({ type: "error", message: "Could not update AI Photo Culling.", detail: message });
    }
  } finally {
    checking = false;
  }
}

function initUpdater(options) {
  getWindow = options.getWindow;
  if (!updatesSupported()) {
    return;
  }
  app.on("will-quit", () => scheduleInstall(false));
  setTimeout(() => {
    checkForUpdates().catch((error) => writeUpdaterLog(`startup check failed: ${error.message}`));
  }, startupCheckDelayMs);
}

module.exports = {
  checkForUpdates,
  initUpdater,
};
