// Preload script: the only bridge between the sandboxed Angular renderer and
// the main process. It exposes a small, fixed set of functions on
// window.agent. The renderer never gets ipcRenderer itself.
//
// Sandboxed preloads cannot require local modules, so the channel names are
// duplicated here. Keep them in sync with electron/ipc.js.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  browserOpen: 'browser:open',
  browserScreenshot: 'browser:screenshot',
  browserStatus: 'browser:status',
  browserClose: 'browser:close',
  browserEvent: 'browser:event',
  sessionReset: 'session:reset',
  agentChat: 'agent:chat',
  agentExplore: 'agent:explore',
  agentState: 'agent:state',
  agentScreenshot: 'agent:screenshot',
  agentDesign: 'agent:design',
  agentSelectCase: 'agent:select-case',
  agentGenerate: 'agent:generate',
  agentRetry: 'agent:retry',
  appInfo: 'app:info',
  testsSave: 'tests:save',
  testsCopy: 'tests:copy',
  agentEvent: 'agent:event',
  llmGetConfig: 'llm:get-config',
  llmSetConfig: 'llm:set-config',
  llmTest: 'llm:test',
});

/** Subscribe to a push channel; returns an unsubscribe function. */
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('agent', {
  browser: {
    open: (url) => ipcRenderer.invoke(CHANNELS.browserOpen, url),
    screenshot: () => ipcRenderer.invoke(CHANNELS.browserScreenshot),
    status: () => ipcRenderer.invoke(CHANNELS.browserStatus),
    close: () => ipcRenderer.invoke(CHANNELS.browserClose),
    onEvent: (callback) => subscribe(CHANNELS.browserEvent, callback),
  },
  session: {
    reset: () => ipcRenderer.invoke(CHANNELS.sessionReset),
  },
  agent: {
    chat: (text) => ipcRenderer.invoke(CHANNELS.agentChat, text),
    explore: (url) => ipcRenderer.invoke(CHANNELS.agentExplore, url),
    state: () => ipcRenderer.invoke(CHANNELS.agentState),
    screenshot: (label) => ipcRenderer.invoke(CHANNELS.agentScreenshot, label),
    design: (feedback) => ipcRenderer.invoke(CHANNELS.agentDesign, feedback ?? null),
    selectCase: (id, selected) => ipcRenderer.invoke(CHANNELS.agentSelectCase, { id, selected }),
    generate: () => ipcRenderer.invoke(CHANNELS.agentGenerate),
    retry: (messageId) => ipcRenderer.invoke(CHANNELS.agentRetry, messageId),
    onEvent: (callback) => subscribe(CHANNELS.agentEvent, callback),
  },
  app: {
    info: () => ipcRenderer.invoke(CHANNELS.appInfo),
  },
  tests: {
    save: () => ipcRenderer.invoke(CHANNELS.testsSave),
    copy: () => ipcRenderer.invoke(CHANNELS.testsCopy),
  },
  llm: {
    getConfig: () => ipcRenderer.invoke(CHANNELS.llmGetConfig),
    setConfig: (input) => ipcRenderer.invoke(CHANNELS.llmSetConfig, input),
    test: () => ipcRenderer.invoke(CHANNELS.llmTest),
  },
});
