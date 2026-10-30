// Cross-platform Electron launcher for the pnpm scripts.
// Removes ELECTRON_RUN_AS_NODE (VS Code terminals set it on every platform,
// which turns the Electron binary into plain Node) and passes --dev through
// as ELECTRON_DEV=1.
const { spawn } = require('node:child_process');
const path = require('node:path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--dev')) env.ELECTRON_DEV = '1';

const electron = require('electron'); // resolves to the binary path in plain Node
const child = spawn(electron, [path.join(__dirname, '..')], { env, stdio: 'inherit', windowsHide: false });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', (err) => {
  console.error(`Failed to start Electron: ${err.message}`);
  process.exit(1);
});
