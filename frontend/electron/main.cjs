const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const appName = "AI Photo Culling";
app.setName(appName);
app.setAboutPanelOptions({ applicationName: appName });

const repoRoot = path.resolve(__dirname, "..", "..");
const backendHost = process.env.FLASK_HOST || "127.0.0.1";
const backendPort = Number(process.env.FLASK_PORT || "5050");
const pythonBin = process.env.PYTHON || "python3";
const backendEntry = process.env.BACKEND_ENTRY
  ? path.resolve(repoRoot, process.env.BACKEND_ENTRY)
  : path.join(repoRoot, "app.py");
const appIconPath = path.join(__dirname, "assets", "icon.png");
let backendProcess = null;

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

function waitForPort(host, port, timeoutMs = 15000) {
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
  backendProcess = spawn(pythonBin, [backendEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      FLASK_HOST: backendHost,
      FLASK_PORT: String(backendPort),
      DB_PATH: dbPath,
    },
    stdio: "inherit",
  });
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

  await win.loadURL(`http://${backendHost}:${backendPort}`);
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
});
