const { contextBridge, ipcRenderer } = require('electron');
const ACTIONS = new Set(['hide', 'settings']);

contextBridge.exposeInMainWorld('petQuota', {
  status: () => ipcRenderer.invoke('quota:status'),
  action: (action) => ACTIONS.has(action)
    ? ipcRenderer.invoke('quota:action', action)
    : Promise.reject(new Error('不支持的额度小窗操作')),
  onUpdate: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, quota) => callback(quota);
    ipcRenderer.on('quota:updated', listener);
    return () => ipcRenderer.removeListener('quota:updated', listener);
  },
});
