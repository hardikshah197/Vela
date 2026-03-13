# Vela — Workspace Manager for AI Coding Agents

Vela is a workspace manager UI for AI coding agents (Claude Code, OpenAI Codex, Ralph Loop). It provides a dashboard to create, manage, and connect to real terminal sessions that spawn CLI agents in isolated PTY environments.

```
+---------------------------+       WebSocket        +---------------------------+
|   Browser (Dashboard)     | ───────────────────>   |   Node.js Backend         |
|   localhost:5173          |                        |   localhost:3001          |
|                           |   HTTP API             |                           |
|   - Workspace CRUD        | ───────────────────>   |   - Project resolution    |
|   - Filter & manage       |                        |   - GitHub fork/clone     |
|   - Open terminal tabs    |                        |   - PTY session mgmt      |
+---------------------------+                        +---------------------------+
        |                                                      |
        | Opens new tab                                        | Spawns
        v                                                      v
+---------------------------+       WebSocket        +---------------------------+
|   Browser (Terminal)      | <────────────────────> |   node-pty Process        |
|   xterm.js                |   bidirectional        |   (claude / codex / bash) |
+---------------------------+                        +---------------------------+
```

## Quick Start

```bash
npm install          # Install dependencies
npm run server       # Start backend (ws://localhost:3001)
npm run dev          # Start frontend (http://localhost:5173)
```

Both must be running for full functionality.

## Build & Dev Commands

| Command             | Description                                |
|---------------------|--------------------------------------------|
| `npm install`       | Install dependencies (fixes node-pty perms)|
| `npm run dev`       | Vite dev server at http://localhost:5173    |
| `npm run server`    | Backend WebSocket server at ws://localhost:3001 |
| `npm run build`     | Production build to `dist/`                |
| `npm run preview`   | Preview production build locally           |

---

## Architecture

**Stack:** React 19 + Vite (vanilla JSX, no TypeScript, no CSS framework), Node.js backend with node-pty and ws

### File Structure

```
Vela/
├── index.html              # Entry: workspace dashboard
├── terminal.html           # Entry: terminal session page
├── server.js               # Node.js backend (WebSocket + HTTP API + PTY)
├── vite.config.js          # Multi-page Vite build config
├── package.json            # Dependencies & scripts
├── CLAUDE.md               # Claude Code project instructions
├── src/
│   ├── main.jsx            # Bootstrap for dashboard
│   ├── App.jsx             # Dashboard app (workspaces, modal, filters)
│   ├── terminal.jsx        # Terminal page (xterm.js + WebSocket client)
│   └── assets/             # Static assets
└── public/
    └── vela.svg            # Favicon
```

### Multi-Page App

Vela is a **multi-page app** with two independent entry points, each built as a separate bundle by Vite:

| Entry           | File               | Purpose                        |
|-----------------|--------------------|--------------------------------|
| `index.html`    | `src/App.jsx`      | Workspace manager dashboard    |
| `terminal.html` | `src/terminal.jsx` | xterm.js terminal per session  |

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
│       ├── User selects agent type (Claude / Codex / Ralph)          │
│       ├── User toggles CLI arguments                                │
│       └── Click "Launch Workspace"                                  │
│               │                                                     │
│               v                                                     │
│       Step 2: Launch animation (1.8s)                               │
│               │                                                     │
│               v                                                     │
│       Workspace added to state + localStorage                       │
│       Card appears in dashboard grid                                │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              v
┌─────────────────────────────────────────────────────────────────────┐
│                      TERMINAL CONNECTION                            │
│                                                                     │
│  User clicks "Connect" on workspace card                            │
│       │                                                             │
│       v                                                             │
│  openTerminalTab(ws) ──> window.open(terminal.html?params)          │
│       │                                                             │
│       │  URL params: agent, args, name, id, cwd                     │
│       │                                                             │
│       v                                                             │
│  terminal.jsx loads in new tab                                      │
│       │                                                             │
│       ├── Create xterm.js Terminal                                   │
│       ├── Create FitAddon                                           │
│       └── Connect WebSocket                                         │
│               │                                                     │
│               v                                                     │
│  ws://localhost:3001?agent=claude&args=...&id=XYZ&cwd=...           │
│               │                                                     │
│               v                                                     │
│  ┌─────── Server checks sessions Map ──────┐                       │
│  │                                          │                       │
│  │  Session exists?                         │                       │
│  │     YES ──> RECONNECT path               │                       │
│  │     NO  ──> NEW SESSION path             │                       │
│  └──────────────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              v                               v
┌──────────────────────┐       ┌──────────────────────────┐
│     NEW SESSION       │       │     RECONNECT SESSION     │
│                       │       │                           │
│ 1. Create session obj │       │ 1. Clear orphan timer     │
│ 2. Store in Map       │       │ 2. Attach new WebSocket   │
│ 3. pty.spawn(agent,   │       │ 3. Replay scrollback buf  │
│    args, {cwd, env})  │       │ 4. Re-wire PTY → new WS   │
│ 4. Wire PTY → WS      │       │ 5. Resume input handling  │
│ 5. Hook onExit        │       │                           │
│ 6. Buffer scrollback  │       │ Client: term.reset()      │
│                       │       │ then receives replay      │
└──────────────────────┘       └──────────────────────────┘
              │                               │
              └───────────────┬───────────────┘
                              v
