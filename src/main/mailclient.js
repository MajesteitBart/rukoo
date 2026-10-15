'use strict';

// Makes Rukoo one of the email apps Windows offers for mailto: links, for the current user. Windows keeps the
// choice to the user: register() only adds Rukoo to Settings > Apps > Default apps, where the user picks it.
// The installer writes the same keys and the uninstaller removes them (build/installer.nsh).

const fs = require('fs');
const { execFile } = require('child_process');

const NAME = 'Rukoo Mail';
const PROG_ID = 'RukooMail.mailto';

function reg(args) {
  return new Promise((resolve, reject) => {
    execFile('reg', args, { windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

class MailClient {
  // exe: the program Windows starts with the link. base: where the keys go, a scratch key in tests.
  constructor({ exe, description = '', base = 'HKCU\\Software', run = reg, exists = fs.existsSync }) {
    this.exe = exe;
    this.description = description;
    this.base = base;
    this.run = run;
    this.exists = exists;
  }

  get keys() {
    const prog = `${this.base}\\Classes\\${PROG_ID}`;
    const client = `${this.base}\\Clients\\Mail\\${NAME}`;
    return { prog, command: `${prog}\\shell\\open\\command`, client, capabilities: `${client}\\Capabilities`, registered: `${this.base}\\RegisteredApplications` };
  }

  // The values Windows reads, as [key, value name or null for the default value, data].
  values() {
    const k = this.keys;
    return [
      [k.prog, null, 'URL:MailTo Protocol'],
      [k.prog, 'URL Protocol', ''],
      [`${k.prog}\\DefaultIcon`, null, `"${this.exe}",0`],
      // "--" ends the options, so nothing in the link can pass for one.
      [k.command, null, `"${this.exe}" -- "%1"`],
      [k.client, null, NAME],
      [k.capabilities, 'ApplicationName', NAME],
      [k.capabilities, 'ApplicationDescription', this.description],
      [`${k.capabilities}\\URLAssociations`, 'mailto', PROG_ID],
      [k.registered, NAME, `Software\\Clients\\Mail\\${NAME}\\Capabilities`]
    ];
  }

  async register() {
    for (const [key, name, data] of this.values()) {
      await this.run(['add', key, ...(name === null ? ['/ve'] : ['/v', name]), '/t', 'REG_SZ', '/d', data, '/f']);
    }
  }

  async registered() {
    try {
      await this.run(['query', this.keys.registered, '/v', NAME]);
      return true;
    } catch (_) {
      return false;
    }
  }

  // At startup. The installed app offers itself, as its installer does; a portable copy, which can be anywhere,
  // only when the user asks. A registration whose program is gone (a moved portable .exe, another install folder)
  // moves to this copy; one whose program is still there stays with it. True when it registered.
  async refresh({ portable }) {
    const current = await this.registeredExe();
    if (current ? this.exists(current) : portable) return false;
    await this.register();
    return true;
  }

  // The program the registration starts now, or null without one.
  async registeredExe() {
    try {
      const out = await this.run(['query', this.keys.command, '/ve']);
      const m = out.match(/REG_SZ\s+"([^"]+)"/);
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  }
}

// Opens Rukoo's own page under Default apps; Windows builds before mid-2023 open the general page.
const SETTINGS_URL = `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(NAME)}`;

module.exports = { MailClient, NAME, PROG_ID, SETTINGS_URL };
