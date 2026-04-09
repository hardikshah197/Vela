# Vela — Workspace Manager for AI Coding Agents

Vela is a workspace manager UI for AI coding agents (Claude Code, OpenAI Codex, Ralph Loop). It provides a dashboard to create, manage, and connect to real terminal sessions that spawn CLI agents in isolated PTY environments.

```
+---------------------------+       WebSocket        +---------------------------+
|   Browser (Dashboard)     | ───────────────────>   |   Go Backend              |
|   localhost:6001          |                        |   localhost:6100          |
|                           |   HTTP API             |                           |
|   - Workspace CRUD        | ───────────────────>   |   - Project resolution    |
|   - Filter & manage       |                        |   - GitHub fork/clone     |
|   - Open terminal tabs    |                        |   - PTY session mgmt      |
|   - PIN / Passkey auth    |                        |   - Auth (PIN + WebAuthn) |
+---------------------------+                        +---------------------------+
        |                                                      |
        | Opens new tab                                        | Spawns
        v                                                      v
+---------------------------+       WebSocket        +---------------------------+
|   Browser (Terminal)      | <────────────────────> |   PTY Process (cgo)       |
|   xterm.js                |   bidirectional        |   (claude / codex / bash) |
+---------------------------+                        +---------------------------+
```

---

## Installation

Choose the method that works best for you:

| Method | Best for | Command |
|--------|----------|---------|
| **Homebrew** | macOS users | `brew tap hardikshah197/tap && brew install vela` |
| **Docker** | Cross-platform, no local deps | `docker pull ghcr.io/hardikshah197/vela:latest` |
| **Binary download** | Manual install, no package manager | Download from [Releases](https://github.com/hardikshah197/Vela/releases) |
| **From source** | Contributors, customization | Clone + build |

### Option 1: Homebrew (macOS — recommended)

```bash
brew tap hardikshah197/tap
brew install vela
```

Start the server:
```bash
vela
```

Open **http://localhost:6100** in your browser. That's it.

Supports both Apple Silicon (M1/M2/M3/M4) and Intel Macs.

### Option 2: Docker

```bash
docker pull ghcr.io/hardikshah197/vela:latest

docker run -p 6100:6100 \
  -v $HOME/Desktop:/workspace \
  -v $HOME/.claude:/root/.claude \
  ghcr.io/hardikshah197/vela:latest
```

Open **http://localhost:6100**.

With Docker Compose:
```bash
git clone https://github.com/hardikshah197/Vela.git && cd Vela
docker-compose up
```

Multi-arch image available for both `amd64` and `arm64`.

### Option 3: Binary Download

1. Download the tarball for your platform from [GitHub Releases](https://github.com/hardikshah197/Vela/releases/latest):
   - `vela-1.0.0-darwin-arm64.tar.gz` — macOS Apple Silicon
   - `vela-1.0.0-darwin-amd64.tar.gz` — macOS Intel

2. Extract and run:
```bash
tar xzf vela-1.0.0-darwin-*.tar.gz
cd vela-1.0.0-darwin-*/
./bin/vela-server
```

3. Open **http://localhost:6100**.

### Option 4: From Source

**Prerequisites:**
- **Go 1.21+** (with CGO enabled — default on macOS)
- **Node.js 18+** and npm
- **`gh` CLI** (optional, for GitHub search/fork/clone)

```bash
git clone https://github.com/hardikshah197/Vela.git
cd Vela

# Install frontend dependencies
npm install

# Build everything (Go backend + frontend)
npm run build:all

# Run
./vela-server
```

Open **http://localhost:6100**.

**For development** (with hot-reload), run two processes:
```bash
npm run server    # Go backend on http://localhost:6100
npm run dev       # Vite dev server on http://localhost:6001
```

Then use **http://localhost:6001** (Vite proxies API calls to the backend).

---

### First Launch — Onboarding

On your first visit, Vela walks you through a setup wizard:

1. **Welcome** — overview of features
2. **Project Directories** — configure where Vela looks for your projects (search roots) and where GitHub repos are cloned
3. **Security (optional)** — set a PIN and/or register a system passkey (Touch ID / Windows Hello) to protect the dashboard

All settings can be changed later from the Settings panel.

---

### Environment Variables

Override defaults without touching the UI:

```bash
# Custom project directories
VELA_SEARCH_ROOTS=~/projects,~/work vela

# Custom clone directory
VELA_CLONE_DIR=~/repos vela

# Custom port
PORT=8080 vela
```

---

## Build & Dev Commands

| Command              | Description                                          |
|----------------------|------------------------------------------------------|
| `npm install`        | Install frontend dependencies                        |
| `npm run dev`        | Vite dev server at http://localhost:6001              |
| `npm run server`     | Start Go backend at http://localhost:6100             |
| `npm run build`      | Frontend production build to `dist/`                 |
| `npm run build:server` | Build Go backend binary (`server/` -> `./vela-server`) |
| `npm run build:all`  | Build both frontend and backend                      |
| `npm run lint`       | ESLint (flat config, React hooks + refresh plugins)  |
| `npm run preview`    | Preview production build                             |

**Development requires two processes:** `npm run dev` (frontend on :6001) and `npm run server` (backend on :6100). The frontend detects port 6001 and hardcodes API/WS calls to `localhost:6100`.

---

## Architecture

**Frontend:** React 19 + Vite, vanilla JSX (no TypeScript), inline styles only (no CSS framework/modules).

**Backend:** Go HTTP server (`server/` directory) serving WebSocket terminal sessions, REST API, and static files from `dist/`.

### File Structure

```
Vela/
├── index.html              # Entry: workspace dashboard
├── terminal.html           # Entry: terminal session page
├── vite.config.js          # Multi-page Vite build config
├── package.json            # Dependencies & scripts
├── Dockerfile              # Multi-stage Docker build
├── docker-compose.yml      # Docker Compose config
├── CLAUDE.md               # Claude Code project instructions
├── server/
│   ├── main.go             # HTTP server, static serving, config
│   ├── session.go          # PTY/WebSocket session lifecycle
│   ├── api.go              # REST API endpoints
│   ├── auth.go             # PIN + WebAuthn authentication
│   ├── ptyutil.go          # cgo PTY allocation (openpty)
│   └── go.mod / go.sum     # Go module dependencies
├── src/
│   ├── main.jsx            # Bootstrap for dashboard
│   ├── App.jsx             # Dashboard app (auth, workspaces, settings)
│   ├── terminal.jsx        # Terminal page (xterm.js + WebSocket)
│   └── assets/             # Static assets
└── public/
    └── vela.svg            # Favicon
```

### Multi-Page App

Vela is a **multi-page app** with two independent entry points:

| Entry           | File               | Purpose                        |
|-----------------|--------------------|--------------------------------|
| `index.html`    | `src/App.jsx`      | Workspace manager dashboard    |
| `terminal.html` | `src/terminal.jsx` | xterm.js terminal per session  |

---

## Authentication

Vela supports optional authentication to protect the dashboard:

### PIN Authentication

- Set a 4–6 digit numeric PIN during onboarding or in Settings
- PIN is hashed (SHA-256 + salt) and stored in `~/.vela/auth.json`
- On each visit, enter your PIN to unlock the dashboard

### Passkey / Touch ID

- Register your system passkey (Touch ID, Windows Hello, etc.) via WebAuthn
- Uses platform authenticator with ES256 (ECDSA P-256)
- Passkey auto-prompts on page load for quick unlock
- Falls back to PIN entry if passkey is unavailable

### Lock / Unlock

- When auth is enabled, a **Lock** button appears in the dashboard header
- Clicking Lock clears your session token and returns to the auth gate
- Sessions use Bearer tokens stored in `localStorage` with 24-hour server-side expiry

### Configuration

Auth settings are stored in `~/.vela/auth.json`:
```json
{
  "onboardingDone": true,
  "enabled": true,
  "pinHash": "...",
  "pinSalt": "...",
  "fingerprintEnabled": true,
  "webauthnCredId": "...",
  "webauthnPubKey": "..."
}
```

All auth is optional — disable it anytime from Settings.

---

## Data Flow

### Complete Lifecycle Flowchart

```
┌─────────────────────────────────────────────────────────────────────┐
│                        WORKSPACE CREATION                           │
│                                                                     │
│  User clicks "New Workspace"                                        │
│       │                                                             │
│       v                                                             │
│  CreateModal opens (step 1: form)                                   │
│       │                                                             │
│       ├── User types project name                                   │
│       │       │                                                     │
│       │       v  (600ms debounce)                                   │
│       │   GET /api/resolve-project?name=...                         │
│       │       │                                                     │
│       │       ├── Found locally ──> Show path                       │
│       │       │                                                     │
│       │       └── Not found ──> GET /api/github-search?name=...     │
│       │                │                                            │
│       │                ├── Results ──> Show repos + "Fork & Clone"  │
│       │                │                    │                       │
│       │                │                    v                       │
│       │                │              POST /api/fork-clone          │
│       │                │                    │                       │
│       │                │                    v                       │
│       │                │              Cloned to CLONE_DIR           │
│       │                │                                            │
│       │                └── No results ──> Manual path entry         │
│       │                                                             │
│       ├── User selects agent type (Claude / Codex / Ralph / Bash)   │
│       ├── User toggles CLI arguments                                │
│       └── Click "Launch Workspace"                                  │
│               │                                                     │
│               v                                                     │
│       Workspace added to state + localStorage                       │
│       Card appears in dashboard grid                                │
│       Terminal tab opens automatically                               │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              v
┌─────────────────────────────────────────────────────────────────────┐
│                      TERMINAL CONNECTION                            │
│                                                                     │
│  terminal.jsx loads in new tab                                      │
│       │                                                             │
│       ├── Create xterm.js Terminal + FitAddon                       │
│       ├── Restore local scrollback from localStorage                │
│       └── Connect WebSocket (with auth token)                       │
│               │                                                     │
│               v                                                     │
│  ws://localhost:6100?agent=claude&args=...&id=XYZ&cwd=...&token=... │
│               │                                                     │
│               v                                                     │
│  ┌─────── Server checks sessions Map ──────┐                       │
│  │                                          │                       │
│  │  Session exists & alive?                 │                       │
│  │     YES ──> RECONNECT (replay scrollback)│                       │
│  │     NO  ──> NEW SESSION (spawn PTY)      │                       │
│  └──────────────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Frontend: Dashboard (`src/App.jsx`)

### Components

```
App
├── OnboardingFlow (first launch: welcome, paths, security)
├── AuthGate (PIN pad + passkey prompt)
├── Header (title, Lock button, Settings, Session Manager)
├── Filter Tabs (All | Running | Idle | Stopped | Claude | Codex | Ralph)
├── Workspace Grid
│   └── WorkspaceCard (one per workspace)
│       ├── StatusBadge
│       ├── Agent/service tags
│       └── Action buttons (Connect / Stop / Resume / Delete)
├── CreateModal (workspace creation wizard)
├── SettingsModal (auth, directories, theme)
└── SessionManagerModal (detect/manage orphan sessions)
```

### Key Data Structures

**Workspace Model** (persisted in localStorage):
```javascript
{
  id: "ABC1234",              // Random 7-char ID
  name: "bug-fix-auth",
  services: [{                // Multi-service support
    id: "svc1",
    name: "Claude Code",
    agent: "claude",
    args: ["--dangerously-skip-permissions"],
    path: "/Users/me/project",
  }],
  status: "running",          // "running" | "idle" | "stopped"
  createdAt: 1678901234567,
}
```

**Agent Types:**
| Agent  | Color     | Icon | Brand         |
|--------|-----------|------|---------------|
| Claude | `#f97316` | `◆`  | Claude Code   |
| Codex  | `#8b5cf6` | `⛛`  | OpenAI Codex  |
| Ralph  | `#06b6d4` | `↻`  | Ralph Loop    |
| Bash   | `#22c55e` | `❯`  | Shell         |

### Themes

8 preset themes (Ember, Ocean, Forest, Violet, Rose, Cyber, Gold, Arctic) plus custom color picker. Theme selection is persisted in localStorage and affects accent colors throughout the UI including the auth settings section.

### State Management

- All state is local React state (`useState`)
- Workspaces persisted to `localStorage` under key `vela-workspaces`
- Auth token persisted in `localStorage` under key `vela-auth-token`
- Settings persisted in `localStorage` under key `vela-settings`
- No router, no global store, no external state library

### Session Reconciliation

When the page becomes visible after system sleep (>30 seconds hidden), the dashboard:
1. Calls `GET /api/sessions` to check which backend sessions are alive
2. Marks workspaces as "stopped" if their backend session no longer exists
3. If the backend is unreachable, marks all running workspaces as stopped

This prevents stale "running" status after system sleep kills backend sessions.

---

## Frontend: Terminal (`src/terminal.jsx`)

### URL Parameters

```
/terminal.html?agent=claude&args=--verbose&name=my-workspace&id=ABC1234&cwd=/path&token=...
```

| Param       | Description                           |
|-------------|---------------------------------------|
| `agent`     | CLI command to spawn                  |
| `args`      | Comma-separated CLI arguments         |
| `name`      | Workspace name (display only)         |
| `id`        | Session ID (used for reconnection)    |
| `cwd`       | Working directory for PTY             |
| `token`     | Auth token (for authenticated access) |
| `loopCount` | Ralph only: max iterations            |
| `donePrompt`| Ralph only: completion criteria       |

### Connection State Machine

```
                ┌──────────────┐
                │  CONNECTING  │
                └──────┬───────┘
                       │ ws.onopen
                       v
                ┌──────────────┐
         ┌─────│  CONNECTED   │─────┐
         │      └──────────────┘      │
         │             │              │
         │  ws.onclose │   ws.onclose │
         │  (code≠4000)│  (code=4000) │
         │             │              │
         v             │              v
  ┌──────────────┐     │     ┌────────────────┐
  │ DISCONNECTED │     │     │ SESSION_ENDED  │
  └──────┬───────┘     │     └────────────────┘
         │             │       (no reconnect)
         │ backoff     │
         v             │
  ┌──────────────┐     │
  │ RECONNECTING │─────┘
  └──────┬───────┘
         │ max 12 attempts
         v
  ┌──────────────┐
  │   GAVE_UP    │  "Session Unreachable"
  └──────────────┘  [Retry] [Close Tab]
    (exponential backoff: 1s, 2s, 4s, ... max 10s, capped at 12 attempts)
```

### Features

- **Scrollback persistence:** terminal content saved to localStorage per session, restored on reconnect
- **File upload:** drag-and-drop or paste images into the terminal; uploaded via `/api/upload`, file path inserted into terminal input
- **Screenshot auto-attach:** backend watches for new screenshots and broadcasts paths to all sessions
- **Shift+Enter:** sends literal newline for multi-line input in Claude Code

---

## Backend: Go Server (`server/`)

### Dependencies

- `github.com/gorilla/websocket` — WebSocket support
- cgo `openpty()` — PTY allocation (no third-party PTY library)
- `CGO_ENABLED=1` required for building (default on macOS)

### HTTP API

| Method | Endpoint                      | Auth | Description                          |
|--------|-------------------------------|------|--------------------------------------|
| GET    | `/api/config`                 | Yes  | Returns search roots and clone dir   |
| POST   | `/api/config`                 | Yes  | Update search roots and clone dir    |
| GET    | `/api/resolve-project`        | Yes  | Search local directories by name     |
| GET    | `/api/github-search`          | Yes  | Search GitHub repos via `gh` CLI     |
| POST   | `/api/fork-clone`             | Yes  | Fork and clone a GitHub repo         |
| GET    | `/api/sessions`               | Yes  | List active backend sessions         |
| GET    | `/api/detect-claude-sessions` | Yes  | Find orphaned Claude CLI processes   |
| POST   | `/api/kill-process`           | Yes  | Kill an external process by PID      |
| POST   | `/api/kill-session`           | Yes  | Kill a Vela-managed session          |
| POST   | `/api/upload`                 | Yes  | Base64 file upload (returns path)    |
| GET    | `/api/file-preview`           | Yes  | Serve uploaded/screenshot images     |
| GET    | `/api/auth/status`            | No   | Auth configuration and status        |
| POST   | `/api/auth/setup`             | No   | First-time onboarding setup          |
| POST   | `/api/auth/verify-pin`        | No   | Verify PIN and get session token     |
| POST   | `/api/auth/update`            | No   | Change PIN, toggle auth/fingerprint  |
| POST   | `/api/auth/logout`            | No   | Invalidate session token             |
| GET    | `/api/auth/webauthn/*`        | No   | WebAuthn registration/login flows    |

"Auth: Yes" means the endpoint requires a valid `Authorization: Bearer <token>` header when authentication is enabled.

### WebSocket Protocol

**Connection URL:**
```
ws://localhost:6100?agent=<cmd>&args=<csv>&id=<sessionId>&cwd=<path>&token=<authToken>
```

**Client -> Server Messages:**
```javascript
{ "type": "input",  "data": "user keystroke" }   // Terminal input
{ "type": "resize", "cols": 120, "rows": 30 }    // Terminal resize
{ "type": "kill" }                                 // Kill session
```

**Server -> Client:**
- Binary frames: raw PTY output (may contain invalid UTF-8)
- Text frames: JSON control messages (`__vela` field):

| Control Message          | Purpose                                    |
|--------------------------|--------------------------------------------|
| `{"__vela":"reconnect"}` | Client should reset terminal (scrollback follows) |
| `{"__vela":"new_session"}` | New PTY spawned (first connect or session expired) |
| `{"__vela":"spawn_failed"}` | PTY spawn failed (session ended)         |
| `{"__vela":"screenshot","path":"..."}` | Screenshot detected, path auto-inserted |

**Close Codes:**
| Code   | Meaning                                    |
|--------|--------------------------------------------|
| `4000` | Session ended or killed (don't reconnect)  |
| Other  | Unexpected disconnect (auto-reconnect)     |

### Session Lifecycle

```
┌─────────────────────────────────────────────┐
│           sessions: sync.Map<id, *Session>   │
│                                              │
│  Session {                                   │
│    ptyFile       // os.File (PTY master)     │
│    cmd           // exec.Cmd                 │
│    ws            // Current WebSocket | nil  │
│    scrollback[]  // Output buffer (<=512KB)  │
│    dead          // Marked for cleanup       │
│    orphanTimer   // 10-min cleanup timer     │
│    cwd           // Working directory        │
│    agent         // Agent command name       │
│    writeCh       // Serialized write channel │
│  }                                           │
└─────────────────────────────────────────────┘
```

- **PTY spawn is deferred** until the first `resize` message (ensures correct terminal dimensions)
- **Agent exit** drops to a login shell in the same session
- **Disconnects** start a 10-minute orphan timer; reconnect within that window to resume
- **Scrollback** is capped at 512KB; replayed in full on reconnect

### macOS Sequoia Note

`creack/pty`'s `forkpty()` is blocked for ad-hoc signed binaries on macOS Sequoia. Vela uses cgo `openpty()` in `ptyutil.go` + Go's `os/exec` to avoid this. Do not use `Setpgid` with `Setsid` in `SysProcAttr` — it triggers "operation not permitted" on Sequoia.

### Environment Variables

| Variable              | Default                              | Description                  |
|-----------------------|--------------------------------------|------------------------------|
| `VELA_SEARCH_ROOTS`  | `~/Desktop`                          | Directories to search for projects (comma-separated) |
| `VELA_CLONE_DIR`     | `~/Desktop/workplace/lambdatest`     | Where GitHub repos are cloned |
| `PORT`               | `6100`                               | Server port                  |
| `SHELL`              | `/bin/zsh`                           | Login shell for fallback     |

The server also:
- Extracts the user's full `PATH` from their login shell
- Sets `TERM=xterm-256color` and `FORCE_COLOR=1`
- **Strips `CLAUDECODE` env var** so Claude CLI doesn't detect a nested session

---

## Docker

### Build & Run

```bash
docker build -t vela .
docker run -p 6100:6100 \
  -v $HOME/Desktop:/workspace \
  -v $HOME/.claude:/root/.claude \
  vela
```

### Docker Compose

```bash
docker-compose up
```

The `docker-compose.yml` mounts host directories for project access and maps ports 6100 (backend) and 6001 (dev server).

### Multi-Stage Build

The `Dockerfile` uses a three-stage build:
1. **Go builder** — compiles the backend binary with CGO
2. **Frontend builder** — runs `npm install` + `npm run build`
3. **Runtime** — Debian slim with the binary, built frontend, and required tools (git, gh, claude)

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Go backend with cgo PTY** | Real terminal emulation without `forkpty()` issues on macOS Sequoia |
| **Inline styles only** | No CSS framework, no class conflicts, co-located with components |
| **Multi-page app** | Dashboard and terminal are independent; terminal opens in new tabs |
| **WebAuthn for passkeys** | Native system authenticator (Touch ID, Windows Hello) without third-party deps |
| **PIN + passkey optional** | Security without friction — user chooses during onboarding |
| **Scrollback buffering** | Enables session reconnection with full history replay |
| **Client-side scrollback** | localStorage backup survives backend restarts |
| **Orphan timeout (10 min)** | Balances resource cleanup vs. reconnection after brief disconnects |
| **Capped reconnect (12 attempts)** | Prevents infinite reconnect loops; shows manual retry button |
| **Session reconciliation on wake** | Detects dead sessions after system sleep via visibility change API |
| **Bearer token auth** | Works across origins in dev (frontend :6001, backend :6100) without CORS cookie issues |
| **localStorage persistence** | Workspaces survive browser refresh; no database needed |
| **No global state library** | Simple enough for local React state; no Redux/Zustand overhead |

---

## Known Issues

- `CGO_ENABLED=1` is required for building the Go backend. This is the default on macOS but must be set explicitly for cross-compilation or Docker builds.
- Unicode escape sequences in JSX text must use expression syntax: `{"\u00B7"}` not bare `\u00B7`.
- `server.js` (old Node.js backend) is still in the repo but unused — the Go backend (`server/`) is the active backend.
- Server sessions are in-memory only — a server restart loses all active PTY sessions (but workspace list persists in browser localStorage).
- WebAuthn passkey registration requires `localhost` origin (or HTTPS in production).