┌─────────────────────────────────────────────────────────────────────┐
│                     REAL-TIME INTERACTION                            │
│                                                                     │
│  ┌──────────┐    { type: 'input', data }    ┌──────────┐           │
│  │  xterm   │ ──────────────────────────>    │  PTY     │           │
│  │  Browser │                                │  Server  │           │
│  │          │ <──────────────────────────    │          │           │
│  └──────────┘    raw terminal output         └──────────┘           │
│                                                                     │
│  ┌──────────┐    { type: 'resize', cols, rows }                     │
│  │  Window  │ ──────────────────────────>  proc.resize(cols, rows)  │
│  │  Resize  │                              SIGWINCH → agent redraws │
│  └──────────┘                                                       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              v
┌─────────────────────────────────────────────────────────────────────┐
│                       SESSION END PATHS                              │
│                                                                     │
│  Path A: Agent Exits Naturally                                      │
│  ────────────────────────────                                       │
│  claude exits (code 0) ──> "[claude exited with code 0]"            │
│       │                    "[Dropping to shell in /path]"            │
│       v                                                             │
│  Server spawns login shell in same cwd                              │
│       │                                                             │
│       v (user types 'exit' or shell exits)                          │
│  "[Session ended]" ──> WebSocket close(4000) ──> client stops       │
│                                                                     │
│  Path B: User Clicks "Stop Session"                                 │
│  ────────────────────────────────────                               │
│  Client sends { type: 'kill' }                                      │
│       │                                                             │
│       v                                                             │
│  Server kills PTY ──> WebSocket close(4000) ──> client stops        │
│  Session deleted from Map                                           │
│                                                                     │
│  Path C: Disconnect + Orphan Timeout                                │
│  ────────────────────────────────────                               │
│  WebSocket closes (tab closed / network drop)                       │
│       │                                                             │
│       v                                                             │
│  PTY stays alive, 10-min timer starts                               │
│       │                                                             │
│       ├── Reconnect within 10 min ──> Resume (Path above)           │
│       │                                                             │
│       └── No reconnect after 10 min ──> PTY killed, session deleted │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Frontend: Dashboard (`src/App.jsx`)

### Components

```
App
├── Header (title, "New Workspace" button, stats bar)
├── Filter Tabs (All | Running | Idle | Stopped | Claude | Codex | Ralph)
├── Workspace Grid
│   └── WorkspaceCard (one per workspace)
│       ├── StatusBadge
│       ├── Agent tag
│       ├── Argument tags
│       └── Action buttons (Connect / Stop / Resume / Delete)
└── CreateModal (when open)
    ├── Step 1: Form (name, project, agent, args)
    └── Step 2: Launch animation
```

### Key Data Structures

**Workspace Model** (persisted in localStorage):
```javascript
{
  id: "ABC1234",              // Random 7-char ID
  name: "bug-fix-auth",
  agent: "claude",            // "claude" | "codex" | "ralph"
  args: ["--verbose"],        // Selected CLI argument labels
  path: "/Users/me/project",  // Resolved project directory
  status: "running",          // "running" | "idle" | "stopped" | "error"
  createdAt: 1678901234567,
  loopCount: 20,              // Ralph only: max iterations
  donePrompt: "",             // Ralph only: completion criteria
}
```

**Agent Arguments** (`AGENT_ARGS`):
| Agent  | Available Flags |
|--------|----------------|
| Claude | `--dangerously-skip-permissions`, `--chrome`, `--no-auto-approve`, `--verbose`, `--output-format json`, `--max-turns 10` |
| Codex  | `--full-auto`, `--no-confirm`, `--sandbox`, `--model gpt-4o`, `--quiet`, `--approval-policy auto-edit` |
| Ralph  | Loop count (1-200) + done prompt (configured via form, not flags) |

**Agent Branding** (`AGENT_META`):
| Agent  | Color     | Icon | Brand         |
|--------|-----------|------|---------------|
| Claude | `#f97316` | `◆`  | Claude Code   |
| Codex  | `#8b5cf6` | `⛛`  | OpenAI Codex  |
| Ralph  | `#06b6d4` | `↻`  | Ralph Loop    |

**Status Colors** (`STATUS_COLORS`):
| Status  | Dot Color | Label     |
|---------|-----------|-----------|
| Running | `#22c55e` | RUNNING   |
| Idle    | `#f59e0b` | IDLE      |
| Stopped | `#6b7280` | STOPPED   |
| Error   | `#ef4444` | ERROR     |

### State Management

- All state is local React state (`useState`)
- Workspaces persisted to `localStorage` under key `vela-workspaces`
- No router, no global store, no external state library

---

## Frontend: Terminal (`src/terminal.jsx`)

