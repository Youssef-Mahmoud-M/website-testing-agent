// IPC channel names and input validation shared by main and preload.
// Keeping the list here means the preload can only ever reach these channels.
// NOTE: preload.js runs sandboxed and cannot require this file, so it carries
// its own copy of CHANNELS. Keep the two in sync.
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

/**
 * Accept only http(s) URLs. Rejects file:, javascript:, data:, chrome: and
 * anything that is not a string, so the renderer cannot point the automated
 * browser at local files or internal pages.
 * @param {unknown} value
 * @returns {string} normalised URL
 */
function assertHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('URL must be a string of at most 2048 characters');
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http and https URLs are allowed, got ${parsed.protocol}`);
  }
  return parsed.toString();
}

/** @param {unknown} value */
function assertText(value, maxLength = 8000) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Message must be a non-empty string');
  }
  if (value.length > maxLength) throw new Error(`Message longer than ${maxLength} characters`);
  return value.trim();
}

module.exports = { CHANNELS, assertHttpUrl, assertText };
