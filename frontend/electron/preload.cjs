const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiCulling", {
  openFolder: () => ipcRenderer.invoke("open-folder"),
  revealFolder: (folderPath) => ipcRenderer.invoke("reveal-folder", folderPath),
});
