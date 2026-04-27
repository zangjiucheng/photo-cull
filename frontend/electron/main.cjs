const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const backendHost = process.env.FLASK_HOST || "127.0.0.1";
const backendPort = Number(process.env.FLASK_PORT || "5050");
const pythonBin = process.env.PYTHON || "python3";
const backendEntry = process.env.BACKEND_ENTRY
  ? path.resolve(repoRoot, process.env.BACKEND_ENTRY)
  : path.join(repoRoot, "app.py");
let backendProcess = null;

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
  backendProcess = spawn(pythonBin, [backendEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      FLASK_HOST: backendHost,
      FLASK_PORT: String(backendPort),
    },
    stdio: "inherit",
  });
}

async function createWindow() {
  startBackend();
  await waitForPort(backendHost, backendPort);

  const win = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1100,
    minHeight: 720,
    title: "AI Photo Culling",
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
