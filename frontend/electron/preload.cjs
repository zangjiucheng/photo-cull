const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiCulling", {
  openFolder: () => ipcRenderer.invoke("open-folder"),
  chooseOutputFolder: () => ipcRenderer.invoke("choose-output-folder"),
  openWorkspaceFile: () => ipcRenderer.invoke("open-workspace-file"),
  saveWorkspaceFile: (workspace) => ipcRenderer.invoke("save-workspace-file", workspace),
  onSaveWorkspaceFileRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("save-workspace-file-request", listener);
    return () => ipcRenderer.removeListener("save-workspace-file-request", listener);
  },
  revealFolder: (folderPath) => ipcRenderer.invoke("reveal-folder", folderPath),
  getAiRuntimeStatus: () => ipcRenderer.invoke("ai-runtime-status"),
  installAiRuntime: () => ipcRenderer.invoke("install-ai-runtime"),
  getRuntimeSettings: () => ipcRenderer.invoke("get-runtime-settings"),
  checkPython: (command) => ipcRenderer.invoke("check-python", command),
  setRuntimePython: (command) => ipcRenderer.invoke("set-runtime-python", command),
  choosePython: () => ipcRenderer.invoke("choose-python"),
  getUpdateSettings: () => ipcRenderer.invoke("get-update-settings"),
  setUpdateChannel: (channel) => ipcRenderer.invoke("set-update-channel", channel),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  onOpenSettingsRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("open-settings-request", listener);
    return () => ipcRenderer.removeListener("open-settings-request", listener);
  },
  onAiRuntimeStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("ai-runtime-status", listener);
    return () => ipcRenderer.removeListener("ai-runtime-status", listener);
  },
});
