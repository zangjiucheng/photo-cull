const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const {
  downloadVerified,
  findRuntimePython,
  isSupported,
  managedPythonBuild,
  managedPythonExecutable,
  parseVersion,
  SUPPORTED_LABEL,
  describe: describePython,
  systemTar,
} = require("./python-runtime.cjs");
const { checkForUpdates, initUpdater, updatesSupported } = require("./updater.cjs");
const { describeBuild, readBuildInfo } = require("./build-info.cjs");

const appName = "AI Photo Culling";
app.setName(appName);
app.setAboutPanelOptions({ applicationName: appName });

const isPackaged = app.isPackaged;
const repoRoot = isPackaged ? process.resourcesPath : path.resolve(__dirname, "..", "..");
const backendHost = process.env.FLASK_HOST || "127.0.0.1";
const configuredBackendPort = process.env.FLASK_PORT ? Number(process.env.FLASK_PORT) : null;
let backendPort = configuredBackendPort || 5050;
const packagedBackendName = process.platform === "win32" ? "ai-culling-backend.exe" : "ai-culling-backend";
const packagedBackendPath = path.join(process.resourcesPath, "backend", packagedBackendName);
const hasPackagedBackend = isPackaged && fs.existsSync(packagedBackendPath);
const pythonBin = process.env.PYTHON || "python3";
const backendEntry = process.env.BACKEND_ENTRY
  ? path.resolve(repoRoot, process.env.BACKEND_ENTRY)
  : path.join(repoRoot, "app.py");
const runtimeSourcePath = isPackaged ? path.join(process.resourcesPath, "runtime-source") : repoRoot;
const appIconPath = path.join(__dirname, "assets", process.platform === "win32" ? "icon-win.png" : "icon.png");
let backendProcess = null;
let backendLogFd = null;
let mainWindow = null;
let aiRuntimePublishTimer = null;
const aiRuntime = {
  installing: false,
  state: "idle",
  message: "AI runtime is not installed.",
  detail: "",
  error: "",
};

function setAiRuntimeStatus(updates) {
  Object.assign(aiRuntime, updates);
  publishAiRuntimeStatus();
}

function configureApplicationMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{
      label: appName,
      submenu: [
        { label: `About ${appName}`, click: () => void showAbout() },
        { label: "Check for Updates...", click: () => checkForUpdates({ manual: true }) },
        { type: "separator" },
        { label: "Settings...", accelerator: "Cmd+,", click: openSettings },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: `Hide ${appName}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: `Quit ${appName}` },
      ],
    }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Save Workspace File...",
          accelerator: "CmdOrCtrl+S",
          click: (_menuItem, browserWindow) => {
            const targetWindow = browserWindow || BrowserWindow.getFocusedWindow();
            targetWindow?.webContents.send("save-workspace-file-request");
          },
        },
        { type: "separator" },
        { label: "Back Up Library...", click: () => void backupLibrary() },
        { label: "Restore Library...", click: () => void restoreLibrary() },
        ...(process.platform === "darwin" ? [] : [
          { type: "separator" },
          { label: "Settings...", accelerator: "Ctrl+,", click: openSettings },
          { type: "separator" },
          { role: "quit", label: "Exit" },
        ]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "close" },
      ],
    },
    // macOS keeps update checks in the app menu; elsewhere they live under Help.
    ...(process.platform === "darwin" ? [] : [{
      label: "Help",
      submenu: [
        { label: "Check for Updates...", click: () => checkForUpdates({ manual: true }) },
        { type: "separator" },
        { label: `About ${appName}`, click: () => void showAbout() },
      ],
    }]),
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openSettings() {
  (BrowserWindow.getFocusedWindow() || mainWindow)?.webContents.send("open-settings-request");
}

// App preferences that live outside the library database (they are about this machine).
function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readSettings() {
  try {
    return { pythonPath: null, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) };
  } catch {
    return { pythonPath: null };
  }
}

// A nightly build stays on nightlies until the user picks a channel.
function updateChannel() {
  const chosen = readSettings().updateChannel;
  if (chosen === "stable" || chosen === "nightly") return chosen;
  return app.getVersion().includes("-nightly") ? "nightly" : "stable";
}

let cachedBuildInfo = null;
function buildInfo() {
  cachedBuildInfo ||= readBuildInfo(path.resolve(__dirname, "..", ".."));
  return cachedBuildInfo;
}

function versionLabel() {
  return describeBuild(app.getVersion(), buildInfo());
}

async function showAbout() {
  const options = {
    type: "info",
    buttons: ["OK", "Copy Version"],
    defaultId: 0,
    message: appName,
    detail: `Version ${versionLabel()}\nUpdate channel: ${updateChannel()}`,
  };
  const { response } = await (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options));
  if (response === 1) clipboard.writeText(versionLabel());
}

function updateSettings() {
  const info = buildInfo();
  return {
    channel: updateChannel(),
    version: app.getVersion(),
    commit: info.commit,
    dirty: Boolean(info.dirty),
    builtAt: info.builtAt,
    label: versionLabel(),
    supported: updatesSupported(),
  };
}

function writeSettings(updates) {
  const next = { ...readSettings(), ...updates };
  const partial = `${settingsPath()}.partial`;
  fs.mkdirSync(path.dirname(partial), { recursive: true });
  fs.writeFileSync(partial, JSON.stringify(next, null, 2));
  fs.renameSync(partial, settingsPath());
  return next;
}

async function backendJson(pathname, body) {
  const response = await fetch(`http://${backendHost}:${backendPort}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

function describeBackup(manifest) {
  const c = manifest.counts || {};
  const when = manifest.createdAt ? new Date(manifest.createdAt * 1000).toLocaleString() : "an unknown date";
  return [
    `Made ${when} by version ${manifest.appVersion || "unknown"}.`,
    `${c.workspaces ?? 0} workspaces, ${c.photos ?? 0} photos, ${c.recipes ?? 0} edits, ${c.presets ?? 0} presets, ${c.snapshots ?? 0} versions.`,
    "Original photos are not part of a backup; workspaces point at their folders.",
  ].join("\n");
}

// Library backups: a consistent copy of the database plus a manifest, never the photos.
async function backupLibrary() {
  const stamp = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Back Up Library",
    defaultPath: path.join(app.getPath("documents"), `Photo Cull Backup ${stamp}.zip`),
    filters: [{ name: "Photo Cull backup", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePath) return;
  try {
    const manifest = await backendJson("/api/backup", { destination: result.filePath });
    await dialog.showMessageBox(mainWindow, { type: "info", message: "Library backed up.", detail: `${describeBackup(manifest)}\n\nSaved to ${result.filePath}` });
  } catch (error) {
    dialog.showErrorBox("Backup failed", error instanceof Error ? error.message : String(error));
  }
}

async function restoreLibrary() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Restore Library",
    properties: ["openFile"],
    filters: [{ name: "Photo Cull backup", extensions: ["zip"] }],
  });
  const file = result.filePaths[0];
  if (result.canceled || !file) return;
  try {
    const manifest = await backendJson("/api/backup/inspect", { path: file });
    const missing = manifest.missingFolders
      ? `\n\n${manifest.missingFolders} workspace folder(s) are not on this computer; you can reconnect them from the start screen.`
      : "";
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: ["Restore", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Replace the current library with this backup?",
      detail: `${describeBackup(manifest)}${missing}\n\nThe current library is kept as a copy next to it.`,
    });
    if (response !== 0) return;
    const restored = await backendJson("/api/backup/restore", { path: file });
    mainWindow?.webContents.reload();
    await dialog.showMessageBox(mainWindow, {
      type: "info",
      message: "Library restored.",
      detail: restored.previousLibrary ? `The previous library was saved as ${restored.previousLibrary}.` : "",
    });
  } catch (error) {
    dialog.showErrorBox("Restore failed", error instanceof Error ? error.message : String(error));
  }
}

