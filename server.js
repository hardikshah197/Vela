import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { execSync, exec } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, extname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import pty from 'node-pty';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// --- Config ---
// Search roots: directories to scan when resolving project names
let SEARCH_ROOTS = (process.env.VELA_SEARCH_ROOTS || join(process.env.HOME, 'Desktop')).split(',');
// Where to clone new repos from GitHub
let CLONE_DIR = process.env.VELA_CLONE_DIR || join(process.env.HOME, 'Desktop', 'workplace', 'lambdatest');
const LOGIN_SHELL = process.env.SHELL || '/bin/zsh';

if (!existsSync(CLONE_DIR)) {
  mkdirSync(CLONE_DIR, { recursive: true });
}

// Get the full PATH from user's login shell
let shellPath = process.env.PATH;
try {
  shellPath = execSync(`${LOGIN_SHELL} -ilc 'echo $PATH'`, {
    encoding: 'utf-8',
    timeout: 5000,
  }).trim();
} catch {}

const shellEnv = {
  ...process.env,
  PATH: shellPath,
  TERM: 'xterm-256color',
  FORCE_COLOR: '1',
};
delete shellEnv.CLAUDECODE;

// --- HTTP API ---
function sendJSON(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function handleAPI(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    return sendJSON(res, {});
  }

  if (url.pathname === '/api/config' && req.method === 'GET') {
    return sendJSON(res, { searchRoots: SEARCH_ROOTS, cloneDir: CLONE_DIR, defaultCodebaseDir: SEARCH_ROOTS[0] || '' });
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { searchRoots, cloneDir } = JSON.parse(body);
        if (Array.isArray(searchRoots) && searchRoots.length > 0) {
          SEARCH_ROOTS = searchRoots;
        }
        if (cloneDir && typeof cloneDir === 'string') {
          CLONE_DIR = cloneDir;
          if (!existsSync(CLONE_DIR)) mkdirSync(CLONE_DIR, { recursive: true });
        }
        console.log(`[Vela] Config updated: roots=${SEARCH_ROOTS.join(',')}, cloneDir=${CLONE_DIR}`);
        sendJSON(res, { success: true, searchRoots: SEARCH_ROOTS, cloneDir: CLONE_DIR });
      } catch {
        sendJSON(res, { error: 'Invalid JSON body' }, 400);
      }
    });
    return;
  }

  if (url.pathname === '/api/resolve-project') {
    const name = url.searchParams.get('name');
    if (!name) return sendJSON(res, { error: 'name required' }, 400);

    // Search across all roots for directories matching the name (max depth 5, case-insensitive)
    const findArgs = SEARCH_ROOTS.map(
      root => `find "${root}" -maxdepth 5 -type d -iname "${name}" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null`
    ).join(' ; ');

    exec(findArgs, { timeout: 5000, env: shellEnv }, (err, stdout) => {
      const matches = (stdout || '').trim().split('\n').filter(Boolean);
      if (matches.length > 0) {
        // Return all matches, sorted by path length (shortest = most likely top-level project)
        matches.sort((a, b) => a.length - b.length);
        sendJSON(res, {
          found: true,
          source: 'local',
          path: matches[0],
          allMatches: matches.slice(0, 10),
        });
      } else {
        sendJSON(res, { found: false, source: null, searchRoots: SEARCH_ROOTS });
      }
    });
    return;
  }

  if (url.pathname === '/api/github-search') {
    const name = url.searchParams.get('name');
    if (!name) return sendJSON(res, { error: 'name required' }, 400);

    exec(
      `gh search repos "${name}" --json fullName,url,description --limit 8`,
      { env: shellEnv, timeout: 15000 },
      (err, stdout) => {
        if (err) {
          return sendJSON(res, { results: [], error: 'gh CLI not available or not authenticated' });
        }
        try {
          sendJSON(res, { results: JSON.parse(stdout) });
        } catch {
          sendJSON(res, { results: [] });
        }
      }
    );
    return;
  }

  if (url.pathname === '/api/fork-clone' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { repoFullName } = JSON.parse(body);
        if (!repoFullName) return sendJSON(res, { error: 'repoFullName required' }, 400);

        const repoName = repoFullName.split('/').pop();
        const clonePath = join(CLONE_DIR, repoName);

        console.log(`[Vela] Fork+clone: ${repoFullName} → ${clonePath}`);

        // Try fork+clone first (works for both own and others' repos)
        exec(
          `gh repo fork "${repoFullName}" --clone --default-branch-only`,
          { env: shellEnv, timeout: 60000, cwd: CLONE_DIR },
          (err) => {
            if (!err || existsSync(clonePath)) {
              return sendJSON(res, { success: true, path: clonePath, action: 'forked_and_cloned' });
            }
            // Fallback: plain clone (for own repos or public repos)
            exec(
              `gh repo clone "${repoFullName}" "${clonePath}"`,
              { env: shellEnv, timeout: 60000 },
              (err2, _stdout2, stderr2) => {
                if (err2) {
                  return sendJSON(res, { success: false, error: stderr2 || err2.message });
                }
                sendJSON(res, { success: true, path: clonePath, action: 'cloned' });
              }
            );
          }
        );
      } catch {
        sendJSON(res, { error: 'Invalid JSON body' }, 400);
      }
    });
    return;
  }

  if (url.pathname === '/api/detect-claude-sessions') {
    const filterCwd = url.searchParams.get('cwd');

    // Collect PIDs managed by Vela so we can exclude them
    const managedPids = new Set();
    for (const [, s] of sessions) {
      if (s.ptyProc && !s.dead) {
        managedPids.add(s.ptyProc.pid);
      }
    }

    exec(
      `ps -eo pid,command 2>/dev/null`,
      { env: shellEnv, timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) {
          return sendJSON(res, { sessions: [] });
        }

        const lines = stdout.trim().split('\n').filter(Boolean);
        const detected = [];

        for (const line of lines) {
          const match = line.trim().match(/^\s*(\d+)\s+(.+)$/);
          if (!match) continue;
          const pid = parseInt(match[1]);
          const cmd = match[2];

          // Must be an actual claude CLI invocation (starts with 'claude' as the command)
          if (!/(?:^|\/)claude\s/.test(cmd) && !/(?:^|\/)claude$/.test(cmd)) continue;
          // Skip shell wrappers, grep, and other utility processes
          if (cmd.startsWith('/bin/') || cmd.includes('server.js') || cmd.includes('grep') || cmd.includes('lsof')) continue;
          // Skip Vela-managed PTY processes
          if (managedPids.has(pid)) continue;
          // Skip our own process
          if (pid === process.pid) continue;

          detected.push({ pid, command: cmd });
        }

        if (detected.length === 0) {
          return sendJSON(res, { sessions: [] });
        }

        // Get working directories for detected PIDs via lsof
        const pids = detected.map(d => d.pid).join(',');
        exec(
          `lsof -a -d cwd -Fn -p ${pids} 2>/dev/null`,
          { env: shellEnv, timeout: 5000 },
          (err2, lsofOut) => {
            const cwdMap = {};
            if (lsofOut) {
              let currentPid = null;
              for (const l of lsofOut.split('\n')) {
                if (l.startsWith('p')) currentPid = parseInt(l.slice(1));
                else if (l.startsWith('n') && currentPid) cwdMap[currentPid] = l.slice(1);
              }
            }

            let results = detected.map(d => ({
              pid: d.pid,
              command: d.command.length > 120 ? d.command.slice(0, 120) + '...' : d.command,
              cwd: cwdMap[d.pid] || null,
              projectName: cwdMap[d.pid] ? cwdMap[d.pid].split('/').pop() : 'unknown',
            })).filter(d => d.cwd);

            // Filter by cwd if requested
            if (filterCwd) {
              results = results.filter(d => d.cwd === filterCwd);
            }

            sendJSON(res, { sessions: results });
          }
        );
      }
    );
    return;
  }

  if (url.pathname === '/api/kill-process' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { pid } = JSON.parse(body);
        if (!pid || typeof pid !== 'number') return sendJSON(res, { error: 'valid pid required' }, 400);

        // Verify it's a claude process before killing (safety check)
        exec(`ps -p ${pid} -o command= 2>/dev/null`, { timeout: 3000 }, (err, stdout) => {
          if (err || !stdout || !/\bclaude\b/.test(stdout)) {
            return sendJSON(res, { error: 'Process not found or not a Claude session' }, 404);
          }
          try {
            process.kill(pid, 'SIGTERM');
            console.log(`[Vela] Killed external process: ${pid}`);
            sendJSON(res, { success: true });
          } catch (killErr) {
            sendJSON(res, { success: false, error: killErr.message }, 500);
          }
        });
      } catch {
        sendJSON(res, { error: 'Invalid JSON body' }, 400);
      }
    });
    return;
  }

  if (url.pathname === '/api/kill-session' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { sessionId: sid } = JSON.parse(body);
        if (!sid) return sendJSON(res, { error: 'sessionId required' }, 400);
        const s = sessions.get(sid);
        if (!s) return sendJSON(res, { error: 'Session not found' }, 404);
        console.log(`[Vela] Killing Vela session via API: ${sid}`);
        if (s.ptyProc) s.ptyProc.kill();
        s.dead = true;
        if (s.orphanTimer) clearTimeout(s.orphanTimer);
        if (s.ws && s.ws.readyState === 1) {
          s.ws.close(4000, 'killed');
        }
        sessions.delete(sid);
        sendJSON(res, { success: true });
      } catch {
        sendJSON(res, { error: 'Invalid JSON body' }, 400);
      }
    });
    return;
  }

  if (url.pathname === '/api/upload' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { sessionId: sid, fileName, data } = JSON.parse(body);
        if (!data) return sendJSON(res, { error: 'data required' }, 400);

        // Save to /tmp/vela-uploads/<sessionId>/
        const uploadDir = join(tmpdir(), 'vela-uploads', sid || 'unknown');
        if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

        // Sanitize filename, add timestamp to avoid collisions
        const ts = Date.now();
        const safeName = (fileName || 'image.png').replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = join(uploadDir, `${ts}-${safeName}`);

        // Decode base64 and write
        const buffer = Buffer.from(data, 'base64');
        writeFileSync(filePath, buffer);

        console.log(`[Vela] Upload: ${filePath} (${buffer.length} bytes)`);
        sendJSON(res, { success: true, path: filePath });
      } catch (err) {
        sendJSON(res, { error: err.message || 'Upload failed' }, 500);
      }
    });
    return;
  }

  sendJSON(res, { error: 'Not found' }, 404);
}

