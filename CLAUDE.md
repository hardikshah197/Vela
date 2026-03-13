# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm install          # Install dependencies (postinstall fixes node-pty permissions)
npm run dev          # Start Vite dev server (http://localhost:5173)
npm run server       # Start backend WebSocket server (ws://localhost:3001)
npm run build        # Production build to dist/
npm run preview      # Preview production build locally
```

Both `npm run dev` and `npm run server` must be running for full functionality.

## Architecture

**Stack:** React 19 + Vite (vanilla JSX, no TypeScript, no CSS framework)

**Multi-page app** with two entry points:
- `index.html` → `src/App.jsx` — workspace manager dashboard
- `terminal.html` → `src/terminal.jsx` — xterm.js terminal connected to backend via WebSocket

Styling is done entirely with inline styles (no CSS modules/classes). No external component libraries.

### What it does

Vela is a workspace manager UI for AI coding agents (Claude Code, OpenAI Codex). Users can:
- Create workspaces with configurable agent type and CLI arguments
- Manage workspace lifecycle (run/stop/resume/delete)
- Filter workspaces by status or agent type
- Open a real terminal tab per workspace that spawns the actual CLI agent

### Backend (server.js)

WebSocket server using `node-pty` for real PTY allocation. Each terminal session:
1. Browser connects via `ws://localhost:3001?agent=<cmd>&args=<csv>&id=<session>`
2. Server spawns the agent command in a real PTY via `node-pty`
3. PTY output streams to browser, browser input streams to PTY
4. Resize messages from browser resize the PTY

**Important:** The `CLAUDECODE` env var is stripped from spawned processes so `claude` CLI doesn't refuse to start (nested session detection).

### Key data structures

- `AGENT_ARGS` — available CLI flags per agent type (`claude` | `codex`)
- `AGENT_META` — branding (color, icon, name) per agent type
- `STATUS_COLORS` — visual config for workspace states (`running` | `idle` | `stopped` | `error`)

### Components (src/App.jsx)

- `App` — root; owns workspace state, filter state, renders header/stats/grid/modal
- `WorkspaceCard` — displays a single workspace with status, args, action buttons
- `CreateModal` — two-step modal (form → launch animation) for creating workspaces
- `StatusBadge` — colored dot + label for workspace status
- `openTerminalTab()` — opens `terminal.html` in a new tab with agent/args/id params

### Terminal (src/terminal.jsx)

Standalone React page with xterm.js terminal. Reads query params to configure the session, connects to the backend WebSocket, and renders a themed terminal with title bar and status bar.

### State

All state is local React state (no router, no global store, no persistence). Workspaces are initialized with 3 hardcoded demo entries.

## Known Issues

- `node-pty` prebuilds may ship without execute permission on `spawn-helper`. The `postinstall` script in package.json fixes this automatically.
- Unicode escape sequences in JSX text must use expression syntax: `{"\u00B7"}` not bare `\u00B7`.
