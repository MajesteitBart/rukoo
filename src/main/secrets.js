'use strict';

const { t } = require('../i18n');

// The Linux backends that keep a secret in the system keyring. Electron's basic_text backend reports encryption
// available but uses a hardcoded password, which does not protect credentials.
const LINUX_KEYRINGS = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'];

function createSecrets(safeStorage, platform = process.platform) {
  return {
    // Whether encrypt() keeps a secret encrypted (enc:) rather than refusing it or storing it readable (plain:). Only
    // after the app is ready.
    available() {
      try {
        if (!safeStorage.isEncryptionAvailable()) return false;
        if (platform === 'linux') return LINUX_KEYRINGS.includes(safeStorage.getSelectedStorageBackend?.());
        return true;
      } catch (_) {
        return false;
      }
    },
    encrypt(text) {
      const available = safeStorage.isEncryptionAvailable();
      if (platform === 'linux' && text) {
        const backend = safeStorage.getSelectedStorageBackend?.();
        if (!available || !LINUX_KEYRINGS.includes(backend)) {
          throw new Error(t('errors.credentials.linuxKeyring'));
        }
      }
      if (platform === 'darwin' && text && !available) throw new Error(t('errors.credentials.macKeychain'));
      if (available) return `enc:${safeStorage.encryptString(text).toString('base64')}`;
      return `plain:${Buffer.from(text).toString('base64')}`;
    },
    decrypt(value) {
      // Keep legacy profiles readable; only new credential writes require the
      // Linux keyring. Decryption errors must remain visible to the caller.
      const s = String(value || '');
      if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
      if (s.startsWith('plain:')) return Buffer.from(s.slice(6), 'base64').toString();
      return s;
    }
  };
}

module.exports = { createSecrets };