function prepareDbPath() {
  if (process.env.DB_PATH) {
    return process.env.DB_PATH;
  }

  const dbPath = path.join(app.getPath("userData"), "ai_culling.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  if (!fs.existsSync(dbPath)) {
    const legacyPaths = [
      path.join(repoRoot, "data", "ai_culling.db"),
      path.join(repoRoot, "ai_culling.db"),
    ];
    const legacyPath = legacyPaths.find((candidate) => fs.existsSync(candidate));
    if (legacyPath) {
      fs.renameSync(legacyPath, dbPath);
    }
  }

  process.env.DB_PATH = dbPath;
  return dbPath;
}

function prepareUserDataDir(name) {
  const targetPath = path.join(app.getPath("userData"), name);
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

function aiRuntimeDir() {
  return path.join(app.getPath("userData"), "ai-runtime");
}

function aiRuntimeVenvDir() {
  return path.join(aiRuntimeDir(), "venv");
}

function aiRuntimeMarkerPath() {
  return path.join(aiRuntimeDir(), "installed.json");
}

function aiRuntimeModelDir() {
  return path.join(aiRuntimeDir(), "models");
}

function runtimePythonPath() {
  return process.platform === "win32"
    ? path.join(aiRuntimeVenvDir(), "Scripts", "python.exe")
    : path.join(aiRuntimeVenvDir(), "bin", "python");
}

function runtimeInstalled() {
  return fs.existsSync(aiRuntimeMarkerPath()) && fs.existsSync(runtimePythonPath());
}

function useAiRuntimeBackend() {
  return runtimeInstalled() && fs.existsSync(path.join(runtimeSourcePath, "app.py"));
}

function aiRuntimePublicStatus() {
  const logPath = path.join(app.getPath("userData"), "ai-runtime-install.log");
  return {
    available: isPackaged || fs.existsSync(path.join(runtimeSourcePath, "requirements-ai.txt")),
    installed: runtimeInstalled(),
    installing: aiRuntime.installing,
    using: useAiRuntimeBackend() && backendProcess !== null,
    state: aiRuntime.state,
    message: runtimeInstalled() ? "Advanced AI runtime is installed." : aiRuntime.message,
    detail: aiRuntime.detail,
    error: aiRuntime.error,
    logPath,
    logTail: tailFile(logPath),
  };
}

function publishAiRuntimeStatus() {
  mainWindow?.webContents.send("ai-runtime-status", aiRuntimePublicStatus());
}

function scheduleAiRuntimeStatusPublish() {
  if (aiRuntimePublishTimer) {
    return;
  }
  aiRuntimePublishTimer = setTimeout(() => {
    aiRuntimePublishTimer = null;
    publishAiRuntimeStatus();
  }, 500);
}

function tailFile(filePath, maxLines = 14) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-maxLines);
}

function writeAiRuntimeLog(message) {
  fs.mkdirSync(aiRuntimeDir(), { recursive: true });
  fs.appendFileSync(path.join(app.getPath("userData"), "ai-runtime-install.log"), `${message}\n`);
  scheduleAiRuntimeStatusPublish();
}

function runLogged(command, args, options = {}) {
  writeAiRuntimeLog(`$ ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || runtimeSourcePath,
      env: {
        ...process.env,
        PATH: runtimeSearchPath(),
        PYTHONUNBUFFERED: "1",
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        ...(options.env || {}),
      },
    });
    child.stdout.on("data", (chunk) => writeAiRuntimeLog(String(chunk).trimEnd()));
    child.stderr.on("data", (chunk) => writeAiRuntimeLog(String(chunk).trimEnd()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code}`));
    });
  });
}

function closeBackendLog() {
  if (backendLogFd) {
    fs.closeSync(backendLogFd);
    backendLogFd = null;
  }
}

function runtimeSearchPath() {
  const extraPaths = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/Library/Frameworks/Python.framework/Versions/Current/bin",
  ];
  return [...extraPaths, process.env.PATH || ""].filter(Boolean).join(path.delimiter);
}

