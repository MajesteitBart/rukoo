// A bare Electron app for screenshots.js: one window, parked off-screen and shown without activation, because a
// never-shown window doesn't paint and a focused one would take the keyboard from whatever the user is doing.
'use strict';

const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 760,
    height: 680,
    useContentSize: true,
    show: false,
    frame: false,
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false }
  });
  win.once('ready-to-show', () => {
    win.setPosition(-5000, -5000);
    win.showInactive();
  });
  win.loadURL('about:blank');
});

app.on('window-all-closed', () => app.quit());
