const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const appName = "AI Photo Culling";
app.setName(appName);
app.setAboutPanelOptions({ applicationName: appName });

const minAiRuntimePython = { major: 3, minor: 10 };
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
const appIconPath = path.join(__dirname, "assets", "icon.png");
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
        { role: "about", label: `About ${appName}` },
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
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

function pythonVersion(command) {
  const result = spawnSync(command, [
    "-c",
    "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: runtimeSearchPath(),
    },
  });
  if (result.status !== 0) {
    return null;
  }
  const match = result.stdout.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    label: match[0],
  };
}

function isSupportedPython(version) {
  if (!version) {
    return false;
  }
  if (version.major > minAiRuntimePython.major) {
    return true;
  }
  return version.major === minAiRuntimePython.major && version.minor >= minAiRuntimePython.minor;
}

function systemPythonPath() {
  if (process.env.AI_RUNTIME_PYTHON) {
    const configuredVersion = pythonVersion(process.env.AI_RUNTIME_PYTHON);
    writeAiRuntimeLog(`[python] AI_RUNTIME_PYTHON=${process.env.AI_RUNTIME_PYTHON} version=${configuredVersion?.label || "unavailable"}`);
    if (isSupportedPython(configuredVersion)) {
      return process.env.AI_RUNTIME_PYTHON;
    }
    throw new Error(`AI Runtime requires Python ${minAiRuntimePython.major}.${minAiRuntimePython.minor}+; AI_RUNTIME_PYTHON is ${configuredVersion?.label || "not runnable"}.`);
  }

  const candidates = process.platform === "win32"
    ? ["python3.13", "python3.12", "python3.11", "python3.10", "python"]
    : [
        "python3.13",
        "python3.12",
        "python3.11",
        "python3.10",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
        "python3",
      ];

  for (const candidate of candidates) {
    const version = pythonVersion(candidate);
    writeAiRuntimeLog(`[python] candidate=${candidate} version=${version?.label || "unavailable"}`);
    if (isSupportedPython(version)) {
      return candidate;
    }
  }

  throw new Error(`AI Runtime requires Python ${minAiRuntimePython.major}.${minAiRuntimePython.minor}+ because numpy/torch do not support the selected older Python. Install Python 3.10 or newer, or set AI_RUNTIME_PYTHON to a compatible Python executable.`);
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
      FLASK_DEBUG: "0",
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
  const script = "import importlib.util, sys\nmissing=[m for m in ['pyiqa','torch','open_clip','faiss'] if importlib.util.find_spec(m) is None]\nprint('missing=' + ','.join(missing))\nsys.exit(1 if missing else 0)\n";
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
    const python = systemPythonPath();
    if (fs.existsSync(aiRuntimeVenvDir())) {
      setAiRuntimeStatus({ detail: "Removing previous incomplete AI runtime venv" });
      writeAiRuntimeLog(`[venv] removing existing venv at ${aiRuntimeVenvDir()}`);
      fs.rmSync(aiRuntimeVenvDir(), { recursive: true, force: true });
    }
    setAiRuntimeStatus({ detail: `Creating venv with ${python}` });
    await runLogged(python, ["-m", "venv", aiRuntimeVenvDir()], { cwd: runtimeSourcePath });

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
}

ipcMain.handle("open-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
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
