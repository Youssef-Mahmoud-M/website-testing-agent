// HTTP server for the web testing agent.
//   - serves the built Angular app from dist/ (or proxies nothing: in dev use
//     `ng serve`, whose proxy.conf.json forwards /api here)
//   - JSON API under /api, one agent per browser session
//   - server-sent events at /api/events for agent and browser updates,
//     including live JPEG frames of the headless browser
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { Sessions } = require('./sessions');
const { assertHttpUrl, assertText, assertCaseId, assertMessageId } = require('./validate');

const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 3000;
// Secure default: listen on loopback only. Set HOST=0.0.0.0 to expose it.
const HOST = process.env.HOST || '127.0.0.1';
const HEADLESS = process.env.HEADLESS !== 'false';
const DIST = path.join(__dirname, '..', 'dist', 'website-testing-agent', 'browser');
const VERSION = require('../package.json').version;

const app = express();
const sessions = new Sessions({ headless: HEADLESS });

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!req.path.startsWith('/api/')) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
    );
  }
  next();
});
app.use(express.json({ limit: '64kb' }));

// Same-origin only: browsers send Origin on cross-site POSTs; reject them.
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET') {
    const host = req.headers.host;
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      /* invalid origin */
    }
    if (originHost !== host) return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  }
  next();
});
app.use('/api', sessions.middleware());

const wrap = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json(result === undefined ? null : result);
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 400).json({ error: err.message || String(err) });
  }
};

// ---- events ----
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`event: hello\ndata: ${JSON.stringify({ sessionId: req.session.id })}\n\n`);
  req.session.streams.add(res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    req.session.streams.delete(res);
    req.session.lastSeen = Date.now();
  });
});

// ---- app / browser ----
app.get('/api/app/info', wrap(() => ({ platform: 'web', packaged: false, version: VERSION, headless: HEADLESS })));
app.get('/api/browser/status', wrap((req) => req.session.controller.status()));
app.post('/api/browser/open', wrap((req) => req.session.controller.open(assertHttpUrl(req.body?.url))));
app.post('/api/browser/screenshot', wrap((req) => req.session.controller.screenshot()));
app.post('/api/browser/close', wrap((req) => req.session.controller.close()));

// ---- agent ----
app.get('/api/agent/state', wrap((req) => req.session.agent.getState()));
app.post('/api/agent/explore', wrap((req) => req.session.agent.explore(assertHttpUrl(req.body?.url))));
app.post('/api/agent/chat', wrap((req) => req.session.agent.chat(assertText(req.body?.text))));
app.post('/api/agent/screenshot', wrap((req) => req.session.agent.captureScreenshot(typeof req.body?.label === 'string' ? req.body.label.slice(0, 80) : 'Manual screenshot')));
app.post('/api/agent/design', wrap((req) => req.session.agent.design(req.body?.feedback == null ? null : assertText(req.body.feedback, 4000))));
app.post('/api/agent/select-case', wrap((req) => req.session.agent.setCaseSelected(assertCaseId(req.body?.id), Boolean(req.body?.selected))));
app.post('/api/agent/generate', wrap((req) => req.session.agent.generate()));
app.post('/api/agent/retry', wrap((req) => req.session.agent.retry(assertMessageId(req.body?.messageId))));
app.post('/api/session/reset', wrap((req) => req.session.agent.reset()));

// ---- llm settings (per session, in memory) ----
app.get('/api/llm/config', wrap((req) => req.session.config.publicView()));
app.put('/api/llm/config', wrap((req) => req.session.config.save(req.body)));
app.post('/api/llm/test', wrap((req) => req.session.agent.testProvider()));

// ---- generated tests ----
app.get('/api/tests/file', (req, res) => {
  const generated = req.session.agent.generatedTests;
  if (!generated) return res.status(404).json({ error: 'No generated tests yet' });
  res.setHeader('Content-Type', 'text/x-python; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${generated.fileName.replace(/[^\w.-]/g, '_')}"`);
  res.send(generated.code);
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ---- static Angular app ----
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST, { index: 'index.html', maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
} else {
  app.get('/', (_req, res) => res.status(503).send('UI not built. Run `pnpm build`, or use `pnpm start` for the Angular dev server.'));
}

const server = app.listen(PORT, HOST, () => {
  console.log(`Website Testing Agent ${VERSION} listening on http://${HOST}:${PORT} (browser ${HEADLESS ? 'headless' : 'headed'})`);
  if (!fs.existsSync(DIST)) console.log('dist/ not found: serving API only. Run `pnpm build` to serve the UI from here.');
});

async function shutdown() {
  await sessions.closeAll().catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, sessions };
