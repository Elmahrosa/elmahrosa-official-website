const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teosDesktop', {
  onUpdate: (callback) => ipcRenderer.on('teos-update', (_e, data) => callback(data)),

  getConfig:     () => ipcRenderer.invoke('teos:get-config'),
  login:         (key) => ipcRenderer.invoke('teos:login', key),
  logout:        () => ipcRenderer.invoke('teos:logout'),
  fetchHealth:   () => ipcRenderer.invoke('teos:fetch-health'),
  runScan:       (code) => ipcRenderer.invoke('teos:run-scan', code),
  getLog:        () => ipcRenderer.invoke('teos:get-log'),
  getVersion:    () => ipcRenderer.invoke('teos:get-version'),
});
