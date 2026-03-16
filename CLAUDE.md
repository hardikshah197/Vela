# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm install          # Install frontend dependencies
npm run dev          # Start Vite dev server (http://localhost:5173)
npm run server       # Start Go backend (port 3001, requires built binary)
npm run build        # Frontend production build to dist/
npm run build:server # Build Go backend binary (server/ → ./vela-server)
npm run build:all    # Build both frontend and backend
npm run lint         # ESLint (flat config, React hooks + refresh plugins)
npm run preview      # Preview production build
```

**Development requires two processes:** `npm run dev` (frontend on :5173) and `npm run server` (backend on :3001). The frontend detects port 5173 and hardcodes API/WS calls to `localhost:3001` (no Vite proxy — see `window.__VELA_API_BASE__` / `window.__VELA_WS_BASE__` in terminal.jsx and App.jsx).

## Architecture

**Frontend:** React 19 + Vite, vanilla JSX (no TypeScript), inline styles only (no CSS framework/modules).

**Backend:** Go HTTP server (`server/` directory) serving WebSocket terminal sessions, REST API, and static files from `dist/`.

### Multi-page app with two entry points

- `index.html` → `src/App.jsx` — workspace manager dashboard
- `terminal.html` → `src/terminal.jsx` — xterm.js terminal connected to backend via WebSocket

Configured in `vite.config.js` as multiple Rollup inputs.

### What it does

Vela is a workspace manager UI for AI coding agents (Claude Code, OpenAI Codex, Ralph Loop). Users create workspaces pointing at local or GitHub repos, then launch terminal sessions that spawn the actual CLI agent in a real PTY.

### Backend (Go — `server/`)

Four files: `main.go` (HTTP server, static serving, config), `session.go` (PTY/WebSocket session lifecycle), `api.go` (REST endpoints), `ptyutil.go` (cgo PTY allocation via `openpty()`).

**Dependencies:** `github.com/gorilla/websocket`. PTY allocation uses cgo `openpty()` (no third-party PTY library). This means `CGO_ENABLED=1` is required for building — the default `go build` on macOS satisfies this, but cross-compilation or Docker builds need it explicitly.

**macOS Sequoia note:** `creack/pty`'s `forkpty()` is blocked for ad-hoc signed binaries on macOS Sequoia. The cgo `openpty()` approach in `ptyutil.go` + Go's `os/exec` avoids this. Do not use `Setpgid` with `Setsid` in `SysProcAttr` — it triggers "operation not permitted" on Sequoia.

**WebSocket flow:**
1. Browser connects to `ws://host:3001?agent=<cmd>&args=<csv>&id=<session>&cwd=<path>`
2. PTY spawn is deferred until the first `resize` message from the client (ensures correct terminal dimensions)
3. Bidirectional streaming between PTY and WebSocket via a serialized write channel (`writeCh`)
4. When agent exits, server drops to a login shell in the same session
5. Sessions survive disconnects (10-minute orphan timeout), with scrollback replay on reconnect

**REST API endpoints (all under `/api/`):**
- `GET /api/config` / `POST /api/config` — search roots and clone directory
- `GET /api/resolve-project?name=...` — find local project directories
- `GET /api/github-search?name=...` — search GitHub repos via `gh` CLI
- `POST /api/fork-clone` — fork and clone a GitHub repo
- `GET /api/detect-claude-sessions?cwd=...` — find orphaned Claude processes
- `POST /api/kill-process` / `POST /api/kill-session` — terminate processes/sessions
- `POST /api/upload` — base64 file upload (saved to temp dir, path returned)

**Environment variables:**
- `VELA_SEARCH_ROOTS` — comma-separated dirs to search for projects (default: `~/Desktop`)
- `VELA_CLONE_DIR` — where to clone GitHub repos (default: `~/Desktop/workplace/lambdatest`)
- `PORT` — server port (default: `3001`)
- `CLAUDECODE` env var is stripped from spawned processes to avoid nested session detection

### Frontend key data structures (src/App.jsx)

- `AGENT_ARGS` — available CLI flags per agent type (`claude` | `codex`)
- `AGENT_META` — branding (color, icon, name) per agent type
- `STATUS_COLORS` — visual config for workspace states
- `PRESET_THEMES` — UI theme options with accent colors

### State

All state is local React state (no router, no global store). No backend persistence for workspaces. Terminal scrollback is persisted client-side in `localStorage` per session ID.

### Deployment

Docker support via multi-stage `Dockerfile` (Go build → frontend build → debian runtime). `docker-compose.yml` mounts host directories into the container.

## Known Issues

- Unicode escape sequences in JSX text must use expression syntax: `{"\u00B7"}` not bare `\u00B7`.
- The frontend uses `window.__VELA_API_BASE__` and `window.__VELA_WS_BASE__` to override API/WS URLs (used when dev server port differs from backend port).
- `server.js` (Node.js backend) is still in the repo but unused — the Go backend (`server/`) is the active backend.
