// Local panel: no Node, arbitrary channels, external links or credential access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petPanel', {
  status: () => ipcRenderer.invoke('panel:status'),
  updateSettings: (patch) => ipcRenderer.invoke('panel:update-settings', patch),
  action: (action) => ipcRenderer.invoke('panel:action', action),
  onUpdate: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('panel:updated', listener);
    return () => ipcRenderer.removeListener('panel:updated', listener);
  },
});
