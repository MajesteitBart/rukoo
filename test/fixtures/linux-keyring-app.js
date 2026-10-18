'use strict';

// Playwright's Electron loader forces password-store=basic. This live-account
// fixture restores the real Secret Service backend before Electron becomes ready.
const { app } = require('electron');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const pkg = require(path.join(root, 'package.json'));
app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
// Electron's own default_app loader uses setAppPath when loading a package. Keep
// bundled skills and other app-relative resources rooted at the actual checkout.
app.setAppPath(root);
app.setName(pkg.productName || pkg.name);
app.setVersion(pkg.version);
require(path.join(root, pkg.main));
