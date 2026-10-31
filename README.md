# Website Testing Agent (website edition)

A human-in-the-loop QA assistant that runs as a normal website: a tester chats
with an agent that drives a browser on the server through four phases,
Explore, Design, Implement and Verify, and watches it work through a live view.
The full specification lives in `docs/project_modfied.pdf`. The desktop
(Electron) edition is on the `main` branch; this branch replaces the Electron
shell with a Node server and keeps the Angular UI.

## Architecture

- **Angular 22 UI** (`src/`): chat, test plan review, generated code, screenshots,
  page model, metrics, settings, plus a live view of the agent's browser. It
  talks to the server through `src/app/core/http-agent-api.ts`, which implements
  the same `AgentApi` contract the Electron preload used, so the components are
  shared between editions.
- **Node server** (`server/index.js`, Express): serves the built UI, exposes a
  JSON API under `/api`, and streams agent and browser events over server-sent
  events at `/api/events`.
- **Sessions** (`server/sessions.js`): one agent, one Playwright browser and one
  in-memory settings object per browser session (httpOnly cookie). Idle sessions
  are closed after 30 minutes.
- **Agent** (`server/agent/`): exploration with verified locators, structured
  test design, Python test generation with self-checks. **Providers**
  (`server/llm/`): Gemini free tier, local Ollama, and an offline mock for
  development (`LLM_PROVIDER=mock`).
- **Live view**: the server's Chromium runs headless and its frames are streamed
  (CDP screencast, JPEG, a few frames per second) to the right-hand panel, so
  the user still sees every step in real time. `HEADLESS=false` opens a real
  window for local runs.

## How exploration works (Phase 1)

1. Interactive elements are extracted from the live DOM with plain code.
2. Locator candidates are generated in a fixed preference order (test id,
   role + name, label, placeholder, stable id, text, name attribute, href, CSS
   path) and **verified against the page**: a candidate is accepted only when it
   matches exactly that element and nothing else. Each element also gets the
   Python form of its locator.
3. The model describes the page using only those element ids; invented ids are
   dropped and counted.
4. Every model call records latency and token usage for the Metrics tab and the
   header counter.

## Test design (Phase 2) and code generation (Phase 3)

- **Design.** The agent proposes structured cases (typed steps and expectations
  that may only reference page elements). The reviewer unticks cases and sends
  feedback; the plan is revised with stable ids.
- **Generate.** A pytest + Playwright (Python) file for the selected cases. The
  server checks that every locator in the code is in the verified table and that
  the file compiles (`python3 -m py_compile`, when Python is installed on the
  server); one repair round runs automatically and leftovers are flagged.
- **Use it.** Copy, or Download the file, then run it locally:
  `pip install pytest pytest-playwright && playwright install chromium && pytest test_<host>.py --headed`
  (inside a virtual environment on distributions that block system-wide pip).

## Running

```bash
pnpm install
pnpm exec playwright install chromium   # browser for the server, once

# development: API server + Angular dev server with proxy
pnpm dev                                # http://127.0.0.1:3000, API only
pnpm start                              # http://localhost:4200, proxies /api to 3000

# production: build the UI and serve everything from the Node server
pnpm serve:prod                         # http://127.0.0.1:3000
pnpm test                               # unit tests
```

## Docker (recommended for Windows, servers and the cloud)

One image contains both the frontend and the backend: the build stage compiles
the Angular app to static files, the runtime stage (Playwright's official image,
which already includes Chromium and its system libraries) serves those files
and the API from one port. Nothing is downloaded at first use.

```bash
cp .env.example .env            # put your GEMINI_API_KEY in .env
docker compose up -d --build    # http://localhost:3000
docker compose logs -f agent
```

Or without compose:

```bash
docker build -t website-testing-agent:0.1.0 .
docker run -d --name wta -p 3000:3000 --shm-size=1g \
  -e GEMINI_API_KEY=... -e BLOCK_PRIVATE_URLS=1 website-testing-agent:0.1.0
```

On Windows, install Docker Desktop (WSL 2 backend) and run the same commands
in PowerShell. The container runs as Playwright's unprivileged `pwuser`, drops
all capabilities, and `/api/health` serves as the liveness probe. For a server
reachable by others, put a TLS-terminating reverse proxy with authentication in
front of it and set `TRUST_PROXY=1`.

## Configuration (server environment)

`pnpm server`, `pnpm dev` and `pnpm serve:prod` load a `.env` file from the
project root when one exists (`cp .env.example .env`), and docker compose reads
the same file. `.env` is git-ignored; keep your key there, never in the repo.

| Variable | Meaning |
|---|---|
| `PORT`, `HOST` | default `3000`, `127.0.0.1`. Set `HOST=0.0.0.0` to accept remote connections |
| `HEADLESS` | `false` shows the agent's browser window (local use); default headless with live view |
| `LLM_PROVIDER` | `gemini`, `ollama`, or `mock` (offline, development only) |
| `GEMINI_API_KEY` | Gemini key for every session; keys entered in the UI are kept in session memory only |
| `GEMINI_MODEL` | default `gemini-3.8-flash` |
| `OLLAMA_URL`, `OLLAMA_MODEL` | default `http://127.0.0.1:11434`, `llama3.1` |
| `LLM_TIMEOUT_SEC` | per-request model timeout, default 60 (5 to 600) |
| `BLOCK_PRIVATE_URLS` | `1` refuses loopback and private-network targets (recommended for public deployments) |
| `SESSION_IDLE_MINUTES`, `MAX_SESSIONS` | default `30`, `20` |
| `TRUST_PROXY` | `1` when behind a reverse proxy that sets `X-Forwarded-*` |

### Security notes

- The server listens on loopback by default and sends a strict Content Security
  Policy, `X-Frame-Options: DENY` and other hardening headers.
- API requests are same-origin only; cross-origin POSTs are rejected.
- Only http and https URLs reach the agent's browser. With `BLOCK_PRIVATE_URLS=1`
  the server also refuses local and private addresses, so it cannot be used to
  probe the network it runs in.
- Settings and API keys entered in the UI are per session and in memory; nothing
  is written to disk. Permanent configuration belongs in the environment.
- Put a TLS-terminating reverse proxy and authentication in front of it before
  exposing it beyond your machine: the app itself has no login.

## Try it on an example website

[https://www.saucedemo.com](https://www.saucedemo.com) is a practice shop made
for test automation. Paste the URL in the Chat tab.

| User | Password | Behaviour |
|---|---|---|
| `standard_user` | `secret_sauce` | normal login |
| `locked_out_user` | `secret_sauce` | error message |
| `problem_user` | `secret_sauce` | broken images and glitches |

Other good targets: [the-internet.herokuapp.com](https://the-internet.herokuapp.com)
(login `tomsmith` / `SuperSecretPassword!`) and
[practicesoftwaretesting.com](https://practicesoftwaretesting.com).
