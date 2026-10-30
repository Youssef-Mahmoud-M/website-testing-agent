// Clipboard writes that actually land on the system clipboard.
//
// On Wayland sessions Electron usually runs through XWayland, and its X11
// clipboard is unreliable there: writes may not reach the compositor and
// clipboard.readText() can block the main process indefinitely when another
// Wayland client owns the selection. So on Wayland the compositor is written
// directly through wl-copy, Electron's clipboard is only a fallback, and the
// clipboard is never read back.
const { clipboard } = require('electron');
const { spawn } = require('node:child_process');

/**
 * Feed `input` to a tool and resolve when the tool's own process exits.
 * wl-copy forks a daemon that keeps serving the clipboard and inherits our
 * pipes, so stdout/stderr are detached: waiting for them to close would hang.
 */
function runWithInput(cmd, args, input, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // wl-copy's daemon would otherwise inherit every open descriptor of the
      // Electron process (cache files, IPC pipes) for as long as the clipboard
      // content lives. Close all descriptors above stderr before exec'ing it.
      const closeFds = 'for f in /proc/$$/fd/*; do f=${f##*/}; [ "$f" -gt 2 ] && eval "exec $f>&-"; done 2>/dev/null; exec "$@"';
      child = spawn('/bin/sh', ['-c', closeFds, 'sh', cmd, ...args], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
      child.unref();
    } catch (err) {
      return reject(err);
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else if (code === 127) reject(Object.assign(new Error(`${cmd} not found`), { code: 'ENOENT' }));
      else reject(new Error(`${cmd} exited with ${signal ?? code}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/** Platform tools, in order of preference for this session. */
function tools() {
  const list = [];
  if (process.platform === 'linux') {
    if (process.env.WAYLAND_DISPLAY) list.push({ via: 'wl-copy', cmd: 'wl-copy', args: ['--type', 'text/plain'] });
    if (process.env.DISPLAY) {
      list.push({ via: 'xclip', cmd: 'xclip', args: ['-selection', 'clipboard', '-in'] });
      list.push({ via: 'xsel', cmd: 'xsel', args: ['--clipboard', '--input'] });
    }
  }
  return list;
}

function electronWrite(text) {
  clipboard.writeText(text);
  return { copied: true, via: 'electron' };
}

/**
 * @param {string} text
 * @returns {Promise<{ copied: true, via: string }>}
 */
async function writeText(text) {
  const onWayland = process.platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY);

  // Outside Wayland, Electron's own clipboard is the right tool.
  if (!onWayland) return electronWrite(text);

  const tried = [];
  for (const t of tools()) {
    try {
      await runWithInput(t.cmd, t.args, text);
      return { copied: true, via: t.via };
    } catch (err) {
      tried.push(`${t.via}: ${err.code === 'ENOENT' ? 'not installed' : err.message}`);
    }
  }
  // Last resort on Wayland: Electron's clipboard, unverified because reading it back can hang.
  try {
    const result = electronWrite(text);
    return { ...result, via: 'electron (unverified; install wl-clipboard for reliable copying)' };
  } catch (err) {
    throw new Error(`Could not write to the clipboard. Install wl-clipboard (wl-copy) or use Save as…. Tried ${tried.join('; ')}; electron: ${err.message}`);
  }
}

module.exports = { writeText };
