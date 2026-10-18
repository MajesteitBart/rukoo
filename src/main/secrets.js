'use strict';

const { t } = require('../i18n');

function createSecrets(safeStorage, platform = process.platform) {
  return {
    encrypt(text) {
      const available = safeStorage.isEncryptionAvailable();
      // Electron's basic_text backend reports encryption available but uses a
      // hardcoded password. It does not protect credentials on Linux.
      if (platform === 'linux' && text) {
        const backend = safeStorage.getSelectedStorageBackend?.();
        if (!available || !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)) {
          throw new Error(t('errors.credentials.linuxKeyring'));
        }
      }
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
