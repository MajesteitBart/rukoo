// Starts the app. Clears ELECTRON_RUN_AS_NODE, which Electron-based terminals (VS Code, T3 Code) export
// and which would otherwise make electron.exe behave like plain Node.
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: require('path').join(__dirname, '..') });
child.on('exit', (code) => process.exit(code ?? 0));
