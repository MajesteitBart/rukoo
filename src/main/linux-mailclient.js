'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execute = promisify(execFile);
const DESKTOP = 'rukoo-mail.desktop';
const MIME = 'x-scheme-handler/mailto';

// The package installs the desktop entry. Never register a checkout or an AppImage's temporary mount.
class LinuxMailClient {
  constructor({ env = process.env, exists = fs.existsSync, run = async (args) => (await execute('xdg-mime', args, { timeout: 5000 })).stdout } = {}) {
    this.run = run;
    const roots = [env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')];
    this.available = roots.filter((root) => path.isAbsolute(root)).some((root) => exists(path.join(root, 'applications', DESKTOP)));
  }

  async status() {
    let handler = '';
    try { handler = (await this.run(['query', 'default', MIME])).trim(); } catch { /* xdg-utils or a default is absent. */ }
    return { available: this.available, app: handler || null, rukoo: handler === DESKTOP };
  }

  async register() {
    if (!this.available) return false;
    try {
      await this.run(['default', DESKTOP, MIME]);
      return (await this.status()).rukoo;
    } catch {
      return false;
    }
  }
}

module.exports = { LinuxMailClient, DESKTOP };