function pythonVersion(candidate) {
  const result = spawnSync(candidate.command, [
    ...candidate.args,
    "-c",
    "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')",
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      PATH: runtimeSearchPath(),
    },
  });
  // The Windows Store "python" alias exits non-zero without printing a version.
  return result.status === 0 ? parseVersion(result.stdout) : null;
}

function managedPythonDir() {
  return path.join(aiRuntimeDir(), "python-dist");
}

// A relocatable CPython the app downloads for itself when the system has no suitable Python.
async function ensureManagedPython() {
  const build = managedPythonBuild();
  if (!build) {
    throw new Error("No downloadable Python is available for this platform; install Python 3.10–3.13 and try again.");
  }
  const dir = managedPythonDir();
  const executable = { command: managedPythonExecutable(dir), args: [] };
  if (fs.existsSync(executable.command)) {
    const version = pythonVersion(executable);
    if (isSupported(version)) return { ...executable, version };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, "python.tar.gz");
  const sizeMb = Math.round(build.bytes / 1e6);
  setAiRuntimeStatus({ detail: `Downloading Python ${build.version} (${sizeMb} MB)` });
  writeAiRuntimeLog(`[python] no suitable Python installed; downloading ${build.url}`);
  let shown = -5;
  await downloadVerified(build.url, archive, build.sha256, (fraction) => {
    const percent = Math.floor(fraction * 100);
    if (percent >= shown + 5) {
      shown = percent;
      setAiRuntimeStatus({ detail: `Downloading Python ${build.version} (${sizeMb} MB) ${percent}%` });
    }
  });
  setAiRuntimeStatus({ detail: `Unpacking Python ${build.version}` });
  // tar ships with macOS and with Windows 10 and later (System32\\tar.exe).
  await runLogged(systemTar(), ["-xzf", archive, "-C", dir], { cwd: dir });
  fs.rmSync(archive, { force: true });
  const version = pythonVersion(executable);
  if (!isSupported(version)) {
    throw new Error(`The downloaded Python did not start (${executable.command}).`);
  }
  writeAiRuntimeLog(`[python] using downloaded Python ${version.label} at ${executable.command}`);
  return { ...executable, version };
}

async function basePython() {
  const custom = readSettings().pythonPath;
  try {
    return findRuntimePython({ probe: pythonVersion, log: writeAiRuntimeLog, custom });
  } catch (error) {
    // A Python named in AI_RUNTIME_PYTHON or Settings is the user's choice; report it instead of downloading.
    if (process.env.AI_RUNTIME_PYTHON || custom) throw error;
    writeAiRuntimeLog(`[python] ${error instanceof Error ? error.message : String(error)}`);
    return ensureManagedPython();
  }
}

function installedRuntimeInfo() {
  try {
    return JSON.parse(fs.readFileSync(aiRuntimeMarkerPath(), "utf8"));
  } catch {
    return null;
  }
}

function runtimeSettings() {
  const managed = managedPythonBuild();
  const installed = runtimeInstalled() ? installedRuntimeInfo() : null;
  return {
    pythonPath: readSettings().pythonPath,
    envPython: process.env.AI_RUNTIME_PYTHON || null,
    supportedRange: SUPPORTED_LABEL,
    managedPython: managed ? { version: managed.version, megabytes: Math.round(managed.bytes / 1e6) } : null,
    installedWith: installed?.basePython || null,
  };
}

// Check one Python, or (command null) report what the automatic search would pick.
function checkPython(command) {
  if (command) {
    const version = pythonVersion({ command, args: [] });
    return { command, version: version?.label || null, supported: isSupported(version) };
  }
  try {
    const { AI_RUNTIME_PYTHON: _ignored, ...env } = process.env;
    const found = findRuntimePython({ probe: pythonVersion, env });
    return { command: describePython(found), version: found.version.label, supported: true };
  } catch (error) {
    return { command: null, version: null, supported: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function findAvailablePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port) {
          resolve(port);
        } else {
          reject(new Error("Could not allocate backend port"));
        }
      });
    });
  });
}

