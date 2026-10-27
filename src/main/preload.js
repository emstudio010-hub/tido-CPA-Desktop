const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cpaDaemon', {
  getDashboardSnapshot: () => ipcRenderer.invoke('daemon:get-snapshot'),
  scanPorts: (port) => ipcRenderer.invoke('daemon:scan-ports', port),
  findFreePort: (startPort) => ipcRenderer.invoke('daemon:find-free-port', startPort),
  killProcess: (pid) => ipcRenderer.invoke('daemon:kill-process', pid),
  saveSettings: (settings) => ipcRenderer.invoke('daemon:save-settings', settings),
  startServer: (overrideSettings) => ipcRenderer.invoke('daemon:start-server', overrideSettings),
  stopServer: () => ipcRenderer.invoke('daemon:stop-server'),
  restartServer: (overrideSettings) => ipcRenderer.invoke('daemon:restart-server', overrideSettings),
  startOAuthLogin: (providerId) => ipcRenderer.invoke('daemon:oauth-login', providerId),
  readRawYaml: () => ipcRenderer.invoke('daemon:read-raw-yaml'),
  saveRawYaml: (yamlContent) => ipcRenderer.invoke('daemon:save-raw-yaml', yamlContent),
  clearLogs: () => ipcRenderer.invoke('daemon:clear-logs'),
  openExternal: (url) => ipcRenderer.invoke('daemon:open-external', url),
  openFolder: (folderType) => ipcRenderer.invoke('daemon:open-folder', folderType),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  onStatusChange: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('daemon:status-changed', handler);
    return () => ipcRenderer.removeListener('daemon:status-changed', handler);
  },
  onLog: (callback) => {
    const handler = (_event, entry) => callback(entry);
    ipcRenderer.on('daemon:log-entry', handler);
    return () => ipcRenderer.removeListener('daemon:log-entry', handler);
  },
  onLogsCleared: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('daemon:logs-cleared', handler);
    return () => ipcRenderer.removeListener('daemon:logs-cleared', handler);
  },
  onOAuthUrl: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('daemon:oauth-url', handler);
    return () => ipcRenderer.removeListener('daemon:oauth-url', handler);
  },
  onOAuthExit: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('daemon:oauth-exit', handler);
    return () => ipcRenderer.removeListener('daemon:oauth-exit', handler);
  }
});
