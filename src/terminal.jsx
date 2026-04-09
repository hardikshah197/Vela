import { useEffect, useRef, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const params = new URLSearchParams(window.location.search);
const agent = params.get('agent') || 'bash';
const args = params.get('args') || '';
const wsName = params.get('name') || 'workspace';
const sessionId = params.get('id') || 'unknown';
const cwd = params.get('cwd') || '';
const authToken = params.get('token') || localStorage.getItem('vela-auth-token') || '';

const AGENT_META = {
  claude: { color: '#f97316', icon: '\u25C6', brand: 'Claude Code', rgb: '249,115,22' },
  codex: { color: '#8b5cf6', icon: '\u2B21', brand: 'OpenAI Codex', rgb: '139,92,246' },
  ralph: { color: '#06b6d4', icon: '\u21BB', brand: 'Ralph Loop', rgb: '6,182,212' },
  bash: { color: '#22c55e', icon: '\u276F', brand: 'Shell', rgb: '34,197,94' },
};

const meta = AGENT_META[agent] || AGENT_META.claude;
const API_BASE = window.__VELA_API_BASE__ || (window.location.port === '6001' ? 'http://localhost:6100' : '');

document.title = `${wsName} \u2014 Vela Terminal`;

// --- Client-side scrollback persistence ---
const STORAGE_KEY = `vela-scrollback-${sessionId}`;
const MAX_LOCAL_SCROLLBACK = 256 * 1024; // 256KB

function loadLocalScrollback() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveLocalScrollback(data) {
  try {
    const trimmed = data.length > MAX_LOCAL_SCROLLBACK
      ? data.slice(data.length - MAX_LOCAL_SCROLLBACK)
      : data;
    localStorage.setItem(STORAGE_KEY, trimmed);
  } catch {}
}

function clearLocalScrollback() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

// --- File upload helper ---
async function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result.split(',')[1];
      try {
        const uploadHeaders = { 'Content-Type': 'application/json' };
        if (authToken) uploadHeaders['Authorization'] = `Bearer ${authToken}`;
        const res = await fetch(`${API_BASE}/api/upload`, {
          method: 'POST',
          headers: uploadHeaders,
          body: JSON.stringify({
            sessionId,
            fileName: file.name || 'file',
            data: base64,
          }),
        });
        const json = await res.json();
        if (json.success) {
          resolve(json.path);
        } else {
          reject(new Error(json.error || 'Upload failed'));
        }
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function getFileFromItems(items) {
  for (const item of items) {
    const file = item.getAsFile ? item.getAsFile() : item;
    if (file && file.size > 0) return file;
  }
  return null;
}

// --- Status styles ---
const MAX_RECONNECT_ATTEMPTS = 12; // ~40s total with exponential backoff

const STATUS_STYLES = {
  CONNECTING: { color: '#f59e0b', shadow: 'none' },
  CONNECTED: { color: '#22c55e', shadow: '0 0 8px rgba(34,197,94,0.6)' },
  DISCONNECTED: { color: '#ef4444', shadow: 'none' },
  RECONNECTING: { color: '#f59e0b', shadow: '0 0 8px rgba(245,158,11,0.4)' },
  SESSION_ENDED: { color: '#64748b', shadow: 'none' },
  GAVE_UP: { color: '#ef4444', shadow: 'none' },
};

function TerminalPage() {
  const termRef = useRef(null);
  const xtermRef = useRef(null);
  const wsRef = useRef(null);
  const [connStatus, setConnStatus] = useState('CONNECTING');
  const [sessionEnded, setSessionEnded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null); // null | 'uploading' | { path } | { error }
  const [screenshotToast, setScreenshotToast] = useState(null); // null | { path }
  const disposedRef = useRef(false);
  const reconnectTimerRef = useRef(null);
  const connectRef = useRef(null); // expose connect() for manual retry
  const reconnectAttemptRef = useRef(0);
  const dragCounterRef = useRef(0);

  // Client scrollback buffer — accumulates all terminal data for localStorage
  const scrollbackRef = useRef('');
  const saveTimerRef = useRef(null);

  const handleFileUpload = useCallback(async (file) => {
    if (!file) return;
    setUploadStatus('uploading');
    try {
      const path = await uploadFile(file);
      setUploadStatus({ path });
      // Insert file path into terminal input
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: path }));
      }
      setTimeout(() => setUploadStatus(null), 4000);
    } catch (err) {
      setUploadStatus({ error: err.message });
      setTimeout(() => setUploadStatus(null), 4000);
    }
  }, []);

  const killSession = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'kill' }));
    }
    disposedRef.current = true;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    clearLocalScrollback();
    setConnStatus('SESSION_ENDED');
    setSessionEnded(true);
  }, []);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 14,
      lineHeight: 1.35,
      theme: {
        background: '#080b10',
        foreground: '#f1f5f9',
        cursor: meta.color,
        cursorAccent: '#080b10',
        selectionBackground: 'rgba(255,255,255,0.15)',
        black: '#0d1117',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#8b5cf6',
        cyan: '#06b6d4',
        white: '#f1f5f9',
        brightBlack: '#475569',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#a78bfa',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();
    xtermRef.current = term;

    // Shift+Enter → send newline for multi-line input in Claude Code
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: '\n' }));
        }
        return false;
      }
      return true;
    });

    // --- Restore saved scrollback from localStorage on mount ---
    const savedScrollback = loadLocalScrollback();
    if (savedScrollback) {
      term.write(savedScrollback);
      scrollbackRef.current = savedScrollback;
    }

    // Debounced save to localStorage
    function scheduleSave() {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveLocalScrollback(scrollbackRef.current);
      }, 2000);
    }

    // Append data to client scrollback + save
    function appendScrollback(data) {
      scrollbackRef.current += data;
      // Trim if too large
      if (scrollbackRef.current.length > MAX_LOCAL_SCROLLBACK) {
        scrollbackRef.current = scrollbackRef.current.slice(
          scrollbackRef.current.length - MAX_LOCAL_SCROLLBACK
        );
      }
      scheduleSave();
    }

    // Reset client scrollback (server is sending authoritative copy)
    function resetScrollback() {
      scrollbackRef.current = '';
      scheduleSave();
    }

    reconnectAttemptRef.current = 0;
    let hasConnectedBefore = false;
    let sessionEstablished = false; // true after first new_session is processed

    // Single input handler — always uses current WebSocket ref
    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    function connect() {
      if (disposedRef.current) return;
      setConnStatus(hasConnectedBefore ? 'RECONNECTING' : 'CONNECTING');

      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsBase = window.__VELA_WS_BASE__ || (window.location.port === '6001' ? 'ws://localhost:6100' : `${wsProtocol}//${window.location.host}`);
      const wsUrl = `${wsBase}?agent=${agent}&args=${encodeURIComponent(args)}&id=${sessionId}&cwd=${encodeURIComponent(cwd)}${authToken ? `&token=${encodeURIComponent(authToken)}` : ''}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnStatus('CONNECTED');
        reconnectAttemptRef.current = 0;
        hasConnectedBefore = true;
        // Send current terminal size
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.binaryType = 'arraybuffer';

      ws.onmessage = (e) => {
        const raw = e.data;

        // Text frames (control messages) arrive as strings,
        // Binary frames (PTY data) arrive as ArrayBuffer
        if (typeof raw === 'string') {
          // Text frame — check for Vela control messages
          if (raw.charAt(0) === '{' && raw.includes('"__vela"')) {
            try {
              const ctrl = JSON.parse(raw);
              if (ctrl.__vela === 'reconnect') {
                term.reset();
                resetScrollback();
                return;
              }
              if (ctrl.__vela === 'spawn_failed') {
                spawnFailed = true;
                setConnStatus('SESSION_ENDED');
                setSessionEnded(true);
                saveLocalScrollback(scrollbackRef.current);
                return;
              }
              if (ctrl.__vela === 'screenshot') {
                if (document.hasFocus()) {
                  const ws = wsRef.current;
                  if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'input', data: ctrl.path + ' ' }));
                  }
                }
                setScreenshotToast({ path: ctrl.path });
                setTimeout(() => setScreenshotToast(null), 5000);
                return;
              }
              if (ctrl.__vela === 'new_session') {
                if (sessionEstablished) {
                  // Backend lost the session (restart/timeout) — clear and explain
                  term.reset();
                  resetScrollback();
                  const msg = '\r\n\x1b[33m' +
                    '─'.repeat(60) + '\r\n' +
                    '  Previous session expired\r\n' +
                    '  Starting new agent session...\r\n' +
                    '─'.repeat(60) +
                    '\x1b[0m\r\n\r\n';
                  term.write(msg);
                  appendScrollback(msg);
                } else if (scrollbackRef.current.length > 0) {
                  const divider = '\r\n\x1b[90m' +
                    '─'.repeat(60) + '\r\n' +
                    '  Previous session restored from local cache\r\n' +
                    '  New agent session started below\r\n' +
                    '─'.repeat(60) +
                    '\x1b[0m\r\n\r\n';
                  term.write(divider);
                  appendScrollback(divider);
                }
                sessionEstablished = true;
                return;
              }
            } catch {
              // Not valid JSON — treat as terminal data
            }
          }
          term.write(raw);
          appendScrollback(raw);
        } else {
          // Binary frame — PTY data, pass directly to xterm as Uint8Array
          const bytes = new Uint8Array(raw);
          term.write(bytes);
          // Store as string for scrollback persistence
          const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
          appendScrollback(text);
        }
      };

      ws.onclose = (e) => {
        if (disposedRef.current) return;
        if (e.code === 4000) {
          // Flush final save
          saveLocalScrollback(scrollbackRef.current);
          setConnStatus('SESSION_ENDED');
          setSessionEnded(true);
          return;
        }
        // Immediately save on disconnect so content persists
        saveLocalScrollback(scrollbackRef.current);

        if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
          setConnStatus('GAVE_UP');
          return;
        }

        setConnStatus('DISCONNECTED');
        // Auto-reconnect with exponential backoff (1s, 2s, 4s, ... max 10s)
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 10000);
        reconnectAttemptRef.current++;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose fires after onerror, reconnect handled there
      };
    }

    connectRef.current = connect;
    connect();

    // Handle window resize
    const handleResize = () => {
      fitAddon.fit();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    window.addEventListener('resize', handleResize);

    // Save scrollback before page unload (refresh, close)
    const handleBeforeUnload = () => {
      saveLocalScrollback(scrollbackRef.current);
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    // Clipboard paste handler for files (images, etc.)
    const handlePaste = (e) => {
      if (!e.clipboardData || !e.clipboardData.items) return;
      const file = getFileFromItems(e.clipboardData.items);
      if (file && file.type && !file.type.startsWith('text/')) {
        e.preventDefault();
        handleFileUpload(file);
      }
    };
    document.addEventListener('paste', handlePaste);

    return () => {
      disposedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveLocalScrollback(scrollbackRef.current);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('paste', handlePaste);
      if (wsRef.current) wsRef.current.close();
      term.dispose();
    };
  }, []);

  const statusCfg = STATUS_STYLES[connStatus];
  const showOverlay = connStatus === 'DISCONNECTED' || connStatus === 'RECONNECTING' || connStatus === 'GAVE_UP';

  const handleManualRetry = () => {
    reconnectAttemptRef.current = 0;
    disposedRef.current = false;
    setConnStatus('RECONNECTING');
    if (connectRef.current) connectRef.current();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#080b10' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #080b10; overflow: hidden; }
        .xterm { padding: 8px 12px; }
        @keyframes vela-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes vela-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      {/* Title bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 28px', background: '#0d1117',
        borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, marginRight: 12 }}>
            <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#ef4444' }} />
            <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#f59e0b' }} />
            <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 8px rgba(34,197,94,0.5)' }} />
          </div>
          <span style={{
            fontSize: 16, color: '#e2e8f0', letterSpacing: 0.3, fontWeight: 700,
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {wsName}
          </span>
          <span style={{ fontSize: 14, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>
            &middot;&nbsp; {sessionId}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            fontSize: 13, fontWeight: 700, letterSpacing: 0.5,
            padding: '6px 16px', borderRadius: 20,
            background: meta.color + '18', color: meta.color,
            border: `1px solid ${meta.color}44`,
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {meta.icon} {meta.brand}
          </span>
          {sessionEnded ? (
            <button
              onClick={() => window.close()}
              style={{
                fontSize: 13, fontWeight: 700, letterSpacing: 0.5,
                padding: '6px 16px', borderRadius: 20, cursor: 'pointer',
                background: 'rgba(100,116,139,0.15)', color: '#94a3b8',
                border: '1px solid rgba(100,116,139,0.3)',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              Close Tab
            </button>
          ) : (
            <button
              onClick={killSession}
              style={{
                fontSize: 13, fontWeight: 700, letterSpacing: 0.5,
                padding: '6px 16px', borderRadius: 20, cursor: 'pointer',
                background: 'rgba(239,68,68,0.12)', color: '#ef4444',
                border: '1px solid rgba(239,68,68,0.3)',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              Stop Session
            </button>
          )}
        </div>
      </div>

      {/* Terminal + overlay container */}
      <div
        style={{ flex: 1, overflow: 'hidden', position: 'relative' }}
        onDragEnter={(e) => {
          e.preventDefault();
          dragCounterRef.current++;
          setIsDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          dragCounterRef.current--;
          if (dragCounterRef.current <= 0) {
            dragCounterRef.current = 0;
            setIsDragging(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragCounterRef.current = 0;
          setIsDragging(false);
          const file = getFileFromItems(e.dataTransfer.items || [])
            || (e.dataTransfer.files && e.dataTransfer.files[0]);
          if (file) handleFileUpload(file);
        }}
      >
        <div ref={termRef} style={{ width: '100%', height: '100%' }} />

        {/* Drop zone overlay */}
        {isDragging && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 9998,
            background: 'rgba(8,11,16,0.85)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            border: `3px dashed ${meta.color}`,
            borderRadius: 12, margin: 8,
          }}>
            <div style={{
              fontSize: 40, marginBottom: 16,
              color: meta.color, opacity: 0.9,
            }}>
              {'\u{1F4CE}'}
            </div>
            <div style={{
              fontSize: 16, fontWeight: 700, color: '#e2e8f0', letterSpacing: 1,
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              Drop file here
            </div>
            <div style={{
              fontSize: 12, color: '#64748b', marginTop: 8,
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              File will be saved and path inserted into terminal
            </div>
          </div>
        )}

        {/* Upload toast */}
        {uploadStatus && (
          <div style={{
            position: 'absolute', bottom: 16, right: 16, zIndex: 9998,
            padding: '10px 18px', borderRadius: 10,
            background: uploadStatus === 'uploading'
              ? 'rgba(245,158,11,0.15)'
              : uploadStatus.error
                ? 'rgba(239,68,68,0.15)'
                : 'rgba(34,197,94,0.15)',
            border: `1px solid ${
              uploadStatus === 'uploading' ? 'rgba(245,158,11,0.4)'
                : uploadStatus.error ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.4)'
            }`,
            color: uploadStatus === 'uploading' ? '#f59e0b'
              : uploadStatus.error ? '#ef4444' : '#22c55e',
            fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
            fontFamily: "'JetBrains Mono', monospace",
            maxWidth: 400, wordBreak: 'break-all',
          }}>
            {uploadStatus === 'uploading'
              ? 'Uploading image...'
              : uploadStatus.error
                ? `Upload failed: ${uploadStatus.error}`
                : `Uploaded: ${uploadStatus.path}`
            }
          </div>
        )}

        {/* Screenshot auto-attach toast */}
        {screenshotToast && (
          <div style={{
            position: 'absolute', bottom: uploadStatus ? 70 : 16, left: 16, zIndex: 9998,
            padding: '10px 14px', borderRadius: 10,
            background: 'rgba(6,182,212,0.15)',
            border: '1px solid rgba(6,182,212,0.4)',
            display: 'flex', alignItems: 'center', gap: 12,
            fontFamily: "'JetBrains Mono', monospace",
            maxWidth: 420,
          }}>
            <img
              src={`${API_BASE}/api/file-preview?path=${encodeURIComponent(screenshotToast.path)}`}
              style={{ width: 64, height: 40, objectFit: 'cover', borderRadius: 6, border: '1px solid rgba(6,182,212,0.3)' }}
              alt="Screenshot"
              onError={(e) => { e.target.style.display = 'none'; }}
            />
            <div>
              <div style={{ color: '#06b6d4', fontSize: 12, fontWeight: 600, letterSpacing: 0.5 }}>
                Screenshot attached
              </div>
              <div style={{ color: '#64748b', fontSize: 11, marginTop: 2, wordBreak: 'break-all' }}>
                {screenshotToast.path.split('/').pop()}
              </div>
            </div>
          </div>
        )}

        {/* Reconnecting overlay — high z-index to render above xterm canvas */}
        {showOverlay && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(8,11,16,0.8)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999,
          }}>
            {connStatus !== 'GAVE_UP' ? (
              <>
                <div style={{
                  width: 44, height: 44, borderRadius: '50%',
                  border: '3px solid rgba(255,255,255,0.1)',
                  borderTopColor: meta.color,
                  animation: 'vela-spin 1s linear infinite',
                  marginBottom: 24,
                }} />
                <div style={{
                  fontSize: 18, fontWeight: 700, color: '#e2e8f0', letterSpacing: 1.5,
                  fontFamily: "'JetBrains Mono', monospace",
                  animation: 'vela-pulse 2s ease-in-out infinite',
                }}>
                  CONNECTION LOST
                </div>
                <div style={{
                  fontSize: 14, color: '#94a3b8', marginTop: 12,
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  Reconnecting to session {sessionId}...
                </div>
                <div style={{
                  fontSize: 12, color: '#64748b', marginTop: 20,
                  fontFamily: "'JetBrains Mono', monospace",
                  textAlign: 'center', lineHeight: 1.6, maxWidth: 400,
                }}>
                  Terminal content saved locally.
                  <br />
                  Your conversation will be restored when connection resumes.
                </div>
              </>
            ) : (
              <>
                <div style={{
                  fontSize: 32, marginBottom: 20, opacity: 0.6,
                }}>
                  {'\u26A0'}
                </div>
                <div style={{
                  fontSize: 18, fontWeight: 700, color: '#e2e8f0', letterSpacing: 1.5,
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  SESSION UNREACHABLE
                </div>
                <div style={{
                  fontSize: 14, color: '#94a3b8', marginTop: 12,
                  fontFamily: "'JetBrains Mono', monospace",
                  textAlign: 'center', lineHeight: 1.6, maxWidth: 420,
                }}>
                  Could not reconnect to session {sessionId}.
                  <br />
                  The backend may have restarted or the session expired.
                </div>
                <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
                  <button
                    onClick={handleManualRetry}
                    style={{
                      fontSize: 13, fontWeight: 700, letterSpacing: 0.5,
                      padding: '8px 20px', borderRadius: 20, cursor: 'pointer',
                      background: `${meta.color}22`, color: meta.color,
                      border: `1px solid ${meta.color}55`,
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    Retry Connection
                  </button>
                  <button
                    onClick={() => window.close()}
                    style={{
                      fontSize: 13, fontWeight: 700, letterSpacing: 0.5,
                      padding: '8px 20px', borderRadius: 20, cursor: 'pointer',
                      background: 'rgba(100,116,139,0.15)', color: '#94a3b8',
                      border: '1px solid rgba(100,116,139,0.3)',
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    Close Tab
                  </button>
                </div>
                <div style={{
                  fontSize: 12, color: '#64748b', marginTop: 20,
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  Terminal content saved locally.
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 28, padding: '10px 28px',
        background: '#0d1117', borderTop: '1px solid rgba(255,255,255,0.08)',
        fontSize: 13, color: '#64748b', letterSpacing: 0.8, flexShrink: 0,
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: statusCfg.color,
            boxShadow: statusCfg.shadow,
          }} />
          {connStatus}
        </span>
        <span>SESSION&nbsp;{sessionId}</span>
        <span>WORKSPACE&nbsp;{wsName.toUpperCase()}</span>
        <span style={{ marginLeft: 'auto' }}>{new Date().toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<TerminalPage />);
