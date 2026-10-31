// Drives the Playwright browser the agent works in.
// On a server the browser runs headless and the user watches it through a
// live view: CDP screencast frames are emitted as 'frame' events and streamed
// to the browser tab. HEADLESS=false shows the real window for local runs.
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');

const MIN_FRAME_INTERVAL_MS = 150;

class BrowserController extends EventEmitter {
  constructor({ headless = true } = {}) {
    super();
    this.headless = headless;
    this.lastFrameAt = 0;
    this.cdp = null;
    /** @type {import('playwright').Browser | null} */
    this.browser = null;
    /** @type {import('playwright').BrowserContext | null} */
    this.context = null;
    /** @type {import('playwright').Page | null} */
    this.page = null;
    this.windowBounds = { x: 0, y: 0, width: 1280, height: 900 };
    this.launching = null;
  }

  setWindowBounds(bounds) {
    this.windowBounds = bounds;
  }

  async ensurePage() {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.launching) this.launching = this.launch().finally(() => (this.launching = null));
    await this.launching;
    return this.page;
  }

  async launch() {
    await this.close();
    const { x, y, width, height } = this.windowBounds;
    this.browser = await chromium.launch({
      headless: this.headless,
      args: this.headless ? [] : [`--window-position=${x},${y}`, `--window-size=${width},${height}`],
    });
    this.browser.on('disconnected', () => {
      this.browser = null;
      this.context = null;
      this.page = null;
      this.emit('event', { type: 'closed' });
    });

    // A fresh, isolated context per session: no cookies or storage carry over.
    this.context = await this.browser.newContext(this.headless ? { viewport: { width: 1280, height: 800 } } : { viewport: null });
    this.page = await this.context.newPage();
    await this.startScreencast();

    this.page.on('framenavigated', (frame) => {
      if (frame === this.page.mainFrame()) {
        this.emit('event', { type: 'navigated', url: frame.url() });
      }
    });
    this.page.on('load', async () => {
      const title = await this.page.title().catch(() => '');
      this.emit('event', { type: 'loaded', url: this.page.url(), title });
    });
    this.page.on('close', () => this.emit('event', { type: 'page-closed' }));
  }

  /** Stream JPEG frames of the page through 'frame' events, throttled. */
  async startScreencast() {
    try {
      this.cdp = await this.context.newCDPSession(this.page);
      this.cdp.on('Page.screencastFrame', (frame) => {
        this.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
        const now = Date.now();
        if (now - this.lastFrameAt < MIN_FRAME_INTERVAL_MS) return;
        this.lastFrameAt = now;
        this.emit('event', {
          type: 'frame',
          data: frame.data,
          url: this.page?.url() ?? null,
          width: frame.metadata?.deviceWidth ?? null,
          height: frame.metadata?.deviceHeight ?? null,
        });
      });
      await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 45, maxWidth: 1024, maxHeight: 768, everyNthFrame: 2 });
    } catch (err) {
      this.cdp = null;
      this.emit('event', { type: 'frame-error', message: err.message });
    }
  }

  /** @param {string} url already validated by the caller */
  async open(url) {
    const page = await this.ensurePage();
    const started = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return {
      url: page.url(),
      title: await page.title(),
      elapsedMs: Date.now() - started,
    };
  }

  async screenshot() {
    const page = await this.ensurePage();
    const buffer = await page.screenshot({ type: 'jpeg', quality: 70 });
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  }

  status() {
    const running = Boolean(this.page && !this.page.isClosed());
    return { running, url: running ? this.page.url() : null };
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.cdp = null;
    if (browser) await browser.close().catch(() => undefined);
  }

  /** "Reset" from the spec: throw away the browser and all its state. */
  async reset() {
    await this.close();
    this.emit('event', { type: 'reset' });
    return { ok: true };
  }
}

module.exports = { BrowserController };