### URL Parameters

```
/terminal.html?agent=claude&args=--verbose,--chrome&name=my-workspace&id=ABC1234&cwd=/path/to/project
```

| Param       | Description                           |
|-------------|---------------------------------------|
| `agent`     | CLI command to spawn                  |
| `args`      | Comma-separated CLI arguments         |
| `name`      | Workspace name (display only)         |
| `id`        | Session ID (used for reconnection)    |
| `cwd`       | Working directory for PTY             |
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
  └──────────────┘
    (retry with exponential backoff: 1s, 2s, 4s, ... max 10s)
```

### Terminal UI Layout

```
┌────────────────────────────────────────────────────────────────┐
│  ● ● ●   workspace-name · SESSION_ID    [Agent]  [Stop Session] │  ← Title Bar
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  xterm.js terminal                                             │  ← Terminal
│  (full PTY emulation)                                          │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│  ● CONNECTED   SESSION XYZ   WORKSPACE NAME            time   │  ← Status Bar
└────────────────────────────────────────────────────────────────┘
```

---

## Backend: Server (`server.js`)

### HTTP API

| Method | Endpoint               | Description                          |
|--------|------------------------|--------------------------------------|
| GET    | `/api/config`          | Returns search roots and clone dir   |
| GET    | `/api/resolve-project` | Search local directories by name     |
| GET    | `/api/github-search`   | Search GitHub repos via `gh` CLI     |
| POST   | `/api/fork-clone`      | Fork and clone a GitHub repo locally |

### WebSocket Protocol

**Connection URL:**
```
ws://localhost:3001?agent=<cmd>&args=<csv>&id=<sessionId>&cwd=<path>
```

**Client → Server Messages:**
```javascript
{ "type": "input",  "data": "user keystroke" }   // Terminal input
{ "type": "resize", "cols": 120, "rows": 30 }    // Terminal resize
{ "type": "kill" }                                 // Kill session
```

**Server → Client:**
- Raw terminal output strings (ANSI escape codes preserved)
- On reconnect: full scrollback buffer replayed first

**Close Codes:**
| Code   | Meaning                                    |
|--------|--------------------------------------------|
| `4000` | Session ended or killed (don't reconnect)  |
| Other  | Unexpected disconnect (auto-reconnect)     |

### Session Management

```
┌─────────────────────────────────────────────┐
│           sessions: Map<id, Session>         │
│                                              │
│  Session {                                   │
│    ptyProc       // node-pty process         │
│    ws            // Current WebSocket | null │
│    scrollback[]  // Output buffer (≤512KB)   │
│    dead          // Marked for cleanup       │
│    orphanTimer   // 10-min cleanup timer     │
│    cwd           // Working directory        │
│    agent         // Agent command name       │
│  }                                           │
└─────────────────────────────────────────────┘
```

**Scrollback Buffer:**
- Stores all PTY output chunks in an array
- Capped at 512KB; oldest chunks trimmed when exceeded
- Replayed in full to clients on reconnect

**Orphan Cleanup:**
- When WebSocket disconnects, a 10-minute timer starts
- If no reconnection within 10 min, PTY is killed and session deleted
- Timer is cancelled on reconnection

### Environment Variables

| Variable              | Default                              | Description                  |
|-----------------------|--------------------------------------|------------------------------|
| `VELA_SEARCH_ROOTS`  | `~/Desktop`                          | Directories to search for projects (comma-separated) |
| `VELA_CLONE_DIR`     | `~/Desktop/workplace/lambdatest`     | Where GitHub repos are cloned |
| `SHELL`              | `/bin/zsh`                           | Login shell for fallback     |

The server also:
- Inherits the user's full `PATH` from their login shell
- Sets `TERM=xterm-256color` and `FORCE_COLOR=1`
- **Strips `CLAUDECODE` env var** so Claude CLI doesn't detect a nested session and refuse to start

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Inline styles only** | No CSS framework, no class conflicts, co-located with components |
| **Multi-page app** | Dashboard and terminal are independent; terminal opens in new tabs |
| **node-pty for PTY** | Real terminal emulation — supports TUI apps, colors, alternate screen |
| **Scrollback buffering** | Enables session reconnection with full history replay |
| **Orphan timeout (10 min)** | Balances resource cleanup vs. allowing reconnection after brief disconnects |
| **Auto-reconnect with backoff** | Handles network hiccups without manual intervention |
| **Close code 4000** | Distinguishes intentional session end from unexpected disconnects |
| **CLAUDECODE env removal** | Prevents Claude CLI nested session detection |
| **localStorage persistence** | Workspaces survive browser refresh; no database needed |
| **No global state library** | Simple enough for local React state; no Redux/Zustand overhead |

---

## Known Issues

- `node-pty` prebuilds may ship without execute permission on `spawn-helper`. The `postinstall` script fixes this automatically.
- Unicode escape sequences in JSX must use expression syntax: `{"\u00B7"}` not bare `\u00B7`.
- Server sessions are in-memory only — a server restart loses all active sessions.
