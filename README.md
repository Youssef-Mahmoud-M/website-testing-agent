# Website Testing Agent

A human-in-the-loop QA assistant: a tester chats with an agent that drives a
visible browser through four phases, Explore, Design, Implement and Verify.
The full specification lives in `docs/project_modfied.pdf`.

## Architecture

- **Angular 22 renderer** (`src/`): the chat and dashboard UI. It runs inside
  a sandboxed Electron window with context isolation and no Node access.
- **Electron main process** (`electron/main.js`): the only privileged process.
  It owns the Playwright browser and, later, the LLM API keys.
- **Preload bridge** (`electron/preload.js`): exposes a small typed API on
  `window.agent`. The TypeScript side of that contract is
  `src/app/core/agent-bridge.ts`.
- **Playwright browser** (`electron/browser-controller.js`): a separate headed
  Chromium that the agent explores in and that the generated tests run in.
  It is placed next to the app window, not embedded inside it.
- **Agent session** (`electron/agent/session.js`): conversation, page model,
  screenshots and metrics for one session. `explorer.js` implements Phase 1.
- **LLM providers** (`electron/llm/`): Gemini free tier and local Ollama behind
  one interface. `LLM_PROVIDER=mock` selects an offline provider for development.
- **Settings** (`electron/config-store.js`): provider and model choices are
  stored in the Electron userData folder; the Gemini key is encrypted with the
  OS keychain through `safeStorage` and is never returned to the renderer.

## How exploration works (Phase 1)

1. The page's interactive elements are extracted from the live DOM with plain
   code: tag, role, accessible name, label, placeholder, test ids, href.
2. For each element, locator candidates are generated in a fixed preference
   order (test id, role + name, label, placeholder, stable id, text, name
   attribute, href, CSS path) and **verified against the page**: a candidate is
   accepted only when it matches exactly that element and nothing else.
3. The model receives the inventory plus an accessibility snapshot and may refer
   to elements only by their reference ids. Any id it invents is dropped and
   counted, so hallucinated elements never reach the page model.
4. Every model call records end-to-end latency, model latency and token usage;
   the Metrics tab shows averages per iteration, per phase and per page.

## Test design (Phase 2) and code generation (Phase 3)

- **Design.** From the Test Plan tab or the chat, the agent proposes structured
  test cases: steps (`goto`, `click`, `fill`, `select`, `check`, `uncheck`,
  `press`, `hover`) and expectations (`visible`, `hidden`, `text`, `value`,
  `url`, `title`, `enabled`, `disabled`, `checked`, `count`) that may only
  reference element ids from the page model. Anything else is dropped and
  counted. The reviewer unticks cases and sends feedback; the plan is revised
  with stable ids and a feedback history.
- **Generate.** For the selected cases the agent writes a pytest +
  Playwright (Python, sync API) file. Every element carries a Python locator
  derived from the verified one (`page.get_by_role(...)`, `page.get_by_test_id(...)`,
  `page.locator(...)`). The generated file is then checked: every locator in the
  code must appear in the verified table, and the file must compile with
  `python3 -m py_compile`. Problems trigger one repair round with the model;
  anything left is flagged line by line in the Code tab.
- **Use it.** Copy or save the file (through the OS save dialog, in the main
  process), then run it with
  `pip install pytest pytest-playwright && playwright install chromium && pytest test_<host>.py --headed`.
  On distributions that block system-wide pip installs (PEP 668, e.g. Arch),
  run that inside a virtual environment: `python -m venv .venv && source .venv/bin/activate` first
  (`.venv\Scripts\activate` on Windows).
  Copy verifies that the text reached the clipboard and falls back to
  `wl-copy`, `xclip` or `xsel` when Electron's clipboard fails, which happens
  under XWayland on some compositors.

## UI tabs

