'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mail', {
  platform: process.platform,
  async call(method, ...args) {
    const res = await ipcRenderer.invoke('mail:call', method, args);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  },
  // The answer as it came: { ok: true, result }, or { ok: false, error } with main's code and its details, if any.
  // An error thrown across the context bridge keeps only its message, so api() in ui.js builds its own, with the code.
  invoke(method, ...args) {
    return ipcRenderer.invoke('mail:call', method, args);
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
