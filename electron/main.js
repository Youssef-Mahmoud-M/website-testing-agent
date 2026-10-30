// Electron main process. This is the only privileged process in the app.
// The Angular renderer runs sandboxed and talks to us through the preload
// bridge (see preload.js). Nothing here trusts input from the renderer.
const electron = require('electron');

// VS Code terminals export ELECTRON_RUN_AS_NODE=1, which turns the Electron
// binary into plain Node and makes `require('electron')` return a path string.
if (typeof electron === 'string' || !electron.app) {
  const unset =
    process.platform === 'win32'
      ? 'set ELECTRON_RUN_AS_NODE=   (cmd)  or  Remove-Item Env:ELECTRON_RUN_AS_NODE   (PowerShell)'
      : 'env -u ELECTRON_RUN_AS_NODE pnpm electron:run';
  console.error(`Electron started in Node mode. Unset ELECTRON_RUN_AS_NODE and try again, or use "pnpm electron:run":\n  ${unset}`);
  process.exit(1);
}

const { app, BrowserWindow, ipcMain, screen, shell, session, dialog } = electron;
const systemClipboard = require('./clipboard');
const fs = require('node:fs/promises');
const path = require('node:path');
const { configureBrowsersPath } = require('./browser-install');
configureBrowsersPath(); // before playwright is loaded by the controller
const { BrowserController } = require('./browser-controller');
const { AgentSession } = require('./agent/session');
const configStore = require('./config-store');
const { CHANNELS, assertHttpUrl, assertText } = require('./ipc');

const isDev = process.env.ELECTRON_DEV === '1';
const DEV_URL = 'http://localhost:4200';
const INDEX_FILE = path.join(__dirname, '..', 'dist', 'website-testing-agent', 'browser', 'index.html');

/** @type {BrowserWindow | null} */
let mainWindow = null;
const controller = new BrowserController();
const agent = new AgentSession({ controller, getConfig: () => configStore.resolve() });

// Chromium OS-level sandbox for every renderer, including the preload script.
app.enableSandbox();

// Chromium only auto-detects the keyring on well-known desktops (GNOME, KDE,
// XFCE...). On others, such as Hyprland or Sway, it silently falls back to the
// unencrypted "basic_text" store, so pick the Secret Service backend ourselves.
// WTA_PASSWORD_STORE overrides the choice (gnome-libsecret, kwallet6, basic).
if (process.platform === 'linux') {
  const knownDesktop = /gnome|kde|unity|xfce|cinnamon|mate|pantheon|deepin|lxqt|ukui/i;
  const store =
    process.env.WTA_PASSWORD_STORE || (knownDesktop.test(process.env.XDG_CURRENT_DESKTOP || '') ? null : 'gnome-libsecret');
  if (store) app.commandLine.appendSwitch('password-store', store);
}

/** Only our own UI is allowed to load inside the app window. */
function isOwnUi(url) {
  if (isDev) return url.startsWith(DEV_URL);
  return url.startsWith('file://') && url.includes('dist/website-testing-agent/browser/');
}

function layout() {
  const { workArea } = screen.getPrimaryDisplay();
  const agentWidth = Math.max(520, Math.round(workArea.width * 0.42));
  return {
    agent: { x: workArea.x, y: workArea.y, width: agentWidth, height: workArea.height },
    browser: {
      x: workArea.x + agentWidth,
      y: workArea.y,
      width: workArea.width - agentWidth,
      height: workArea.height,
    },
  };
}

function createWindow() {
  const { agent, browser } = layout();
  controller.setWindowBounds(browser);

  mainWindow = new BrowserWindow({
    ...agent,
    minWidth: 480,
    title: 'Website Testing Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  // Links clicked in the UI open in the user's default browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // The app window must never navigate away from our own UI.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isOwnUi(url)) event.preventDefault();
  });

  // Deny every permission request (camera, geolocation, notifications...).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(INDEX_FILE);
  }
}

function registerIpc() {
  ipcMain.handle(CHANNELS.browserOpen, async (_event, url) => {
    assertHttpUrl(url);
    return controller.open(url);
  });
  ipcMain.handle(CHANNELS.browserScreenshot, () => controller.screenshot());
  ipcMain.handle(CHANNELS.browserStatus, () => controller.status());
  ipcMain.handle(CHANNELS.browserClose, () => controller.close());
  ipcMain.handle(CHANNELS.sessionReset, () => agent.reset());

  ipcMain.handle(CHANNELS.agentExplore, (_event, url) => agent.explore(assertHttpUrl(url)));
  ipcMain.handle(CHANNELS.agentChat, (_event, text) => agent.chat(assertText(text)));
  ipcMain.handle(CHANNELS.agentState, () => agent.getState());
  ipcMain.handle(CHANNELS.agentScreenshot, (_event, label) =>
    agent.captureScreenshot(typeof label === 'string' ? label.slice(0, 80) : 'Manual screenshot'),
  );

  ipcMain.handle(CHANNELS.agentDesign, (_event, feedback) =>
    agent.design(feedback === null || feedback === undefined ? null : assertText(feedback, 4000)),
  );
  ipcMain.handle(CHANNELS.agentSelectCase, (_event, input) => {
    if (!input || typeof input.id !== 'string' || !/^TC-\d{2,3}$/.test(input.id)) throw new Error('Invalid test case id');
    return agent.setCaseSelected(input.id, Boolean(input.selected));
  });
  ipcMain.handle(CHANNELS.agentGenerate, () => agent.generate());
  ipcMain.handle(CHANNELS.agentRetry, (_event, messageId) => {
    if (typeof messageId !== 'string' || !/^[0-9a-f-]{36}$/.test(messageId)) throw new Error('Invalid message id');
    return agent.retry(messageId);
  });

  // The renderer never chooses a path: the user does, through the OS dialog.
  ipcMain.handle(CHANNELS.testsSave, async () => {
    const generated = agent.generatedTests;
    if (!generated) throw new Error('No generated tests to save');
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save generated tests',
      defaultPath: path.join(app.getPath('documents'), generated.fileName),
      filters: [{ name: 'Python', extensions: ['py'] }],
    });
    if (canceled || !filePath) return { saved: false, path: null };
    await fs.writeFile(filePath, generated.code, { encoding: 'utf8', mode: 0o644 });
    return { saved: true, path: filePath };
  });
  ipcMain.handle(CHANNELS.testsCopy, () => {
    if (!agent.generatedTests) throw new Error('No generated tests to copy');
    return systemClipboard.writeText(agent.generatedTests.code);
  });

  ipcMain.handle(CHANNELS.appInfo, () => ({ platform: process.platform, packaged: app.isPackaged, version: app.getVersion() }));
  ipcMain.handle(CHANNELS.llmGetConfig, () => configStore.publicView());
  ipcMain.handle(CHANNELS.llmSetConfig, (_event, input) => configStore.save(input));
  ipcMain.handle(CHANNELS.llmTest, () => agent.testProvider());

  const forward = (channel) => (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, event);
  };
  controller.on('event', forward(CHANNELS.browserEvent));
  agent.on('event', forward(CHANNELS.agentEvent));
}

app.whenReady().then(() => {
  configStore.migrate();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await controller.close().catch(() => undefined);
});
