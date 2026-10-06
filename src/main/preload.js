'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mail', {
  async call(method, ...args) {
    const res = await ipcRenderer.invoke('mail:call', method, args);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  },
  on(listener) {
    const handler = (_event, data) => listener(data);
    ipcRenderer.on('mail:event', handler);
    return () => ipcRenderer.removeListener('mail:event', handler);
  },
  pathForFile(file) {
    return webUtils.getPathForFile(file);
  }
});
