// Drives the visible Playwright browser the agent works in.
// It is a separate Chromium process launched by Playwright, not a view inside
// the Electron window, so the target site never shares a process tree with
// the app and the same engine is used for exploration and for running the
// generated tests.
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');
const { ensureBrowser } = require('./browser-install');

class BrowserController extends EventEmitter {
  constructor() {
    super();
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
    await ensureBrowser((progress) => this.emit('event', { type: 'install-progress', ...progress }));
    const { x, y, width, height } = this.windowBounds;
    this.browser = await chromium.launch({
      headless: false,
      args: [`--window-position=${x},${y}`, `--window-size=${width},${height}`],
    });
    this.browser.on('disconnected', () => {
      this.browser = null;
      this.context = null;
      this.page = null;
      this.emit('event', { type: 'closed' });
    });

    // A fresh, isolated context per session: no cookies or storage carry over.
    this.context = await this.browser.newContext({ viewport: null });
    this.page = await this.context.newPage();

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