function waitForPort(host, port, timeoutMs = 60000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      const socket = net.createConnection({ host, port }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Backend did not start on ${host}:${port}`));
          return;
        }
        setTimeout(check, 250);
      });
    }
    check();
  });
}

function startBackend() {
  const dbPath = prepareDbPath();
  const uploadFolder = prepareUserDataDir("uploads");
  const logPath = path.join(app.getPath("userData"), "backend.log");
  const shouldUseAiRuntime = useAiRuntimeBackend();
  const command = shouldUseAiRuntime ? runtimePythonPath() : hasPackagedBackend ? packagedBackendPath : pythonBin;
  const args = shouldUseAiRuntime ? [path.join(runtimeSourcePath, "app.py")] : hasPackagedBackend ? [] : [backendEntry];
  backendLogFd = isPackaged ? fs.openSync(logPath, "a") : null;
  backendProcess = spawn(command, args, {
    cwd: shouldUseAiRuntime ? runtimeSourcePath : repoRoot,
    env: {
      ...process.env,
      FLASK_HOST: backendHost,
      FLASK_PORT: String(backendPort),
      DB_PATH: dbPath,
      UPLOAD_FOLDER: uploadFolder,
      AI_RUNTIME_MODEL_DIR: aiRuntimeModelDir(),
      FLASK_DEBUG: "0",
      AI_CULLING_APP_VERSION: app.getVersion(),
      PYTHONUNBUFFERED: "1",
    },
    stdio: isPackaged && backendLogFd ? ["ignore", backendLogFd, backendLogFd] : "inherit",
  });
  backendProcess.on("error", (error) => {
    if (backendLogFd) {
      fs.writeSync(backendLogFd, `[electron] backend spawn error: ${error.stack || error.message}\n`);
    }
  });
  backendProcess.on("exit", (code, signal) => {
    if (backendLogFd) {
      fs.writeSync(backendLogFd, `[electron] backend exited code=${code ?? ""} signal=${signal ?? ""}\n`);
    }
  });
}

function stopBackend() {
  return new Promise((resolve) => {
    if (!backendProcess || backendProcess.killed) {
      resolve();
      return;
    }
    const processToStop = backendProcess;
    backendProcess = null;
    const timeout = setTimeout(resolve, 3000);
    processToStop.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    processToStop.kill();
  });
}

async function restartBackend() {
  await stopBackend();
  closeBackendLog();
  startBackend();
  await waitForPort(backendHost, backendPort);
}

async function verifyAiRuntime(runtimePython) {
  const script = "import importlib.util, sys\nmissing=[m for m in ['pyiqa','torch','open_clip','faiss','cv2','huggingface_hub'] if importlib.util.find_spec(m) is None]\nprint('missing=' + ','.join(missing))\nsys.exit(1 if missing else 0)\n";
  await runLogged(runtimePython, ["-c", script], { cwd: runtimeSourcePath });
}

async function installAiRuntime() {
  if (aiRuntime.installing) {
    return aiRuntimePublicStatus();
  }
  if (!fs.existsSync(path.join(runtimeSourcePath, "requirements-ai.txt"))) {
    throw new Error("AI runtime source files are missing from this app build.");
  }

  setAiRuntimeStatus({
    installing: true,
    state: "installing",
    message: "Installing advanced AI runtime...",
    detail: "Preparing Python environment",
    error: "",
  });

  try {
    fs.mkdirSync(aiRuntimeDir(), { recursive: true });
    if (fs.existsSync(aiRuntimeMarkerPath())) {
      fs.rmSync(aiRuntimeMarkerPath(), { force: true });
    }
    writeAiRuntimeLog(`\n[${new Date().toISOString()}] Installing AI runtime`);
    const python = await basePython();
    if (backendProcess && useAiRuntimeBackend()) {
      // Reinstalling: the backend runs from this venv, and Windows cannot delete a running python.exe.
      setAiRuntimeStatus({ detail: "Stopping the AI backend" });
      await stopBackend();
    }
    if (fs.existsSync(aiRuntimeVenvDir())) {
      setAiRuntimeStatus({ detail: "Removing previous incomplete AI runtime venv" });
      writeAiRuntimeLog(`[venv] removing existing venv at ${aiRuntimeVenvDir()}`);
      fs.rmSync(aiRuntimeVenvDir(), { recursive: true, force: true });
    }
    setAiRuntimeStatus({ detail: `Creating venv with Python ${python.version.label}` });
    await runLogged(python.command, [...python.args, "-m", "venv", aiRuntimeVenvDir()], { cwd: runtimeSourcePath });

    const runtimePython = runtimePythonPath();
    setAiRuntimeStatus({ detail: "Upgrading pip" });
    await runLogged(runtimePython, ["-m", "pip", "install", "--upgrade", "pip"], { cwd: runtimeSourcePath });

    setAiRuntimeStatus({ detail: "Installing AI dependencies. This may take a while." });
    await runLogged(runtimePython, [
      "-m",
      "pip",
      "install",
      "-r",
      path.join(runtimeSourcePath, "requirements.txt"),
      "-r",
      path.join(runtimeSourcePath, "requirements-ai.txt"),
      "-r",
      path.join(runtimeSourcePath, "requirements-faiss.txt"),
    ], { cwd: runtimeSourcePath });

    setAiRuntimeStatus({ detail: "Verifying AI runtime packages" });
    await verifyAiRuntime(runtimePython);

    fs.writeFileSync(aiRuntimeMarkerPath(), JSON.stringify({
      installedAt: new Date().toISOString(),
      python: runtimePython,
      basePython: { command: describePython(python), version: python.version.label },
      source: runtimeSourcePath,
    }, null, 2));
    setAiRuntimeStatus({
      state: "installed",
      message: "Advanced AI runtime installed.",
      detail: "Restarting backend with AI runtime",
    });
    await restartBackend();
    setAiRuntimeStatus({ detail: "AI runtime is active." });
  } catch (error) {
    if (fs.existsSync(aiRuntimeMarkerPath())) {
      fs.rmSync(aiRuntimeMarkerPath(), { force: true });
    }
    setAiRuntimeStatus({
      state: "error",
      message: "AI runtime installation failed.",
      error: error instanceof Error ? error.message : String(error),
      detail: `See ${path.join(app.getPath("userData"), "ai-runtime-install.log")}`,
    });
    if (!backendProcess) {
      // A failed reinstall stopped the AI backend; bring the bundled one back.
      try {
        closeBackendLog();
        startBackend();
        await waitForPort(backendHost, backendPort);
      } catch (restartError) {
        writeAiRuntimeLog(`[backend] restart failed: ${restartError instanceof Error ? restartError.message : String(restartError)}`);
      }
    }
  } finally {
    setAiRuntimeStatus({ installing: false });
  }
  return aiRuntimePublicStatus();
}

function resolveWorkspaceFileRoot(workspaceFilePath) {
  const fileDir = path.dirname(workspaceFilePath);
  const raw = fs.readFileSync(workspaceFilePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Workspace file must be valid JSON");
  }

  const rootPath = parsed.rootPath
    || parsed.root_path
    || parsed.path
    || (Array.isArray(parsed.folders) && parsed.folders[0]?.path);

  if (typeof rootPath !== "string" || !rootPath.trim()) {
    throw new Error("Workspace file must include rootPath or folders[0].path");
  }

  const expandedPath = rootPath.startsWith("~")
    ? path.join(app.getPath("home"), rootPath.slice(1))
    : rootPath;
  const resolvedPath = path.resolve(fileDir, expandedPath);
  const stat = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath) : null;
  if (!stat || !stat.isDirectory()) {
    throw new Error("Workspace file points to a folder that does not exist");
  }
  return resolvedPath;
}

function workspaceFileDefaultName(name) {
  const safeName = String(name || "Workspace")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim() || "Workspace";
  return `${safeName}.aiculling`;
}

async function createWindow() {
  configureApplicationMenu();
  if (isPackaged && !configuredBackendPort) {
    backendPort = await findAvailablePort(backendHost);
  }
  startBackend();
  await waitForPort(backendHost, backendPort);

  if (process.platform === "darwin" && fs.existsSync(appIconPath)) {
    app.dock.setIcon(appIconPath);
  }

  const win = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1100,
    minHeight: 720,
    title: appName,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;

  await win.loadURL(`http://${backendHost}:${backendPort}`);
  publishAiRuntimeStatus();
  initUpdater({ getWindow: () => mainWindow, getChannel: updateChannel });
}

ipcMain.handle("open-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0] || null;
});