// --- Server setup ---
const MIME_TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

const DIST_DIR = join(__dirname, 'dist');

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let filePath = join(DIST_DIR, url.pathname === '/' ? 'index.html' : url.pathname);

  if (!existsSync(filePath)) {
    // SPA fallback — serve index.html for unknown routes (but not terminal.html)
    if (url.pathname.startsWith('/terminal')) {
      filePath = join(DIST_DIR, 'terminal.html');
    } else {
      filePath = join(DIST_DIR, 'index.html');
    }
  }

  try {
    const data = readFileSync(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    handleAPI(req, res);
  } else {
    serveStatic(req, res);
  }
});

const wss = new WebSocketServer({ server });
const sessions = new Map();

// Max scrollback buffer size per session (bytes)
const SCROLLBACK_LIMIT = 512 * 1024; // 512KB
// How long to keep a disconnected session alive before cleanup
const ORPHAN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const agent = url.searchParams.get('agent') || 'bash';
  const args = (url.searchParams.get('args') || '').split(',').filter(Boolean);
  const sessionId = url.searchParams.get('id') || 'unknown';
  const cwd = url.searchParams.get('cwd') || process.env.HOME;

  // Check if we can reconnect to an existing session
  const existing = sessions.get(sessionId);
  if (existing && existing.ptyProc && !existing.dead) {
    console.log(`[Vela] Reconnecting session: ${sessionId}`);

    // Clear any pending orphan cleanup
    if (existing.orphanTimer) {
      clearTimeout(existing.orphanTimer);
      existing.orphanTimer = null;
    }

    // Attach the new WebSocket
    existing.ws = ws;

    // Signal reconnect, then replay buffered output
    ws.send(JSON.stringify({ __vela: 'reconnect' }));
    if (existing.scrollback.length > 0) {
      ws.send(existing.scrollback.join(''));
    }

    // Re-wire PTY output to the new WebSocket
    if (existing.dataDisposable) existing.dataDisposable.dispose();
    existing.dataDisposable = existing.ptyProc.onData((data) => {
      existing.pushScrollback(data);
      if (ws.readyState === 1) ws.send(data);
    });

    // Handle input from the new client
    ws.on('message', (data) => {
      const proc = existing.ptyProc;
      const msg = data.toString();
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'kill') {
          console.log(`[Vela] Kill requested for session: ${sessionId}`);
          if (proc) proc.kill();
          existing.dead = true;
          if (existing.orphanTimer) clearTimeout(existing.orphanTimer);
          ws.close(4000, 'killed');
          sessions.delete(sessionId);
          return;
        }
        if (!proc) return;
        if (parsed.type === 'input') {
          proc.write(parsed.data);
        } else if (parsed.type === 'resize') {
          proc.resize(parsed.cols, parsed.rows);
        }
      } catch {
        if (proc) proc.write(msg);
      }
    });

    ws.on('close', () => {
      console.log(`[Vela] Session ${sessionId} disconnected (will persist)`);
      existing.ws = null;
      scheduleOrphanCleanup(existing, sessionId);
    });

    return;
  }

  console.log(`[Vela] New session: ${sessionId} → ${agent} ${args.join(' ')} in ${cwd}`);

  // Signal to client this is a fresh session (no scrollback to replay)
  ws.send(JSON.stringify({ __vela: 'new_session' }));

  // Create a new session with scrollback buffer
  const session = {
    ptyProc: null,
    ws,
    scrollback: [],
    scrollbackSize: 0,
    dead: false,
    dataDisposable: null,
    orphanTimer: null,
    cwd,
    agent,
    pushScrollback(data) {
      this.scrollback.push(data);
      this.scrollbackSize += data.length;
      // Trim scrollback if it exceeds the limit
      while (this.scrollbackSize > SCROLLBACK_LIMIT && this.scrollback.length > 1) {
        this.scrollbackSize -= this.scrollback.shift().length;
      }
    },
  };
  sessions.set(sessionId, session);

  function spawnPty(cmd, cmdArgs, workDir) {
    const proc = pty.spawn(cmd, cmdArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: shellEnv,
    });
    session.ptyProc = proc;

    // Dispose previous data listener if any
    if (session.dataDisposable) session.dataDisposable.dispose();
    session.dataDisposable = proc.onData((data) => {
      session.pushScrollback(data);
      if (session.ws && session.ws.readyState === 1) session.ws.send(data);
    });

    return proc;
  }

  // Spawn the agent
  const agentProc = spawnPty(agent, args, cwd);

  // When agent exits, drop into a shell in the same project directory
  agentProc.onExit(({ exitCode }) => {
    console.log(`[Vela] ${agent} exited for ${sessionId} with code ${exitCode}`);

    const exitMsg = `\r\n\x1b[90m[${agent} exited with code ${exitCode}]\x1b[0m\r\n` +
                    `\x1b[90m[Dropping to shell in ${cwd}]\x1b[0m\r\n\r\n`;
    session.pushScrollback(exitMsg);
    if (session.ws && session.ws.readyState === 1) {
      session.ws.send(exitMsg);
    }

    if (!session.ws || session.ws.readyState !== 1) {
      // No client connected - still spawn shell so it's available on reconnect
    }

    const shellProc = spawnPty(LOGIN_SHELL, ['-l'], cwd);

    shellProc.onExit(() => {
      console.log(`[Vela] Shell exited for ${sessionId}`);
      session.dead = true;
      if (session.ws && session.ws.readyState === 1) {
        session.ws.send(`\r\n\x1b[90m[Session ended]\x1b[0m\r\n`);
        session.ws.close(4000, 'session_ended');
      }
      sessions.delete(sessionId);
    });
  });

  ws.on('message', (data) => {
    const proc = session.ptyProc;
    const msg = data.toString();
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'kill') {
        console.log(`[Vela] Kill requested for session: ${sessionId}`);
        if (proc) proc.kill();
        session.dead = true;
        if (session.orphanTimer) clearTimeout(session.orphanTimer);
        ws.close(4000, 'killed');
        sessions.delete(sessionId);
        return;
      }
      if (!proc) return;
      if (parsed.type === 'input') {
        proc.write(parsed.data);
      } else if (parsed.type === 'resize') {
        proc.resize(parsed.cols, parsed.rows);
      }
    } catch {
      if (proc) proc.write(msg);
    }
  });

  ws.on('close', () => {
    console.log(`[Vela] Session ${sessionId} disconnected (will persist)`);
    session.ws = null;
    scheduleOrphanCleanup(session, sessionId);
  });
});

function scheduleOrphanCleanup(session, sessionId) {
  if (session.orphanTimer) clearTimeout(session.orphanTimer);
  session.orphanTimer = setTimeout(() => {
    // Only clean up if still disconnected
    if (!session.ws && sessions.has(sessionId)) {
      console.log(`[Vela] Cleaning up orphaned session: ${sessionId}`);
      if (session.ptyProc) session.ptyProc.kill();
      sessions.delete(sessionId);
    }
  }, ORPHAN_TIMEOUT_MS);
}

const PORT = process.env.PORT || 6100;
server.listen(PORT, () => {
  console.log(`[Vela] Running on port ${PORT}`);
  console.log(`[Vela] Search roots: ${SEARCH_ROOTS.join(', ')}`);
});
