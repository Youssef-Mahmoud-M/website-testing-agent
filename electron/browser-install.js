// Makes sure Playwright's Chromium exists before the agent launches it.
//
// Development: Playwright's default cache (~/.cache/ms-playwright and the
// platform equivalents) filled by `pnpm exec playwright install chromium`.
// Packaged app: browsers live in the app's user-data folder and are downloaded
// on first use by running Playwright's own CLI, with progress reported back.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** Must run before `require('playwright')` so the browser path is honoured. */
function configureBrowsersPath() {
  if (!app.isPackaged || process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(app.getPath('userData'), 'ms-playwright');
}

function installed() {
  try {
    const { chromium } = require('playwright');
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/**
 * Path of Playwright's CLI, outside the asar archive when packaged.
 * Resolved through the `playwright` package because package managers such as
 * pnpm do not hoist its `playwright-core` dependency to the top level.
 */
function cliPath() {
  // The package's exports map hides cli.js from require.resolve, so locate it
  // next to the package entry point instead.
  const entry = require.resolve('playwright');
  const resolved = path.join(path.dirname(entry), 'cli.js');
  return resolved.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

/**
 * @param {(progress: { percent: number|null, message: string }) => void} onProgress
 */
function install(onProgress) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const child = spawn(process.execPath, [cliPath(), 'install', 'chromium'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let lastLine = '';
    let stderr = '';
    const onData = (chunk) => {
      const text = chunk.toString();
      const lines = text.split(/\r?\n|\r/).filter(Boolean);
      for (const line of lines) {
        lastLine = line;
        const match = line.match(/(\d+)% of ([\d.]+ \w+)/);
        if (match) onProgress({ percent: Number(match[1]), message: `Downloading Chromium ${match[1]}% of ${match[2]}` });
        else if (/Downloading/.test(line)) onProgress({ percent: null, message: line.trim().slice(0, 80) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      onData(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 && installed()) return resolve();
      reject(new Error(`Chromium download failed (exit ${code}). ${(stderr || lastLine).trim().slice(0, 300)}`));
    });
  });
}

/**
 * Resolve when Chromium is available, downloading it if needed.
 * @param {(progress: { percent: number|null, message: string }) => void} onProgress
 */
async function ensureBrowser(onProgress = () => undefined) {
  if (installed()) return;
  onProgress({ percent: null, message: 'Chromium for Playwright is not installed yet; downloading (about 150 MB, once)' });
  await install(onProgress);
}

module.exports = { configureBrowsersPath, ensureBrowser, installed };