ipcMain.handle("choose-output-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Choose AI Enhance Output Folder",
  });
  return result.canceled ? null : result.filePaths[0] || null;
});

ipcMain.handle("open-workspace-file", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      { name: "Workspace Files", extensions: ["ai-culling-workspace", "aiculling", "code-workspace", "json"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) {
    return null;
  }
  return resolveWorkspaceFileRoot(result.filePaths[0]);
});

ipcMain.handle("save-workspace-file", async (_event, workspace) => {
  if (!workspace || typeof workspace !== "object") {
    throw new Error("No workspace provided");
  }
  if (typeof workspace.rootPath !== "string" || !workspace.rootPath) {
    throw new Error("Workspace folder is missing");
  }

  const result = await dialog.showSaveDialog({
    defaultPath: workspaceFileDefaultName(workspace.name),
    filters: [
      { name: "AI Culling Workspace", extensions: ["aiculling"] },
      { name: "JSON", extensions: ["json"] },
    ],
  });
  if (result.canceled || !result.filePath) {
    return null;
  }

  const targetPath = path.extname(result.filePath)
    ? result.filePath
    : `${result.filePath}.aiculling`;
  const payload = {
    version: 1,
    app: appName,
    name: typeof workspace.name === "string" ? workspace.name : "Workspace",
    rootPath: workspace.rootPath,
    folders: [{ path: workspace.rootPath }],
  };
  fs.writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return targetPath;
});

