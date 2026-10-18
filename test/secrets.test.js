'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSecrets } = require('../src/main/secrets');
const { setLanguage } = require('../src/i18n');

function storage(backend, available = true) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().slice('encrypted:'.length)
  };
}

test('Linux refuses new credentials without a secure keyring, including basic_text', () => {
  for (const [backend, available] of [['basic_text', true], ['unknown', true], [undefined, true], ['gnome_libsecret', false]]) {
    const fake = storage(backend, available);
    fake.encryptString = () => assert.fail('must not encrypt with an insecure backend');
    assert.throws(() => createSecrets(fake, 'linux').encrypt('password'), /Install and unlock GNOME Keyring or KWallet/);
  }
});

test('Linux securely stored credentials round trip with every supported keyring', () => {
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    const secrets = createSecrets(storage(backend), 'linux');
    const saved = secrets.encrypt('password');
    assert.ok(saved.startsWith('enc:'));
    assert.equal(secrets.decrypt(saved), 'password');
  }
});

test('legacy credentials remain readable and empty values need no keyring', () => {
  const secrets = createSecrets(storage('basic_text', false), 'linux');
  assert.equal(secrets.decrypt('plain:cGFzc3dvcmQ='), 'password');
  assert.equal(secrets.decrypt('old password'), 'old password');
  assert.equal(secrets.decrypt(null), '');
  assert.equal(secrets.decrypt(secrets.encrypt('')), '');
  assert.equal(secrets.decrypt(`enc:${Buffer.from('encrypted:legacy').toString('base64')}`), 'legacy');
});

test('Windows encryption does not depend on the Linux backend API', () => {
  const fake = storage(undefined);
  delete fake.getSelectedStorageBackend;
  const secrets = createSecrets(fake, 'win32');
  assert.equal(secrets.decrypt(secrets.encrypt('password')), 'password');
});

test('keyring errors follow the current language', () => {
  try {
    const secrets = createSecrets(storage('basic_text'), 'linux');
    setLanguage('nl');
    assert.throws(() => secrets.encrypt('password'), /Installeer en ontgrendel GNOME Keyring of KWallet/);
    setLanguage('en');
    assert.throws(() => secrets.encrypt('password'), /Install and unlock GNOME Keyring or KWallet/);
  } finally {
    setLanguage('en');
  }
});

test('macOS uses Keychain encryption and never writes a new credential without it', () => {
  const secure = createSecrets(storage(undefined), 'darwin');
  assert.equal(secure.decrypt(secure.encrypt('password')), 'password');
  const locked = createSecrets(storage(undefined, false), 'darwin');
  assert.throws(() => locked.encrypt('password'), /Keychain/);
  assert.equal(locked.decrypt('plain:cGFzc3dvcmQ='), 'password');
});
