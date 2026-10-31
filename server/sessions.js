// One agent per browser session. The session id travels in an httpOnly
// cookie; the agent, its Playwright browser and its in-memory LLM settings are
// dropped after IDLE_MINUTES without any request or open event stream.
const { randomUUID } = require('node:crypto');
const { BrowserController } = require('./browser-controller');
const { AgentSession } = require('./agent/session');
const { SessionConfig } = require('./config-store');

const COOKIE = 'wta_sid';
const IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES) || 30;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 20;

class Sessions {
  constructor({ headless }) {
    this.headless = headless;
    /** @type {Map<string, {id: string, agent: AgentSession, controller: BrowserController, config: SessionConfig, lastSeen: number, streams: Set<import('http').ServerResponse>}>} */
    this.map = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000).unref();
  }

  create() {
    if (this.map.size >= MAX_SESSIONS) {
      const oldest = [...this.map.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) this.destroy(oldest.id);
    }
    const id = randomUUID();
    const controller = new BrowserController({ headless: this.headless });
    const config = new SessionConfig();
    const agent = new AgentSession({ controller, getConfig: () => config.resolve() });
    const session = { id, agent, controller, config, lastSeen: Date.now(), streams: new Set() };
    const forward = (channel) => (event) => {
      const payload = `event: ${channel}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const res of session.streams) res.write(payload);
    };
    controller.on('event', forward('browser'));
    agent.on('event', forward('agent'));
    this.map.set(id, session);
    return session;
  }

  get(id) {
    const session = id ? this.map.get(id) : null;
    if (session) session.lastSeen = Date.now();
    return session ?? null;
  }

  /** Express middleware: attach the caller's session, creating one if needed. */
  middleware() {
    return (req, res, next) => {
      const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
      let session = this.get(cookies[COOKIE]);
      if (!session) {
        session = this.create();
        const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        res.setHeader('Set-Cookie', `${COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
      }
      req.session = session;
      next();
    };
  }

  async destroy(id) {
    const session = this.map.get(id);
    if (!session) return;
    this.map.delete(id);
    for (const res of session.streams) res.end();
    await session.controller.close().catch(() => undefined);
  }

  sweep() {
    const cutoff = Date.now() - IDLE_MINUTES * 60_000;
    for (const session of this.map.values()) {
      if (session.lastSeen < cutoff && session.streams.size === 0) void this.destroy(session.id);
    }
  }

  async closeAll() {
    clearInterval(this.timer);
    await Promise.all([...this.map.keys()].map((id) => this.destroy(id)));
  }
}

module.exports = { Sessions, COOKIE };
