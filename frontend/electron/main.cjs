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