Chat (paste a URL to explore, then discuss; each reply shows its token usage and
time), Test Plan (review, select and refine cases), Code (generated Python with
validation results), Screenshots (full-size gallery), Page Model (verified
element inventory), Metrics (response time and tokens per iteration, phase and
page), Settings (provider, model, API key, request timeout). The header shows a
running token counter for the session; click it for the Metrics tab.

## Try it on an example website

[https://www.saucedemo.com](https://www.saucedemo.com) is a practice shop made
for test automation. Paste the URL in the Chat tab: the login page has a handful
of controls with stable `data-test` attributes, so the explore phase is quick
and the generated tests use test-id locators.

| User | Password | Behaviour |
|---|---|---|
| `standard_user` | `secret_sauce` | normal login |
| `locked_out_user` | `secret_sauce` | error message |
| `problem_user` | `secret_sauce` | broken images and glitches |

Other good targets: [the-internet.herokuapp.com](https://the-internet.herokuapp.com)
(one feature per page, login `tomsmith` / `SuperSecretPassword!`) and
[practicesoftwaretesting.com](https://practicesoftwaretesting.com) (a realistic
shop with 80+ interactive elements per page).

## Packaging

```bash
pnpm package:linux   # release/Website Testing Agent-<version>-linux-x86_64.AppImage
pnpm package:win     # release/... -win-x64.exe (installer) and ...-portable.exe
pnpm package:all
```

Windows builds are produced on Linux through electron-builder (wine is needed
to set the executable's icon and version). The packaged app downloads Chromium
for Playwright into its user-data folder the first time a page is opened, with
progress shown in the chat, so no `playwright install` step is needed by users.

## Configuration

Use the Settings tab, or environment variables as a fallback:

| Variable | Meaning |
|---|---|
| `LLM_PROVIDER` | `gemini`, `ollama`, or `mock` (offline, development only) |
| `GEMINI_API_KEY` | Gemini key when not stored through Settings |
| `GEMINI_MODEL` | default `gemini-3.8-flash` |
| `OLLAMA_URL`, `OLLAMA_MODEL` | default `http://127.0.0.1:11434`, `llama3.1` |
| `LLM_TIMEOUT_SEC` | per-request model timeout, default 60 (5 to 600) |
| `WTA_PASSWORD_STORE` | Linux keyring backend for key encryption: `gnome-libsecret`, `kwallet6` or `basic` |

### API key storage

The key is encrypted with the OS keychain whenever one is available. Chromium
only auto-detects the keyring on well-known desktops, so on others (Hyprland,
Sway, i3...) the app selects the Secret Service backend itself; gnome-keyring or
KWallet must be running. Without any keychain, a key entered in Settings is kept
in memory for the session, or, if you tick the opt-in box, saved unencrypted
with 0600 permissions. A plaintext key is re-encrypted automatically the next
time the app starts with a keychain available.

### Security posture

- `app.enableSandbox()`, `contextIsolation: true`, `nodeIntegration: false`.
- Content Security Policy in `src/index.html`: scripts only from the app,
  no remote connections from the renderer.
- The app window refuses to navigate anywhere but its own UI; external links
  open in the system browser.
- Every IPC input is validated in the main process; only http and https URLs
  reach the automated browser.
- All permission requests (camera, geolocation, ...) are denied.

## Running

```bash
pnpm install
pnpm exec playwright install chromium   # one-time browser download

pnpm start            # Angular dev server on http://localhost:4200
pnpm electron:dev     # in a second terminal: Electron pointed at the dev server

pnpm electron:build   # production build, then launch Electron on dist/
pnpm test             # unit tests (Vitest)
```

VS Code terminals set `ELECTRON_RUN_AS_NODE=1`, which turns the Electron
binary into plain Node. The `electron:*` scripts go through `scripts/electron.js`,
which removes it on every platform. If you launch Electron by hand, unset the
variable first (`env -u ELECTRON_RUN_AS_NODE electron .` on Linux and macOS,
`set ELECTRON_RUN_AS_NODE=` in cmd, `Remove-Item Env:ELECTRON_RUN_AS_NODE` in PowerShell).