ipcMain.handle("reveal-folder", async (_event, folderPath) => {
  if (typeof folderPath !== "string" || !folderPath) {
    throw new Error("No folder path provided");
  }
  const error = await shell.openPath(folderPath);
  if (error) {
    throw new Error(error);
  }
  return true;
});

ipcMain.handle("ai-runtime-status", async () => aiRuntimePublicStatus());

ipcMain.handle("install-ai-runtime", async () => installAiRuntime());

ipcMain.handle("get-runtime-settings", async () => runtimeSettings());

ipcMain.handle("get-update-settings", async () => updateSettings());

ipcMain.handle("set-update-channel", async (_event, channel) => {
  if (channel !== "stable" && channel !== "nightly") throw new Error(`Unknown update channel ${channel}`);
  writeSettings({ updateChannel: channel });
  return updateSettings();
});

ipcMain.handle("check-for-updates", async () => {
  await checkForUpdates({ manual: true });
  return updateSettings();
});

ipcMain.handle("check-python", async (_event, command) => checkPython(command || null));

ipcMain.handle("set-runtime-python", async (_event, command) => {
  const pythonPath = typeof command === "string" && command.trim() ? command.trim() : null;
  if (pythonPath) {
    const check = checkPython(pythonPath);
    if (!check.supported) {
      throw new Error(`AI Runtime needs Python ${SUPPORTED_LABEL}; ${pythonPath} is ${check.version ? `Python ${check.version}` : "not runnable"}.`);
    }
  }
  writeSettings({ pythonPath });
  return runtimeSettings();
});

ipcMain.handle("choose-python", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a Python for the AI runtime",
    buttonLabel: "Use This Python",
    properties: ["openFile", "showHiddenFiles"],
    filters: process.platform === "win32" ? [{ name: "Python", extensions: ["exe"] }] : [],
  });
  return result.canceled ? null : result.filePaths[0];
});

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox("Failed to start", error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill();
  }
  closeBackendLog();
});
