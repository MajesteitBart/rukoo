// Runs make-icon.js with Electron, clearing ELECTRON_RUN_AS_NODE like scripts/start.js does.
const { spawnSync } = require('child_process');
const path = require('path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const res = spawnSync(require('electron'), [path.join(__dirname, 'make-icon.js')], { stdio: 'inherit', env });
process.exit(res.status ?? 0);
