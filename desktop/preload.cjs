const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('maoqiuDesktop', {
  settings: () => ipcRenderer.invoke('connector:settings'),
  saveInstance: value => ipcRenderer.invoke('connector:save', value),
  createWorktree: value => ipcRenderer.invoke('connector:worktree', value),
  restartConnector: () => ipcRenderer.invoke('connector:restart')
})
