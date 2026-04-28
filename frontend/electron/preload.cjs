const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiCulling", {
  openFolder: () => ipcRenderer.invoke("open-folder"),
  openWorkspaceFile: () => ipcRenderer.invoke("open-workspace-file"),
  saveWorkspaceFile: (workspace) => ipcRenderer.invoke("save-workspace-file", workspace),
  onSaveWorkspaceFileRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("save-workspace-file-request", listener);
    return () => ipcRenderer.removeListener("save-workspace-file-request", listener);
  },
  revealFolder: (folderPath) => ipcRenderer.invoke("reveal-folder", folderPath),
});
