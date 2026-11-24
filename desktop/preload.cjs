const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('maoqiuDesktop', {
  settings: () => ipcRenderer.invoke('connector:settings'),
  saveInstance: value => ipcRenderer.invoke('connector:save', value),
  restartConnector: () => ipcRenderer.invoke('connector:restart')
})
