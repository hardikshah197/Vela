# Vela Deployment Guide

Vela is a **local-first tool** that orchestrates AI coding agents (Claude Code, OpenAI Codex, Ralph Loop) by spawning them as real PTY processes. This fundamentally shapes how it can be deployed.

---

## Table of Contents

1. [Important: How Vela Works](#important-how-vela-works)
2. [Prerequisites](#prerequisites)
3. [Step 1: Install Vela](#step-1-install-vela)
4. [Step 2: Install AI Agent CLIs](#step-2-install-ai-agent-clis)
5. [Step 3: Run Vela](#step-3-run-vela)
6. [Deployment Options](#deployment-options)
   - [Option A: Direct Install (Recommended)](#option-a-direct-install-recommended)
   - [Option B: npm Global Package](#option-b-npm-global-package)
   - [Option C: Docker (Advanced)](#option-c-docker-advanced)
   - [Option D: systemd Service (Linux)](#option-d-systemd-service-linux)
7. [Configuration](#configuration)
8. [Running Behind a Reverse Proxy](#running-behind-a-reverse-proxy)
9. [Security Considerations](#security-considerations)
10. [Troubleshooting](#troubleshooting)

---

## Important: How Vela Works

Vela does **not** include Claude, Codex, or any AI agent. It is a dashboard that spawns them:

```
User clicks "Connect" on workspace
       │
       v
Vela backend runs: pty.spawn("claude", ["--dangerously-skip-permissions"], { cwd: "/your/project" })
       │
       v
Real `claude` CLI process starts in a PTY
       │
       v
Terminal I/O streams over WebSocket to your browser
```

**This means:**
- The AI agent CLIs (`claude`, `codex`) must be **installed and authenticated** on the same machine running Vela's backend
- Vela needs direct filesystem access to your project directories
- Spawned processes run as the same OS user that runs the Vela server
- Docker deployment requires mounting host CLIs + auth configs into the container

---

## Prerequisites

### Required

| Requirement | Version | Check Command |
|-------------|---------|---------------|
| Node.js | >= 18 (LTS recommended) | `node --version` |
| npm | >= 9 | `npm --version` |
| Git | >= 2.30 | `git --version` |

### At Least One AI Agent CLI

| Agent | Install | Authenticate | Check |
|-------|---------|-------------|-------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude` (follow prompts) | `which claude` |
| OpenAI Codex | `npm install -g @openai/codex` | Set `OPENAI_API_KEY` | `which codex` |

### Optional

| Tool | Purpose | Install |
|------|---------|---------|
| GitHub CLI (`gh`) | GitHub search, fork, clone from dashboard | [cli.github.com](https://cli.github.com) |
| Build tools | Only if `node-pty` prebuilds unavailable | See [platform notes](#platform-notes) |

### Platform Notes

| Platform | Status | Notes |
|----------|--------|-------|
| macOS ARM64 (M1/M2/M3) | Fully supported | `node-pty` prebuilt included |
| macOS x64 | Supported | `node-pty` prebuilt included |
| Linux x64 | Supported | May need: `sudo apt install build-essential python3` |
| Linux ARM64 | Supported | May need build tools |
| Windows | Not supported | PTY semantics differ; use WSL2 |

---

## Step 1: Install Vela

```bash
git clone https://github.com/<your-username>/Vela.git
cd Vela
npm install
```

The `postinstall` script automatically fixes `node-pty` permissions on macOS.

---

## Step 2: Install AI Agent CLIs

Vela spawns these as real processes. They **must** exist in the system PATH.

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code
claude    # First run: authenticate with Anthropic

# OpenAI Codex (optional)
npm install -g @openai/codex
export OPENAI_API_KEY="sk-..."

# Verify they're available
which claude   # Should print a path, e.g. /usr/local/bin/claude
which codex    # Should print a path if installed
```

**If `which claude` prints nothing**, Vela's terminal will show `command not found` when you try to connect.

---

## Step 3: Run Vela

You need **two processes** — the backend (WebSocket + API) and the frontend (UI):

```bash
# Terminal 1: Start backend
npm run server
# Output: [Vela] Backend running on ws://localhost:3001

# Terminal 2: Start frontend dev server
npm run dev
# Output: Local: http://localhost:5173/
```

Open **http://localhost:5173** in your browser.

### Quick Start (both in one terminal)

```bash
npm run server & npm run dev
```

---

## Deployment Options

### Option A: Direct Install (Recommended)

Best for personal use on your development machine.

```bash
# 1. Clone and install
git clone https://github.com/<your-username>/Vela.git ~/Vela
cd ~/Vela
npm install

# 2. Build frontend for production
npm run build

# 3. Start backend
node server.js &

# 4. Serve frontend (pick one)
npx serve dist -l 5173 -s           # Simple static server
# or
npm run preview                       # Vite preview server
```

#### Keep it running with pm2

```bash
npm install -g pm2

# Start backend
pm2 start server.js --name vela-backend

# Start frontend
pm2 start "npx serve dist -l 5173 -s" --name vela-frontend

# Auto-start on boot
pm2 save
pm2 startup
```

---

### Option B: npm Global Package

Package Vela for easy install on any machine:

```bash
# On the target machine
git clone https://github.com/<your-username>/Vela.git
cd Vela
npm install
npm run build
npm run server & npx serve dist -l 5173 -s
```

---

### Option C: Docker (Advanced)

Docker works but requires **mounting host CLI tools and auth** into the container.

#### Why Docker is tricky for Vela

The container won't have `claude` or `codex` installed. You must either:
1. Install them inside the container image, or
2. Mount them from the host

#### Dockerfile (included in repo)

```bash
# Build
docker build -t vela .

# Run — mount your projects + Claude CLI + auth
docker run -d \
  --name vela \
  -p 3001:3001 \
  -p 5173:5173 \
  -v ~/Desktop:/workspace \
  -v $(which claude):/usr/local/bin/claude:ro \
  -v ~/.claude:/root/.claude:ro \
  -v ~/.config/gh:/root/.config/gh:ro \
  -e VELA_SEARCH_ROOTS=/workspace \
  vela
```

#### Docker Compose (included in repo)

```bash
docker compose up -d
```

Edit `docker-compose.yml` to add volume mounts for your agent CLIs:

```yaml
volumes:
  - ~/Desktop:/workspace
  # Mount Claude CLI binary and auth
  - /usr/local/bin/claude:/usr/local/bin/claude:ro
  - ~/.claude:/root/.claude:ro
```

#### Install agents inside the container

Alternatively, add to the `Dockerfile`:

```dockerfile
# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# You'll still need to mount auth:
# -v ~/.claude:/root/.claude:ro
```

**Important Docker limitations:**
- `node-pty` inside Docker still needs the host kernel's PTY support (`tty: true` in compose)
- Agent CLIs may behave differently in a container (missing shell config, different PATH)
- Session detection (`/api/detect-claude-sessions`) scans container processes, not host

---

### Option D: systemd Service (Linux)

Run Vela as a background service on a Linux machine.

Create `/etc/systemd/system/vela.service`:

```ini
[Unit]
Description=Vela Workspace Manager
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/Vela

Environment=NODE_ENV=production
Environment=VELA_SEARCH_ROOTS=/home/youruser/projects
Environment=VELA_CLONE_DIR=/home/youruser/projects/cloned

ExecStart=/usr/bin/node server.js

Restart=on-failure
RestartSec=5

StandardOutput=journal
StandardError=journal
SyslogIdentifier=vela

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable vela
sudo systemctl start vela

# Check status
sudo systemctl status vela
journalctl -u vela -f
```

Serve the frontend separately with Nginx (see [Reverse Proxy](#running-behind-a-reverse-proxy)).

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VELA_SEARCH_ROOTS` | `~/Desktop` | Comma-separated directories to scan for projects |
| `VELA_CLONE_DIR` | `~/Desktop/workplace/lambdatest` | Where GitHub repos are cloned |
| `SHELL` | `/bin/zsh` | Shell used for PTY sessions |
| `NODE_ENV` | — | Set to `production` for deployed environments |

### Frontend Configuration

The frontend connects to the backend via configurable globals. In development, it defaults to `localhost:3001`. For custom deployments, add a script tag to `dist/index.html` and `dist/terminal.html` **after building**:

```html
<script>
  window.__VELA_API_BASE__ = "https://vela.example.com";
  window.__VELA_WS_BASE__ = "wss://vela.example.com";
</script>
```

If serving from the same origin behind a reverse proxy, no changes are needed.

### Settings (Runtime)

Users can configure these from the Settings page in the UI:
- Default codebase directory
- Search roots
- Clone directory
- Theme (color scheme)

Settings persist in `localStorage` (browser) and are synced to the server at runtime.

---

## Running Behind a Reverse Proxy

### Nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

upstream vela_backend {
    server 127.0.0.1:3001;
}

server {
    listen 443 ssl http2;
    server_name vela.example.com;

    ssl_certificate     /etc/ssl/certs/vela.crt;
    ssl_certificate_key /etc/ssl/private/vela.key;

    # Static frontend
    root /opt/vela/dist;
    index index.html;

    # API
    location /api/ {
        proxy_pass http://vela_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket (Vela connects at root path with ?params)
    location @backend {
        proxy_pass http://vela_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    # Route: WebSocket upgrades go to backend, everything else serves files
    location / {
        if ($http_upgrade = "websocket") {
            rewrite ^ @backend last;
        }
        try_files $uri $uri/ /index.html;
    }
}
```

### Caddy

```caddyfile
vela.example.com {
    root * /opt/vela/dist
    file_server

    handle /api/* {
        reverse_proxy localhost:3001
    }

    @websocket {
        header Connection *Upgrade*
        header Upgrade websocket
    }
    handle @websocket {
        reverse_proxy localhost:3001
    }

    handle {
        try_files {path} /index.html
        file_server
    }
}
```

---

## Security Considerations

**Vela spawns real shell processes.** Anyone with UI access can run arbitrary commands.

1. **Never expose to the public internet without auth.** Use VPN, SSH tunnel, or add authentication via reverse proxy.
2. **Run as non-root user.** Spawned processes inherit the server's user.
3. **Restrict CORS** in `server.js` for production (currently `Access-Control-Allow-Origin: *`).
4. **Bind to localhost** if accessed only locally or via reverse proxy.

---

## Troubleshooting

### "command not found" when connecting to workspace

The agent CLI isn't in PATH. Verify:
```bash
which claude    # Must return a path
which codex     # Must return a path (if using Codex)
```

If installed but not found, the server may have a different PATH than your shell. Check:
```bash
# What PATH does Vela see?
curl http://localhost:3001/api/config
# Then verify claude exists in one of those PATH directories
```

### node-pty fails to install

```bash
# Install build tools first
# macOS: xcode-select --install
# Linux: sudo apt install build-essential python3

npm rebuild node-pty
```

### spawn-helper: Permission denied (macOS)

```bash
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

### WebSocket connection refused

- Backend running? `curl http://localhost:3001/api/config`
- Port in use? `lsof -i :3001`
- Behind proxy? Ensure WebSocket upgrade headers are forwarded.

### Sessions lost after server restart

Expected. All PTY sessions are in-memory only. Clients auto-reconnect but will see "Session ended."

### GitHub features not working

```bash
gh auth status   # Must show "Logged in"
```

---

## Quick Reference

```bash
# Install
git clone <repo> && cd Vela && npm install

# Prerequisite check
node --version && which claude && which codex

# Development
npm run server & npm run dev

# Production
npm run build
node server.js & npx serve dist -l 5173 -s

# Docker
docker compose up -d

# Health check
curl http://localhost:3001/api/config
```
