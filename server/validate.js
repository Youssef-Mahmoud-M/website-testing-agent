// Input validation for everything that arrives over HTTP. Nothing from the
// browser is trusted: URLs, texts and ids are checked here before use.
const net = require('node:net');

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;

function isPrivateAddress(host) {
  if (PRIVATE_HOST.test(host)) return true;
  const ip = host.replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('::ffff:');
  }
  return false;
}

/**
 * Accept only http(s) URLs. Rejects file:, javascript:, data: and the like.
 * With BLOCK_PRIVATE_URLS=1 the server also refuses loopback, link-local and
 * private-network hosts, so a public deployment cannot be used to probe the
 * network it runs in.
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
  if (process.env.BLOCK_PRIVATE_URLS === '1' && isPrivateAddress(parsed.hostname)) {
    throw new Error('This server does not allow exploring private or local network addresses.');
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

function assertCaseId(value) {
  if (typeof value !== 'string' || !/^TC-\d{2,3}$/.test(value)) throw new Error('Invalid test case id');
  return value;
}

function assertMessageId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value)) throw new Error('Invalid message id');
  return value;
}

module.exports = { assertHttpUrl, assertText, assertCaseId, assertMessageId, isPrivateAddress };
