const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('benchAPI', {
  readImage: (variant) => ipcRenderer.invoke('bench:read-image', variant)
})
