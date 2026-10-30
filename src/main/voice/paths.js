'use strict';

// Where the Rukoo Voice discovery file is (voice/PROTOCOL.md "Where the file is"). Pure: the platform and the
// environment come in as arguments and the result uses that platform's separators, whatever system runs it, so the
// shared vectors in voice/fixtures/protocol-vectors.json test every platform anywhere.

const path = require('path');
const os = require('os');

// An empty variable counts as unset.
const value = (env, name) => {
  const v = env(name);
  return typeof v === 'string' && v !== '' ? v : null;
};

// Voice's default data folder on a platform, or null when the environment doesn't say where home is.
function voiceDataDir(platform, env) {
  if (platform === 'win32') {
    const local = value(env, 'LOCALAPPDATA') || (value(env, 'USERPROFILE') && path.win32.join(value(env, 'USERPROFILE'), 'AppData', 'Local'));
    return local ? path.win32.join(local, 'Rukoo Voice') : null;
  }
  const home = value(env, 'HOME');
  if (platform === 'darwin') return home ? path.posix.join(home, 'Library', 'Application Support', 'Rukoo Voice') : null;
  const state = value(env, 'XDG_STATE_HOME') || (home && path.posix.join(home, '.local', 'state'));
  return state ? path.posix.join(state, 'rukoo-voice') : null;
}

// side: 'rukoo' or 'voice'. env: a function from a variable name to its value. null when no path can be made.
function bridgePath(side, platform, env) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const override = value(env, 'RUKOO_VOICE_BRIDGE');
  if (override) return override;
  if (side === 'voice') {
    const dev = value(env, 'RUKOO_VOICE_DATA_DIR');
    if (dev) return join(dev, 'bridge.json');
  } else {
    // A development or test profile never finds the installed Voice, so it can't start or stop a real meeting.
    const profile = value(env, 'SEM_DATA_DIR');
    if (profile) return join(profile, 'voice-bridge.json');
  }
  const dir = voiceDataDir(platform, env);
  return dir ? join(dir, 'bridge.json') : null;
}

// The path for this Rukoo. Home comes from the OS when the environment lacks it.
function bridgePathHere(env = process.env, platform = process.platform) {
  return bridgePath('rukoo', platform, (name) => {
    const v = env[name];
    if (typeof v === 'string' && v !== '') return v;
    if (name === 'HOME' || name === 'USERPROFILE') return os.homedir();
    return undefined;
  });
}

module.exports = { bridgePath, bridgePathHere, voiceDataDir };
