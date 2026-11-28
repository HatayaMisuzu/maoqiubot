const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('maoqiuDesktop', {
  settings: () => ipcRenderer.invoke('connector:settings'),
  saveInstance: value => ipcRenderer.invoke('connector:save', value),
  setCodexProvider: value => ipcRenderer.invoke('connector:codex-provider', value),
  discoverHermes: () => ipcRenderer.invoke('connector:hermes-discover'),
  probeHermes: value => ipcRenderer.invoke('connector:hermes-probe', value),
  createWorktree: value => ipcRenderer.invoke('connector:worktree', value),
  restartConnector: () => ipcRenderer.invoke('connector:restart'),
  agentManagerStatus: () => ipcRenderer.invoke('agent-manager:status'),
  openAgentManager: instanceId => ipcRenderer.invoke('agent-manager:open', instanceId),
  agentMonitor: options => ipcRenderer.invoke('agent-manager:monitor', options),
  agentQuota: instanceId => ipcRenderer.invoke('agent-manager:quota', instanceId)
})
