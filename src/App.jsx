import { useState, useEffect, useRef } from "react";

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function lightenHex(hex, amount = 0.3) {
  let r = parseInt(hex.slice(1, 3), 16);
  let g = parseInt(hex.slice(3, 5), 16);
  let b = parseInt(hex.slice(5, 7), 16);
  r = Math.min(255, Math.round(r + (255 - r) * amount));
  g = Math.min(255, Math.round(g + (255 - g) * amount));
  b = Math.min(255, Math.round(b + (255 - b) * amount));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

const PRESET_THEMES = [
  { id: "ember", name: "Ember", accent: "#f97316", desc: "Warm orange" },
  { id: "ocean", name: "Ocean", accent: "#3b82f6", desc: "Cool blue" },
  { id: "forest", name: "Forest", accent: "#22c55e", desc: "Natural green" },
  { id: "violet", name: "Violet", accent: "#8b5cf6", desc: "Rich purple" },
  { id: "rose", name: "Rose", accent: "#f43f5e", desc: "Vibrant pink" },
  { id: "cyber", name: "Cyber", accent: "#06b6d4", desc: "Neon cyan" },
  { id: "gold", name: "Gold", accent: "#eab308", desc: "Classic gold" },
  { id: "arctic", name: "Arctic", accent: "#94a3b8", desc: "Minimal grey" },
];

const DEFAULT_THEME = { id: "ember", accent: "#f97316" };

function getThemeColors(theme) {
  const accent = theme?.accent || "#f97316";
  return {
    accent,
    accentLight: lightenHex(accent, 0.3),
    glow03: hexToRgba(accent, 0.3),
    glow025: hexToRgba(accent, 0.25),
    glow02: hexToRgba(accent, 0.2),
    glow015: hexToRgba(accent, 0.15),
    glow006: hexToRgba(accent, 0.06),
    glow04: hexToRgba(accent, 0.4),
    glow06: hexToRgba(accent, 0.6),
  };
}

const AGENT_ARGS = {
  claude: [
    { id: "bypass-permissions", label: "--dangerously-skip-permissions", desc: "Bypass dangerous permission prompts" },
    { id: "chrome-ext", label: "--chrome", desc: "Enable Chrome extension support" },
    { id: "no-auto-approve", label: "--no-auto-approve", desc: "Disable auto-approval of actions" },
    { id: "verbose", label: "--verbose", desc: "Enable verbose logging output" },
    { id: "output-format-json", label: "--output-format json", desc: "Output responses as JSON" },
    { id: "max-turns", label: "--max-turns 10", desc: "Limit conversation turns to 10" },
  ],
  codex: [
    { id: "full-auto", label: "--full-auto", desc: "Run in fully autonomous mode" },
    { id: "no-confirm", label: "--no-confirm", desc: "Skip confirmation prompts" },
    { id: "sandbox", label: "--sandbox", desc: "Run in sandboxed environment" },
    { id: "model-gpt4", label: "--model gpt-4o", desc: "Use GPT-4o model" },
    { id: "quiet", label: "--quiet", desc: "Suppress non-essential output" },
    { id: "exec-policy", label: "--approval-policy auto-edit", desc: "Auto-approve file edits" },
  ],
  ralph: [],
  bash: [],
};

const STATUS_COLORS = {
  running: { dot: "#22c55e", glow: "rgba(34,197,94,0.4)", label: "RUNNING" },
  idle: { dot: "#f59e0b", glow: "rgba(245,158,11,0.4)", label: "IDLE" },
  stopped: { dot: "#6b7280", glow: "rgba(107,114,128,0.3)", label: "STOPPED" },
  error: { dot: "#ef4444", glow: "rgba(239,68,68,0.4)", label: "ERROR" },
};

const AGENT_META = {
  claude: { color: "#f97316", glow: "rgba(249,115,22,0.2)", icon: "\u25C6", brand: "Claude Code" },
  codex: { color: "#8b5cf6", glow: "rgba(139,92,246,0.2)", icon: "\u2B21", brand: "OpenAI Codex" },
  ralph: { color: "#06b6d4", glow: "rgba(6,182,212,0.2)", icon: "\u21BB", brand: "Ralph Loop" },
  bash: { color: "#22c55e", glow: "rgba(34,197,94,0.2)", icon: "\u276F", brand: "Shell" },
};

function generateId() {
  return Math.random().toString(36).slice(2, 9).toUpperCase();
}

function getRelativeTime(date) {
  const diff = Date.now() - date;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

function getCommonParent(paths) {
  if (paths.length === 0) return "";
  if (paths.length === 1) return paths[0];
  const parts = paths.map(p => p.split("/"));
  const common = [];
  for (let i = 0; i < parts[0].length; i++) {
    const segment = parts[0][i];
    if (parts.every(p => p[i] === segment)) {
      common.push(segment);
    } else break;
  }
  return common.join("/") || "/";
}

async function openTerminalTab(ws, onWorktreeCreated) {
  const services = ws.services || [];
  const primary = services[0] || { id: "default", name: ws.name, agent: ws.agent || "claude", args: ws.args || [] };
  const allPaths = services.map(s => s.path).filter(Boolean);
  let cwd = allPaths.length > 1 ? getCommonParent(allPaths) : (allPaths[0] || ws.path || "");

  // If isolated, create worktree and use its path
  if (ws.isolated && cwd && !ws.worktreePath) {
    try {
      const res = await fetch(`${API_BASE}/api/worktree/create`, {
        method: "POST",
        headers: authHeaders({}),
        body: JSON.stringify({ repoPath: cwd, workspaceId: ws.id, branchName: ws.name }),
      });
      const data = await res.json();
      if (data.success) {
        cwd = data.worktreePath;
        if (onWorktreeCreated) onWorktreeCreated(data.worktreePath, data.branchName);
      } else {
        alert(`Failed to create worktree: ${data.error}`);
        return;
      }
    } catch (err) {
      alert(`Failed to create worktree: ${err.message}`);
      return;
    }
  } else if (ws.worktreePath) {
    cwd = ws.worktreePath;
  }

  const args = (primary.args || []).join(",");
  const sessionId = ws.id;
  let url = `/terminal.html?agent=${primary.agent}&args=${encodeURIComponent(args)}&name=${encodeURIComponent(ws.name)}&id=${sessionId}&cwd=${encodeURIComponent(cwd)}`;
  if (primary.agent === "ralph") {
    url += `&loopCount=${primary.loopCount || 20}&donePrompt=${encodeURIComponent(primary.donePrompt || "")}`;
  }
  if (primary.agent === "bash" && primary.command) {
    url += `&command=${encodeURIComponent(primary.command)}`;
  }
  const token = getAuthToken();
  if (token) url += `&token=${encodeURIComponent(token)}`;
  window.open(url, "_blank");
}

function StatusBadge({ status }) {
  const s = STATUS_COLORS[status];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, fontFamily: "monospace", color: s.dot, letterSpacing: 1, fontWeight: 700 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.dot, boxShadow: `0 0 8px ${s.glow}`, display: "inline-block", animation: status === "running" ? "pulse 2s infinite" : "none" }} />
      {s.label}
    </span>
  );
}

function WorkspaceCard({ ws, onTerminate, onResume, onDelete, onManageSessions, onAddService, onOpen, tc }) {
  const [hovered, setHovered] = useState(false);
  const services = ws.services || [];
  const primaryMeta = AGENT_META[services[0]?.agent] || AGENT_META.claude;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.025)",
        border: `1px solid ${hovered ? hexToRgba(tc.accent, 0.33) : "rgba(255,255,255,0.08)"}`,
        borderRadius: 10,
        padding: "16px 18px",
        transition: "all 0.2s ease",
        cursor: "default",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Ambient glow top-right */}
      <div style={{ position: "absolute", top: -30, right: -30, width: 90, height: 90, background: tc.glow02, borderRadius: "50%", filter: "blur(25px)", pointerEvents: "none" }} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <span style={{ fontSize: 16, color: tc.accent, flexShrink: 0 }}>{primaryMeta.icon}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 14, color: "#f1f5f9", letterSpacing: 0.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ws.name}</div>
            <div style={{ fontSize: 10, color: "#64748b", fontFamily: "monospace", marginTop: 1 }}>
              {ws.id} {"\u00B7"} {getRelativeTime(ws.createdAt)}
              {services.length > 1 && <> {"\u00B7"} {services.length} projects</>}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {ws.isolated && (
            <span style={{
              fontSize: 9, fontFamily: "monospace", fontWeight: 700, letterSpacing: 0.5,
              color: tc.accent, background: hexToRgba(tc.accent, 0.1),
              border: `1px solid ${hexToRgba(tc.accent, 0.2)}`,
              padding: "2px 6px", borderRadius: 4,
            }}>ISOLATED</span>
          )}
          <StatusBadge status={ws.status} />
        </div>
      </div>

      {/* Project paths */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12 }}>
        {services.map(svc => (
          <span key={svc.id} style={{
            fontSize: 9, fontFamily: "monospace", color: "#64748b",
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
            padding: "3px 8px", borderRadius: 4, maxWidth: "100%",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {svc.path ? svc.path.split("/").pop() : svc.name}
          </span>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          onClick={() => onOpen(ws)}
          disabled={ws.status === "stopped"}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            background: ws.status === "stopped" ? "rgba(255,255,255,0.03)" : hexToRgba(tc.accent, 0.09),
            border: `1px solid ${ws.status === "stopped" ? "rgba(255,255,255,0.07)" : hexToRgba(tc.accent, 0.27)}`,
            color: ws.status === "stopped" ? "#334155" : tc.accent,
            padding: "7px 14px", borderRadius: 6,
            fontFamily: "monospace", fontWeight: 700, fontSize: 11,
            cursor: ws.status === "stopped" ? "not-allowed" : "pointer",
            letterSpacing: 0.3, transition: "all 0.15s", flex: 1,
          }}
        >
          {ws.status === "stopped" ? "Stopped" : <>Connect {"\u2197"}</>}
        </button>
        {ws.status !== "stopped" && (
          <button
            onClick={() => onAddService(ws.id)}
            style={{ ...btnStyle, background: "rgba(255,255,255,0.04)", color: "#64748b", border: "1px dashed rgba(255,255,255,0.12)" }}
            title="Add project"
          >
            +
          </button>
        )}
        {ws.services?.some(s => s.agent === "claude") && services[0]?.path && (
          <button onClick={() => onManageSessions(ws)} style={{ ...btnStyle, background: hexToRgba(tc.accent, 0.08), color: tc.accent, border: `1px solid ${hexToRgba(tc.accent, 0.2)}` }} title="Manage sessions">
            {"\u21CB"}
          </button>
        )}
        {ws.status === "running" && (
          <button onClick={() => onTerminate(ws.id)} style={{ ...btnStyle, background: "rgba(239,68,68,0.1)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.2)" }}>
            {"\u25AA"}
          </button>
        )}
        {ws.status === "stopped" && (
          <button onClick={() => onResume(ws.id)} style={{ ...btnStyle, background: "rgba(34,197,94,0.08)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.2)" }}>
            {"\u25B6"}
          </button>
        )}
        <button onClick={() => onDelete(ws.id)} style={{ ...btnStyle, background: "rgba(255,255,255,0.04)", color: "#475569", border: "1px solid rgba(255,255,255,0.07)" }}>
          {"\u2715"}
        </button>
      </div>
    </div>
  );
}

const btnStyle = {
  padding: "5px 10px",
  borderRadius: 5,
  fontSize: 11,
  fontFamily: "monospace",
  fontWeight: 600,
  cursor: "pointer",
  transition: "all 0.15s",
  letterSpacing: 0.3,
};

const API_BASE = window.__VELA_API_BASE__ || (window.location.port === "6001" ? "http://localhost:6100" : "");

const svcLabelStyle = { display: "block", fontSize: 10, fontFamily: "monospace", letterSpacing: 1.5, color: "#475569", fontWeight: 700, marginBottom: 6 };
const svcInputStyle = {
  width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 6, padding: "8px 12px", color: "#f1f5f9", fontFamily: "monospace",
  fontSize: 12, outline: "none", boxSizing: "border-box",
};

function ServiceEditor({ svc, onChange, onRemove, canRemove, defaultDir }) {
  const meta = AGENT_META[svc.agent] || AGENT_META.claude;
  const args = AGENT_ARGS[svc.agent] || [];
  const [expanded, setExpanded] = useState(svc._expanded !== false);
  const [projectQuery, setProjectQuery] = useState(svc._projectQuery || "");
  const [resolveStatus, setResolveStatus] = useState(svc.path ? "resolved" : null);
  // null | 'checking' | 'found' | 'searching-github' | 'github-found' | 'not-found' | 'forking' | 'cloned' | 'resolved'
  const [localMatches, setLocalMatches] = useState([]);
  const [githubResults, setGithubResults] = useState([]);

  useEffect(() => {
    if (!projectQuery.trim()) {
      setResolveStatus(null);
      setLocalMatches([]);
      setGithubResults([]);
      return;
    }
    setResolveStatus("checking");
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/resolve-project?name=${encodeURIComponent(projectQuery.trim())}`, { headers: authHeaders({}) });
        const data = await res.json();
        if (data.found) {
          setResolveStatus("found");
          setLocalMatches(data.allMatches || [data.path]);
          setGithubResults([]);
          onChange({ ...svc, path: data.path, _projectQuery: projectQuery });
        } else {
          // Not found locally — search GitHub
          setResolveStatus("searching-github");
          setLocalMatches([]);
          try {
            const ghRes = await fetch(`${API_BASE}/api/github-search?name=${encodeURIComponent(projectQuery.trim())}`, { headers: authHeaders({}) });
            const ghData = await ghRes.json();
            if (ghData.results?.length > 0) {
              setResolveStatus("github-found");
              setGithubResults(ghData.results);
            } else {
              setResolveStatus("not-found");
              setGithubResults([]);
            }
          } catch {
            setResolveStatus("not-found");
            setGithubResults([]);
          }
        }
      } catch {
        setResolveStatus(null);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [projectQuery]);

  async function handleForkClone(repoFullName) {
    setResolveStatus("forking");
    try {
      const res = await fetch(`${API_BASE}/api/fork-clone`, {
        method: "POST",
        headers: authHeaders({}),
        body: JSON.stringify({ repoFullName }),
      });
      const data = await res.json();
      if (data.success) {
        setResolveStatus("cloned");
        setGithubResults([]);
        onChange({ ...svc, path: data.path, _projectQuery: projectQuery });
      } else {
        setResolveStatus("not-found");
      }
    } catch {
      setResolveStatus("not-found");
    }
  }

  function toggleArg(id) {
    const next = svc.selectedArgs.includes(id) ? svc.selectedArgs.filter(a => a !== id) : [...svc.selectedArgs, id];
    onChange({ ...svc, selectedArgs: next });
  }

  return (
    <div style={{
      background: "rgba(255,255,255,0.02)",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 10, padding: "14px 16px", marginBottom: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: expanded ? 14 : 0 }}>
        <span style={{ fontSize: 14, color: meta.color }}>{meta.icon}</span>
        <input
          value={svc.name}
          onChange={e => onChange({ ...svc, name: e.target.value })}
          placeholder="Service name"
          style={{
            flex: 1, background: "transparent", border: "none",
            color: "#f1f5f9", fontFamily: "monospace", fontSize: 13, fontWeight: 600,
            outline: "none", padding: 0,
          }}
        />
        <button onClick={() => setExpanded(!expanded)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 12, fontFamily: "monospace" }}>
          {expanded ? "\u25B2" : "\u25BC"}
        </button>
        {canRemove && (
          <button onClick={onRemove} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 14, padding: "0 2px" }}>
            {"\u2715"}
          </button>
        )}
      </div>

      {expanded && (
        <>
          {/* Project */}
          <div style={{ marginBottom: 12 }}>
            <label style={svcLabelStyle}>PROJECT <span style={{ color: "#334155", fontWeight: 400 }}>(search or paste path)</span></label>
            <input
              value={projectQuery}
              onChange={e => setProjectQuery(e.target.value)}
              placeholder="e.g. my-app, /path/to/project"
              style={svcInputStyle}
            />
            {resolveStatus === "checking" && (
              <div style={{ fontSize: 10, color: "#60a5fa", fontFamily: "monospace", marginTop: 4 }}>
                <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>{"\u27F3"}</span> Searching...
              </div>
            )}
            {resolveStatus === "found" && localMatches.length <= 1 && (
              <div style={{ fontSize: 10, color: "#4ade80", fontFamily: "monospace", marginTop: 4 }}>
                {"\u2713"} {svc.path}
              </div>
            )}
            {resolveStatus === "found" && localMatches.length > 1 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 6, maxHeight: 100, overflowY: "auto" }}>
                {localMatches.map(p => (
                  <button
                    key={p}
                    onClick={() => { onChange({ ...svc, path: p }); setLocalMatches([p]); }}
                    style={{
                      background: p === svc.path ? "rgba(34,197,94,0.1)" : "rgba(255,255,255,0.025)",
                      border: `1px solid ${p === svc.path ? "rgba(34,197,94,0.3)" : "rgba(255,255,255,0.06)"}`,
                      borderRadius: 4, padding: "5px 10px", cursor: "pointer",
                      fontFamily: "monospace", fontSize: 10, color: p === svc.path ? "#4ade80" : "#94a3b8",
                      textAlign: "left",
                    }}
                  >
                    {p === svc.path && "\u2713 "}{p}
                  </button>
                ))}
              </div>
            )}
            {resolveStatus === "searching-github" && (
              <div style={{ fontSize: 10, color: "#60a5fa", fontFamily: "monospace", marginTop: 4 }}>
                <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>{"\u27F3"}</span> Not found locally. Searching GitHub...
              </div>
            )}
            {resolveStatus === "forking" && (
              <div style={{ fontSize: 10, color: "#fb923c", fontFamily: "monospace", marginTop: 4 }}>
                <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>{"\u27F3"}</span> Forking & cloning...
              </div>
            )}
            {resolveStatus === "cloned" && (
              <div style={{ fontSize: 10, color: "#4ade80", fontFamily: "monospace", marginTop: 4 }}>
                {"\u2713"} Cloned to {svc.path}
              </div>
            )}
            {resolveStatus === "github-found" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 6, maxHeight: 120, overflowY: "auto" }}>
                <div style={{ fontSize: 10, color: "#fbbf24", fontFamily: "monospace", marginBottom: 2 }}>Not found locally. Found on GitHub:</div>
                {githubResults.map(repo => {
                  const srcColor = repo.source === "personal" ? "#22c55e" : repo.source?.startsWith("org:") ? "#3b82f6" : "#64748b";
                  const srcLabel = repo.source === "personal" ? "you" : repo.source?.startsWith("org:") ? repo.source.slice(4) : "global";
                  return (
                    <div key={repo.fullName} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)",
                      borderRadius: 4, padding: "5px 10px",
                    }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontFamily: "monospace", fontSize: 10, color: "#94a3b8", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{repo.fullName}</span>
                          <span style={{ fontSize: 8, fontFamily: "monospace", color: srcColor, background: srcColor + "18", border: `1px solid ${srcColor}30`, padding: "0 4px", borderRadius: 8, flexShrink: 0 }}>{srcLabel}</span>
                        </div>
                        {repo.description && <div style={{ fontSize: 9, color: "#475569", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{repo.description}</div>}
                      </div>
                      <button
                        onClick={() => handleForkClone(repo.fullName)}
                        style={{
                          background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.25)",
                          color: "#4ade80", padding: "3px 8px", borderRadius: 4,
                          fontFamily: "monospace", fontSize: 9, fontWeight: 600,
                          cursor: "pointer", whiteSpace: "nowrap", marginLeft: 8,
                        }}
                      >
                        Fork & Clone
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {resolveStatus === "not-found" && (
              <div style={{ fontSize: 10, color: "#fbbf24", fontFamily: "monospace", marginTop: 4 }}>
                Not found locally or on GitHub.
                {defaultDir && (
                  <button
                    onClick={() => { onChange({ ...svc, path: defaultDir }); setResolveStatus("resolved"); }}
                    style={{ background: "none", border: "none", color: "#60a5fa", cursor: "pointer", fontFamily: "monospace", fontSize: 10, marginLeft: 6 }}
                  >
                    Use default: {defaultDir}
                  </button>
                )}
              </div>
            )}
            {!projectQuery.trim() && !svc.path && defaultDir && (
              <div style={{ fontSize: 10, color: "#60a5fa", fontFamily: "monospace", marginTop: 4 }}>
                {"\u2139"} Will use default: {defaultDir}
              </div>
            )}
          </div>

          {/* Agent type */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 12 }}>
            {["claude", "codex", "ralph", "bash"].map(a => {
              const m = AGENT_META[a];
              const active = svc.agent === a;
              return (
                <button
                  key={a}
                  onClick={() => onChange({ ...svc, agent: a, selectedArgs: [], command: a === "bash" ? (svc.command || "") : undefined })}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    background: active ? m.color + "18" : "rgba(255,255,255,0.03)",
                    border: `1px solid ${active ? m.color + "55" : "rgba(255,255,255,0.08)"}`,
                    borderRadius: 6, padding: "8px 10px", cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >
                  <span style={{ fontSize: 13, color: m.color }}>{m.icon}</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 600, color: active ? m.color : "#94a3b8", fontSize: 11 }}>{m.brand}</span>
                </button>
              );
            })}
          </div>

          {/* Shell command input */}
          {svc.agent === "bash" && (
            <div style={{ marginBottom: 12 }}>
              <label style={svcLabelStyle}>COMMAND</label>
              <input
                value={svc.command || ""}
                onChange={e => onChange({ ...svc, command: e.target.value })}
                placeholder="e.g. npm run dev, python server.py"
                style={svcInputStyle}
              />
            </div>
          )}

          {/* Ralph config */}
          {svc.agent === "ralph" && (
            <div style={{ marginBottom: 12 }}>
              <label style={svcLabelStyle}>LOOP COUNT</label>
              <input
                type="number" min="1" max="200"
                value={svc.loopCount || 20}
                onChange={e => onChange({ ...svc, loopCount: Math.max(1, parseInt(e.target.value) || 1) })}
                style={svcInputStyle}
              />
            </div>
          )}

          {/* Agent args */}
          {args.length > 0 && (
            <div>
              <label style={svcLabelStyle}>ARGUMENTS</label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                {args.map(arg => {
                  const active = svc.selectedArgs.includes(arg.id);
                  return (
                    <button
                      key={arg.id}
                      onClick={() => toggleArg(arg.id)}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        background: active ? meta.color + "10" : "rgba(255,255,255,0.02)",
                        border: `1px solid ${active ? meta.color + "40" : "rgba(255,255,255,0.06)"}`,
                        borderRadius: 5, padding: "6px 10px", cursor: "pointer",
                        transition: "all 0.15s", textAlign: "left",
                      }}
                    >
                      <span style={{
                        width: 14, height: 14, borderRadius: 3, border: `1.5px solid ${active ? meta.color : "#334155"}`,
                        background: active ? meta.color : "transparent", display: "flex", alignItems: "center", justifyContent: "center",
                        flexShrink: 0, fontSize: 9, color: "#fff",
                      }}>
                        {active ? "\u2713" : ""}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontFamily: "monospace", fontSize: 11, color: active ? meta.color : "#94a3b8", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{arg.label}</div>
                        <div style={{ fontSize: 9, color: "#475569", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{arg.desc}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CreateModal({ onClose, onCreate, settings }) {
  const [name, setName] = useState("");
  const [services, setServices] = useState([
    { id: generateId(), name: "Claude Code", agent: "claude", selectedArgs: [], _expanded: true },
  ]);
  const [step, setStep] = useState(1); // 1 = form, 2 = launching
  const [isolated, setIsolated] = useState(false);
  const tc = getThemeColors(settings?.theme);

  function updateService(id, updated) {
    setServices(prev => prev.map(s => s.id === id ? updated : s));
  }

  function removeService(id) {
    setServices(prev => prev.filter(s => s.id !== id));
  }

  function addService() {
    setServices(prev => [...prev, {
      id: generateId(), name: `Service ${prev.length + 1}`, agent: "bash", selectedArgs: [], command: "", _expanded: true,
    }]);
  }

  function handleCreate() {
    if (!name.trim()) return;
    if (services.length === 0) return;
    setStep(2);
    setTimeout(() => {
      const defaultPath = settings?.defaultCodebaseDir || "";
      const builtServices = services.map(svc => {
        const agentArgs = AGENT_ARGS[svc.agent] || [];
        const built = {
          id: svc.id,
          name: svc.name || AGENT_META[svc.agent]?.brand || svc.agent,
          agent: svc.agent,
          args: svc.selectedArgs.map(id => agentArgs.find(a => a.id === id)?.label).filter(Boolean),
          path: svc.path || defaultPath,
        };
        if (svc.agent === "ralph") {
          built.loopCount = svc.loopCount || 20;
          built.donePrompt = (svc.donePrompt || "").trim();
        }
        if (svc.agent === "bash" && svc.command) {
          built.command = svc.command;
          built.args = ["-c", svc.command];
        }
        return built;
      });
      onCreate({
        name: name.trim(),
        services: builtServices,
        isolated,
      });
      onClose();
    }, 1800);
  }

  const primaryAgent = services[0]?.agent || "claude";
  const meta = AGENT_META[primaryAgent];



  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
      animation: "fadeIn 0.2s ease",
    }}>
      <div style={{
        background: "#0f1117",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 16,
        width: "min(720px, 92vw)",
        maxHeight: "90vh",
        overflow: "auto",
        boxShadow: "0 40px 80px rgba(0,0,0,0.8)",
        animation: "slideUp 0.25s ease",
      }}>
        {step === 2 ? (
          <div style={{ padding: "60px 40px", textAlign: "center" }}>
            <div style={{ fontSize: 40, marginBottom: 16, animation: "spin 1s linear infinite", display: "inline-block" }}>{"\u27F3"}</div>
            <div style={{ fontFamily: "monospace", color: "#4ade80", fontSize: 14, letterSpacing: 1 }}>INITIALIZING SESSION</div>
            <div style={{ color: "#475569", fontSize: 12, marginTop: 8, fontFamily: "monospace" }}>
              Spawning {services.length} service{services.length > 1 ? "s" : ""} for <span style={{ color: meta.color }}>{name}</span>...
            </div>
          </div>
        ) : (
          <>
            <div style={{ padding: "22px 28px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 20, color: "#f1f5f9", letterSpacing: 0.5 }}>New Workspace</div>
                <div style={{ color: "#475569", fontSize: 13, fontFamily: "monospace", marginTop: 3 }}>Configure your agent session</div>
              </div>
              <button onClick={onClose} style={{ background: "none", border: "none", color: "#475569", fontSize: 22, cursor: "pointer", padding: 4 }}>{"\u2715"}</button>
            </div>

            <div style={{ padding: "20px 28px 24px" }}>
              {/* Workspace Name */}
              <div style={{ marginBottom: 18 }}>
                <label style={labelStyle}>WORKSPACE NAME</label>
                <input
                  autoFocus
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. bug-fix-auth, feature-api-v2"
                  onKeyDown={e => e.key === "Enter" && handleCreate()}
                  style={{
                    width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 8, padding: "10px 14px", color: "#f1f5f9", fontFamily: "monospace",
                    fontSize: 14, outline: "none", boxSizing: "border-box",
                    transition: "border-color 0.15s",
                  }}
                />
              </div>

              {/* Isolation Toggle */}
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "10px 14px", borderRadius: 8, marginBottom: 18,
                background: isolated ? hexToRgba(tc.accent, 0.06) : "rgba(255,255,255,0.02)",
                border: `1px solid ${isolated ? hexToRgba(tc.accent, 0.2) : "rgba(255,255,255,0.06)"}`,
                cursor: "pointer", transition: "all 0.2s",
              }} onClick={() => setIsolated(!isolated)}>
                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 12, color: "#e2e8f0" }}>
                    {"\u2387"} Isolated Mode
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 10, color: "#64748b", marginTop: 2 }}>
                    {isolated ? "Creates a git worktree \u2014 run multiple agents on the same repo" : "Run in the original project directory"}
                  </div>
                </div>
                <div style={{
                  width: 40, height: 22, borderRadius: 11, padding: 2,
                  background: isolated ? tc.accent : "rgba(255,255,255,0.1)",
                  transition: "background 0.2s", flexShrink: 0,
                }}>
                  <div style={{
                    width: 18, height: 18, borderRadius: 9, background: "#fff",
                    transform: isolated ? "translateX(18px)" : "translateX(0)",
                    transition: "transform 0.2s",
                  }} />
                </div>
              </div>

              {/* Services */}
              <div style={{ marginBottom: 18 }}>
                <label style={labelStyle}>SERVICES</label>
                {services.map(svc => (
                  <ServiceEditor
                    key={svc.id}
                    svc={svc}
                    onChange={updated => updateService(svc.id, updated)}
                    onRemove={() => removeService(svc.id)}
                    canRemove={services.length > 1}
                    defaultDir={settings?.defaultCodebaseDir || ""}
                  />
                ))}
                <button
                  onClick={addService}
                  style={{
                    width: "100%", padding: "10px", borderRadius: 8,
                    background: "rgba(255,255,255,0.02)",
                    border: "1px dashed rgba(255,255,255,0.12)",
                    color: "#64748b", fontFamily: "monospace", fontWeight: 600,
                    fontSize: 12, cursor: "pointer", transition: "all 0.15s",
                  }}
                >
                  + Add Another Service
                </button>
              </div>

              <button
                onClick={handleCreate}
                disabled={!name.trim()}
                style={{
                  width: "100%", padding: "14px", borderRadius: 10,
                  background: name.trim() ? meta.color : "rgba(255,255,255,0.05)",
                  border: "none", color: name.trim() ? "#fff" : "#334155",
                  fontFamily: "monospace", fontWeight: 700, fontSize: 15,
                  cursor: name.trim() ? "pointer" : "not-allowed",
                  letterSpacing: 1, transition: "all 0.2s",
                  boxShadow: name.trim() ? `0 0 20px ${meta.glow}` : "none",
                }}
              >
                {"\u25B6"} LAUNCH WORKSPACE
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const labelStyle = {
  display: "block", fontSize: 12, fontFamily: "monospace", letterSpacing: 1.5,
  color: "#475569", fontWeight: 700, marginBottom: 8,
};

function AddServiceModal({ onClose, onAdd, defaultDir }) {
  const [svc, setSvc] = useState({
    id: generateId(), name: "", agent: "bash", selectedArgs: [], command: "", _expanded: true,
  });

  function handleAdd() {
    const agentArgs = AGENT_ARGS[svc.agent] || [];
    const built = {
      id: svc.id,
      name: svc.name || AGENT_META[svc.agent]?.brand || svc.agent,
      agent: svc.agent,
      args: svc.selectedArgs.map(id => agentArgs.find(a => a.id === id)?.label).filter(Boolean),
      path: svc.path || defaultDir || "",
    };
    if (svc.agent === "bash" && svc.command) {
      built.command = svc.command;
      built.args = ["-c", svc.command];
    }
    if (svc.agent === "ralph") {
      built.loopCount = svc.loopCount || 20;
    }
    onAdd(built);
  }

  const meta = AGENT_META[svc.agent];

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
      animation: "fadeIn 0.2s ease",
    }}>
      <div style={{
        background: "#0f1117", border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 16, width: "min(520px, 90vw)", maxHeight: "80vh", overflow: "auto",
        boxShadow: "0 40px 80px rgba(0,0,0,0.8)", animation: "slideUp 0.25s ease",
      }}>
        <div style={{ padding: "22px 24px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 18, color: "#f1f5f9" }}>Add Service</div>
            <div style={{ color: "#475569", fontSize: 12, fontFamily: "monospace", marginTop: 2 }}>Add a new service to this workspace</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#475569", fontSize: 20, cursor: "pointer" }}>{"\u2715"}</button>
        </div>
        <div style={{ padding: "18px 24px 24px" }}>
          <ServiceEditor svc={svc} onChange={setSvc} onRemove={() => {}} canRemove={false} defaultDir={defaultDir} />
          <button
            onClick={handleAdd}
            style={{
              width: "100%", padding: "12px", borderRadius: 8, marginTop: 8,
              background: meta.color, border: "none", color: "#fff",
              fontFamily: "monospace", fontWeight: 700, fontSize: 14,
              cursor: "pointer", letterSpacing: 0.5, transition: "all 0.2s",
              boxShadow: `0 0 16px ${meta.glow}`,
            }}
          >
            Add Service
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({ settings, onClose, onSave }) {
  const [defaultDir, setDefaultDir] = useState(settings?.defaultCodebaseDir || "");
  const [roots, setRoots] = useState(settings?.searchRoots || []);
  const [cloneDir, setCloneDir] = useState(settings?.cloneDir || "");
  const [newRoot, setNewRoot] = useState("");
  const [saving, setSaving] = useState(false);
  const [themeId, setThemeId] = useState(settings?.theme?.id || "ember");
  const [customColor, setCustomColor] = useState(settings?.theme?.accent || "#f97316");

  // Auth settings state
  const [authEnabled, setAuthEnabled] = useState(false);
  const [hasPIN, setHasPIN] = useState(false);
  const [hasFingerprint, setHasFingerprint] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [showChangePin, setShowChangePin] = useState(false);
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pinStep, setPinStep] = useState("enter"); // "enter" | "confirm"
  const [authMsg, setAuthMsg] = useState("");
  const [authMsgType, setAuthMsgType] = useState(""); // "success" | "error"
  const [fpLoading, setFpLoading] = useState(false);
  const webauthnAvailable = typeof window !== "undefined" && !!window.PublicKeyCredential;

  // Load auth status
  useEffect(() => {
    fetch(`${API_BASE}/api/auth/status`, { headers: authHeaders({}) })
      .then(r => r.json())
      .then(data => {
        setAuthEnabled(data.enabled);
        setHasPIN(data.hasPIN);
        setHasFingerprint(data.hasFingerprint);
        setAuthLoading(false);
      })
      .catch(() => setAuthLoading(false));
  }, []);

  async function handleToggleAuth(enable) {
    setAuthMsg("");
    if (!enable) {
      // Disable auth
      try {
        const res = await fetch(`${API_BASE}/api/auth/update`, {
          method: "POST", headers: authHeaders({}),
          body: JSON.stringify({ enabled: false }),
        });
        if ((await res.json()).success) {
          setAuthEnabled(false); setHasPIN(false); setHasFingerprint(false);
          setShowChangePin(false);
          setAuthMsg("Authentication disabled"); setAuthMsgType("success");
        }
      } catch {
        setAuthMsg("Could not connect to server"); setAuthMsgType("error");
      }
    } else {
      // Enable — need a PIN first
      setAuthEnabled(true);
      setShowChangePin(true);
      setPinStep("enter");
      setNewPin("");
      setConfirmPin("");
    }
  }

  async function handleSavePin(pinToSave, confirmToSave) {
    const pin = pinToSave || newPin;
    const confirm = confirmToSave || confirmPin;
    if (pin.length < 4) { setAuthMsg("PIN must be at least 4 digits"); setAuthMsgType("error"); return; }
    if (pin !== confirm) { setAuthMsg("PINs do not match"); setAuthMsgType("error"); setPinStep("enter"); setNewPin(""); setConfirmPin(""); return; }
    setAuthMsg("");
    const body = { newPin: pin, enabled: true };
    try {
      const res = await fetch(`${API_BASE}/api/auth/update`, {
        method: "POST", headers: authHeaders({}),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setHasPIN(true); setShowChangePin(false); setAuthEnabled(true);
        setAuthMsg("PIN saved successfully"); setAuthMsgType("success");
        setNewPin(""); setConfirmPin("");
      } else {
        setAuthMsg(data.error || "Failed to save PIN"); setAuthMsgType("error");
      }
    } catch {
      setAuthMsg("Could not connect to server"); setAuthMsgType("error");
    }
  }

  async function handleSetupFingerprint() {
    setFpLoading(true); setAuthMsg("");
    try {
      const optRes = await fetch(`${API_BASE}/api/auth/webauthn/register-options`, { headers: authHeaders({}) });
      const options = await optRes.json();
      if (options.error) { setAuthMsg(options.error); setAuthMsgType("error"); setFpLoading(false); return; }

      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: base64urlToBuffer(options.challenge),
          rp: options.rp,
          user: { ...options.user, id: base64urlToBuffer(options.user.id) },
          pubKeyCredParams: options.pubKeyCredParams,
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            residentKey: "preferred",
            userVerification: "required",
          },
          attestation: "none",
          timeout: options.timeout,
        },
      });

      // getPublicKey() returns SPKI DER — available on AuthenticatorAttestationResponse
      const attResponse = credential.response;
      let pubKeyB64 = "";
      if (attResponse.getPublicKey) {
        pubKeyB64 = bufferToBase64(attResponse.getPublicKey());
      } else {
        setAuthMsg("Browser does not support getPublicKey()"); setAuthMsgType("error"); setFpLoading(false); return;
      }

      const res = await fetch(`${API_BASE}/api/auth/webauthn/register`, {
        method: "POST", headers: authHeaders({}),
        body: JSON.stringify({
          credentialId: bufferToBase64url(credential.rawId),
          publicKey: pubKeyB64,
          clientDataJSON: bufferToBase64(attResponse.clientDataJSON),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setHasFingerprint(true);
        setAuthMsg("Passkey registered successfully"); setAuthMsgType("success");
      } else {
        setAuthMsg(data.error || "Registration failed"); setAuthMsgType("error");
      }
    } catch (e) {
      if (e.name === "NotAllowedError") {
        setAuthMsg("Passkey setup was cancelled"); setAuthMsgType("error");
      } else {
        console.error("[Vela] Passkey setup error:", e);
        setAuthMsg(e.message || "Passkey setup failed"); setAuthMsgType("error");
      }
    }
    setFpLoading(false);
  }

  async function handleRemoveFingerprint() {
    const res = await fetch(`${API_BASE}/api/auth/update`, {
      method: "POST", headers: authHeaders({}),
      body: JSON.stringify({ disableFingerprint: true }),
    });
    if ((await res.json()).success) {
      setHasFingerprint(false);
      setAuthMsg("Fingerprint removed"); setAuthMsgType("success");
    }
  }
  const activeAccent = themeId === "custom" ? customColor : (PRESET_THEMES.find(t => t.id === themeId)?.accent || "#f97316");

  function addRoot() {
    const v = newRoot.trim();
    if (v && !roots.includes(v)) {
      setRoots(prev => [...prev, v]);
      setNewRoot("");
    }
  }

  function removeRoot(r) {
    setRoots(prev => prev.filter(x => x !== r));
  }

  async function handleSave() {
    setSaving(true);
    const updated = { defaultCodebaseDir: defaultDir.trim(), searchRoots: roots, cloneDir: cloneDir.trim(), theme: { id: themeId, accent: activeAccent } };
    try {
      await fetch(`${API_BASE}/api/config`, {
        method: "POST",
        headers: authHeaders({}),
        body: JSON.stringify({ searchRoots: updated.searchRoots, cloneDir: updated.cloneDir }),
      });
    } catch {}
    onSave(updated);
    setSaving(false);
    onClose();
  }

  async function handleReset() {
    try {
      const res = await fetch(`${API_BASE}/api/config`, { headers: authHeaders({}) });
      const data = await res.json();
      setDefaultDir(data.searchRoots?.[0] || "");
      setRoots(data.searchRoots || []);
      setCloneDir(data.cloneDir || "");
    } catch {}
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
      animation: "fadeIn 0.2s ease",
    }}>
      <div style={{
        background: "#0f1117",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 16,
        width: "min(620px, 92vw)",
        maxHeight: "85vh",
        overflow: "auto",
        boxShadow: "0 40px 80px rgba(0,0,0,0.8)",
        animation: "slideUp 0.25s ease",
      }}>
        <div style={{ padding: "22px 28px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 20, color: "#f1f5f9", letterSpacing: 0.5 }}>
              {"\u2699"} Settings
            </div>
            <div style={{ color: "#475569", fontSize: 13, fontFamily: "monospace", marginTop: 3 }}>Configure directories and defaults</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#475569", fontSize: 22, cursor: "pointer", padding: 4 }}>{"\u2715"}</button>
        </div>

        <div style={{ padding: "20px 28px 24px" }}>
          {/* Authentication */}
          <div style={{ marginBottom: 22 }}>
            <label style={labelStyle}>AUTHENTICATION</label>

            {authLoading ? (
              <div style={{ color: "#475569", fontSize: 12, fontFamily: "monospace", padding: "12px 0" }}>Loading...</div>
            ) : (
              <>
                {/* Enable/Disable toggle */}
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "12px 14px", borderRadius: 10,
                  background: authEnabled ? hexToRgba(activeAccent, 0.06) : "rgba(255,255,255,0.02)",
                  border: `1px solid ${authEnabled ? hexToRgba(activeAccent, 0.2) : "rgba(255,255,255,0.06)"}`,
                  cursor: "pointer", transition: "all 0.2s", marginBottom: 10,
                }} onClick={() => handleToggleAuth(!authEnabled)}>
                  <div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 12, color: "#e2e8f0" }}>
                      PIN Authentication
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 10, color: "#64748b", marginTop: 2 }}>
                      {authEnabled ? (hasPIN ? "Enabled \u2014 PIN required on launch" : "Set a PIN to activate") : "Disabled \u2014 dashboard is open to anyone"}
                    </div>
                  </div>
                  <div style={{
                    width: 40, height: 22, borderRadius: 11, padding: 2,
                    background: authEnabled ? activeAccent : "rgba(255,255,255,0.1)",
                    transition: "background 0.2s", flexShrink: 0,
                  }}>
                    <div style={{
                      width: 18, height: 18, borderRadius: 9, background: "#fff",
                      transform: authEnabled ? "translateX(18px)" : "translateX(0)",
                      transition: "transform 0.2s",
                    }} />
                  </div>
                </div>

                {/* Change PIN */}
                {authEnabled && (
                  <>
                    {!showChangePin ? (
                      <button
                        onClick={() => { setShowChangePin(true); setPinStep("enter"); setNewPin(""); setConfirmPin(""); setAuthMsg(""); }}
                        style={{
                          display: "block", width: "100%", padding: "10px 14px", borderRadius: 8,
                          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
                          color: "#94a3b8", fontFamily: "monospace", fontSize: 12, fontWeight: 600,
                          cursor: "pointer", textAlign: "left", marginBottom: 10,
                        }}
                      >
                        {hasPIN ? "\uD83D\uDD11 Change PIN" : "\uD83D\uDD11 Set PIN"}
                      </button>
                    ) : (
                      <div style={{
                        padding: "16px", borderRadius: 10,
                        background: "rgba(255,255,255,0.02)", border: `1px solid ${hexToRgba(activeAccent, 0.15)}`,
                        marginBottom: 10,
                      }}>
                        <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 12, fontFamily: "'JetBrains Mono', monospace", marginBottom: 14 }}>
                          {pinStep === "enter" ? "Enter new PIN (4+ digits)" : "Confirm new PIN"}
                        </div>
                        <PinInput
                          length={6}
                          error={authMsgType === "error"}
                          onComplete={(p) => {
                            if (pinStep === "enter") {
                              setNewPin(p);
                              setPinStep("confirm");
                              setAuthMsg("");
                            } else {
                              setConfirmPin(p);
                              // Auto-save when confirm PIN is entered
                              handleSavePin(newPin, p);
                            }
                          }}
                        />
                        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14 }}>
                          <button onClick={() => { setShowChangePin(false); setAuthMsg(""); setPinStep("enter"); setNewPin(""); setConfirmPin(""); }} style={{
                            padding: "6px 16px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.08)",
                            background: "transparent", color: "#64748b", cursor: "pointer",
                            fontFamily: "monospace", fontSize: 11, fontWeight: 600,
                          }}>Cancel</button>
                        </div>
                      </div>
                    )}

                    {/* Fingerprint */}
                    {webauthnAvailable && (
                      <div style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        padding: "10px 14px", borderRadius: 8,
                        background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
                        marginBottom: 10,
                      }}>
                        <div>
                          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 12, color: "#e2e8f0" }}>
                            {"\uD83E\uDD1A"} Passkey / Touch ID
                          </div>
                          <div style={{ fontFamily: "monospace", fontSize: 10, color: "#64748b", marginTop: 2 }}>
                            {hasFingerprint ? "Registered \u2014 available as login method" : "Not configured"}
                          </div>
                        </div>
                        {hasFingerprint ? (
                          <button onClick={handleRemoveFingerprint} style={{
                            padding: "6px 12px", borderRadius: 6, border: "1px solid rgba(239,68,68,0.3)",
                            background: "rgba(239,68,68,0.1)", color: "#ef4444", cursor: "pointer",
                            fontFamily: "monospace", fontSize: 10, fontWeight: 600, flexShrink: 0,
                          }}>Remove</button>
                        ) : (
                          <button onClick={handleSetupFingerprint} disabled={fpLoading} style={{
                            padding: "6px 12px", borderRadius: 6, border: `1px solid ${hexToRgba(activeAccent, 0.3)}`,
                            background: hexToRgba(activeAccent, 0.1), color: activeAccent,
                            cursor: fpLoading ? "not-allowed" : "pointer",
                            fontFamily: "monospace", fontSize: 10, fontWeight: 600, flexShrink: 0,
                            opacity: fpLoading ? 0.5 : 1,
                          }}>{fpLoading ? "Registering..." : "Set Up"}</button>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* Status message */}
                {authMsg && (
                  <div style={{
                    fontSize: 11, fontFamily: "monospace", marginTop: 4, padding: "6px 10px", borderRadius: 6,
                    color: authMsgType === "success" ? "#4ade80" : "#ef4444",
                    background: authMsgType === "success" ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
                  }}>
                    {authMsg}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Default Codebase Directory */}
          <div style={{ marginBottom: 22 }}>
            <label style={labelStyle}>DEFAULT CODEBASE DIRECTORY</label>
            <input
              value={defaultDir}
              onChange={e => setDefaultDir(e.target.value)}
              placeholder="/Users/you/projects"
              style={{
                width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8, padding: "10px 14px", color: "#f1f5f9", fontFamily: "monospace",
                fontSize: 13, outline: "none", boxSizing: "border-box",
              }}
            />
            <div style={{ fontSize: 10, color: "#475569", fontFamily: "monospace", marginTop: 4 }}>
              Used when no project is specified in workspace creation
            </div>
          </div>

          {/* Search Roots */}
          <div style={{ marginBottom: 22 }}>
            <label style={labelStyle}>SEARCH ROOTS</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
              {roots.length === 0 && (
                <div style={{ fontSize: 11, color: "#334155", fontFamily: "monospace", padding: "6px 0" }}>No search roots configured</div>
              )}
              {roots.map(r => (
                <div key={r} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 6, padding: "6px 10px",
                }}>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r}</span>
                  <button
                    onClick={() => removeRoot(r)}
                    style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontFamily: "monospace", fontSize: 14, padding: "0 4px", flexShrink: 0 }}
                  >
                    {"\u2715"}
                  </button>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={newRoot}
                onChange={e => setNewRoot(e.target.value)}
                placeholder="/path/to/projects"
                onKeyDown={e => e.key === "Enter" && addRoot()}
                style={{
                  flex: 1, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 6, padding: "8px 12px", color: "#f1f5f9", fontFamily: "monospace",
                  fontSize: 12, outline: "none", boxSizing: "border-box",
                }}
              />
              <button
                onClick={addRoot}
                style={{
                  background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.25)",
                  color: "#4ade80", padding: "8px 14px", borderRadius: 6,
                  fontFamily: "monospace", fontSize: 12, fontWeight: 600, cursor: "pointer",
                }}
              >
                + Add
              </button>
            </div>
            <div style={{ fontSize: 10, color: "#475569", fontFamily: "monospace", marginTop: 4 }}>
              Directories scanned when resolving project names (up to depth 5)
            </div>
          </div>

          {/* Clone Directory */}
          <div style={{ marginBottom: 22 }}>
            <label style={labelStyle}>CLONE DIRECTORY</label>
            <input
              value={cloneDir}
              onChange={e => setCloneDir(e.target.value)}
              placeholder="/Users/you/projects/cloned"
              style={{
                width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8, padding: "10px 14px", color: "#f1f5f9", fontFamily: "monospace",
                fontSize: 13, outline: "none", boxSizing: "border-box",
              }}
            />
            <div style={{ fontSize: 10, color: "#475569", fontFamily: "monospace", marginTop: 4 }}>
              Where GitHub repos are forked/cloned to
            </div>
          </div>

          {/* Theme */}
          <div style={{ marginBottom: 22 }}>
            <label style={labelStyle}>THEME</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 10 }}>
              {PRESET_THEMES.map(t => (
                <button
                  key={t.id}
                  onClick={() => setThemeId(t.id)}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                    padding: "10px 6px", borderRadius: 8, cursor: "pointer",
                    background: themeId === t.id ? hexToRgba(t.accent, 0.12) : "rgba(255,255,255,0.025)",
                    border: `1.5px solid ${themeId === t.id ? hexToRgba(t.accent, 0.5) : "rgba(255,255,255,0.06)"}`,
                    transition: "all 0.15s",
                  }}
                >
                  <div style={{
                    width: 24, height: 24, borderRadius: "50%", background: t.accent,
                    boxShadow: themeId === t.id ? `0 0 12px ${hexToRgba(t.accent, 0.5)}` : "none",
                  }} />
                  <span style={{ fontFamily: "monospace", fontSize: 10, color: themeId === t.id ? t.accent : "#64748b", fontWeight: 600 }}>
                    {t.name}
                  </span>
                </button>
              ))}
            </div>
            {/* Custom color */}
            <button
              onClick={() => setThemeId("custom")}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%",
                padding: "10px 14px", borderRadius: 8, cursor: "pointer",
                background: themeId === "custom" ? hexToRgba(customColor, 0.12) : "rgba(255,255,255,0.025)",
                border: `1.5px solid ${themeId === "custom" ? hexToRgba(customColor, 0.5) : "rgba(255,255,255,0.06)"}`,
                transition: "all 0.15s",
              }}
            >
              <input
                type="color"
                value={customColor}
                onChange={e => { setCustomColor(e.target.value); setThemeId("custom"); }}
                style={{ width: 24, height: 24, border: "none", background: "none", cursor: "pointer", padding: 0 }}
              />
              <span style={{ fontFamily: "monospace", fontSize: 11, color: themeId === "custom" ? customColor : "#64748b", fontWeight: 600 }}>
                Custom Color
              </span>
              <span style={{ fontFamily: "monospace", fontSize: 10, color: "#475569", marginLeft: "auto" }}>
                {customColor}
              </span>
            </button>
            {/* Preview bar */}
            <div style={{
              marginTop: 10, padding: "10px 14px", borderRadius: 8,
              background: `linear-gradient(135deg, ${activeAccent}, ${lightenHex(activeAccent, 0.3)})`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "#fff" }}>Preview</span>
              <span style={{ fontFamily: "monospace", fontSize: 10, color: "rgba(255,255,255,0.7)" }}>{activeAccent}</span>
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                flex: 1, padding: "12px", borderRadius: 8,
                background: saving ? "rgba(255,255,255,0.05)" : `linear-gradient(135deg, ${activeAccent}, ${lightenHex(activeAccent, 0.3)})`,
                border: "none", color: saving ? "#475569" : "#fff",
                fontFamily: "monospace", fontWeight: 700, fontSize: 14,
                cursor: saving ? "not-allowed" : "pointer",
                letterSpacing: 0.5, transition: "all 0.2s",
              }}
            >
              {saving ? "Saving..." : "Save Settings"}
            </button>
            <button
              onClick={handleReset}
              style={{
                padding: "12px 20px", borderRadius: 8,
                background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                color: "#64748b", fontFamily: "monospace", fontWeight: 600, fontSize: 12,
                cursor: "pointer", transition: "all 0.15s",
              }}
            >
              Reset
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionManagerModal({ workspace, onClose, onImport, onTakeOver, workspaces, tc }) {
  const [externalSessions, setExternalSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [killingPids, setKillingPids] = useState(new Set());
  const isScoped = !!workspace;

  async function fetchSessions() {
    setLoading(true);
    try {
      let url = `${API_BASE}/api/detect-claude-sessions`;
      if (isScoped && workspace.path) {
        url += `?cwd=${encodeURIComponent(workspace.path)}`;
      }
      const res = await fetch(url, { headers: authHeaders({}) });
      const data = await res.json();
      setExternalSessions(data.sessions || []);
    } catch {
      setExternalSessions([]);
    }
    setLoading(false);
  }

  useEffect(() => { fetchSessions(); }, []);

  async function killProcess(pid) {
    setKillingPids(prev => new Set([...prev, pid]));
    try {
      await fetch(`${API_BASE}/api/kill-process`, {
        method: "POST",
        headers: authHeaders({}),
        body: JSON.stringify({ pid }),
      });
    } catch {}
    setTimeout(() => {
      fetchSessions();
      setKillingPids(prev => { const s = new Set(prev); s.delete(pid); return s; });
    }, 1200);
  }

  async function killAllExternal() {
    const pids = externalSessions.map(s => s.pid);
    setKillingPids(new Set(pids));
    for (const pid of pids) {
      try {
        await fetch(`${API_BASE}/api/kill-process`, {
          method: "POST",
          headers: authHeaders({}),
          body: JSON.stringify({ pid }),
        });
      } catch {}
    }
    setTimeout(() => { fetchSessions(); setKillingPids(new Set()); }, 1200);
  }

  async function handleTakeOver(session) {
    // 1. Kill external process
    try {
      await fetch(`${API_BASE}/api/kill-process`, {
        method: "POST",
        headers: authHeaders({}),
        body: JSON.stringify({ pid: session.pid }),
      });
    } catch {}

    // 2. Kill current Vela session so new one can use --resume
    if (workspace) {
      try {
        await fetch(`${API_BASE}/api/kill-session`, {
          method: "POST",
          headers: authHeaders({}),
          body: JSON.stringify({ sessionId: workspace.id }),
        });
      } catch {}
    }

    // 3. Wait for processes to die, then notify parent
    setTimeout(() => {
      if (onTakeOver) onTakeOver(workspace, session);
      onClose();
    }, 800);
  }

  function handleImport(session) {
    const existing = workspaces?.find(w => w.path === session.cwd);
    if (existing) {
      openTerminalTab(existing);
    } else if (onImport) {
      onImport({
        name: session.projectName,
        path: session.cwd,
        services: [{
          id: generateId(),
          name: "Claude Code",
          agent: "claude",
          args: ["--dangerously-skip-permissions", "--resume"],
        }],
      });
    }
    onClose();
  }

  const meta = AGENT_META.claude;

  function renderSessionCard(session, actions) {
    const isKilling = killingPids.has(session.pid);
    return (
      <div key={session.pid} style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 10,
        padding: "14px 18px",
        transition: "all 0.15s",
        opacity: isKilling ? 0.5 : 1,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 18, color: meta.color }}>{meta.icon}</span>
            <div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>
                {session.projectName}
              </div>
              <div style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace" }}>
                PID: {session.pid}
              </div>
            </div>
          </div>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, fontFamily: "monospace", color: isKilling ? "#f59e0b" : "#22c55e", letterSpacing: 1, fontWeight: 700 }}>
            <span style={{
              width: 7, height: 7, borderRadius: "50%",
              background: isKilling ? "#f59e0b" : "#22c55e",
              boxShadow: `0 0 8px ${isKilling ? "rgba(245,158,11,0.4)" : "rgba(34,197,94,0.4)"}`,
              display: "inline-block",
              animation: isKilling ? "spin 1s linear infinite" : "pulse 2s infinite",
            }} />
            {isKilling ? "KILLING..." : "RUNNING"}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "#475569", fontFamily: "monospace", marginBottom: 6 }}>
          {session.cwd}
        </div>
        <div style={{ fontSize: 10, color: "#334155", fontFamily: "monospace", marginBottom: 12, wordBreak: "break-all" }}>
          $ {session.command}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {actions}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
      animation: "fadeIn 0.2s ease",
    }}>
      <div style={{
        background: "#0f1117",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 16,
        width: "min(660px, 92vw)",
        maxHeight: "85vh",
        overflow: "auto",
        boxShadow: "0 40px 80px rgba(0,0,0,0.8)",
        animation: "slideUp 0.25s ease",
      }}>
        {/* Header */}
        <div style={{ padding: "22px 28px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 20, color: "#f1f5f9", letterSpacing: 0.5 }}>
              {isScoped ? "Session Manager" : "External Sessions"}
            </div>
            <div style={{ color: "#475569", fontSize: 13, fontFamily: "monospace", marginTop: 3 }}>
              {isScoped ? (
                <>Manage sessions for <span style={{ color: "#94a3b8" }}>{workspace.name}</span></>
              ) : (
                "Detect and import Claude sessions running outside Vela"
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#475569", fontSize: 22, cursor: "pointer", padding: 4 }}>{"\u2715"}</button>
        </div>

        <div style={{ padding: "20px 28px 24px" }}>
          {/* Current Vela session (when scoped) */}
          {isScoped && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace", letterSpacing: 1, fontWeight: 700, marginBottom: 10 }}>
                VELA SESSION
              </div>
              <div style={{
                background: tc.glow006,
                border: `1px solid ${tc.glow015}`,
                borderRadius: 10,
                padding: "14px 18px",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 18, color: AGENT_META[workspace.agent].color }}>{AGENT_META[workspace.agent].icon}</span>
                    <div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>
                        {workspace.name}
                      </div>
                      <div style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace" }}>
                        ID: {workspace.id} {"\u00B7"} {workspace.args.join(" ")}
                      </div>
                    </div>
                  </div>
                  <StatusBadge status={workspace.status} />
                </div>
                {workspace.path && (
                  <div style={{ fontSize: 11, color: "#475569", fontFamily: "monospace", marginTop: 8 }}>
                    {workspace.path}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button
                    onClick={() => { openTerminalTab(workspace); onClose(); }}
                    disabled={workspace.status === "stopped"}
                    style={{
                      flex: 1,
                      background: workspace.status === "stopped" ? "rgba(255,255,255,0.03)" : tc.glow015,
                      border: `1px solid ${workspace.status === "stopped" ? "rgba(255,255,255,0.07)" : tc.glow03}`,
                      color: workspace.status === "stopped" ? "#334155" : tc.accent,
                      padding: "7px 14px", borderRadius: 6,
                      fontFamily: "monospace", fontSize: 11, fontWeight: 600,
                      cursor: workspace.status === "stopped" ? "not-allowed" : "pointer",
                    }}
                  >
                    {"\u238B"} Open Terminal {"\u2197"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* External sessions */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace", letterSpacing: 1, fontWeight: 700 }}>
              EXTERNAL SESSIONS {!loading && `(${externalSessions.length})`}
            </div>
            {externalSessions.length > 1 && (
              <button
                onClick={async () => {
                  if (!confirm(`Kill all ${externalSessions.length} external sessions?`)) return;
                  for (const s of externalSessions) {
                    try {
                      await fetch(`${API_BASE}/api/kill-process`, {
                        method: "POST",
                        headers: authHeaders({}),
                        body: JSON.stringify({ pid: s.pid }),
                      });
                    } catch {}
                  }
                  setTimeout(fetchSessions, 1000);
                }}
                style={{
                  background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)",
                  color: "#ef4444", padding: "4px 12px", borderRadius: 5,
                  fontFamily: "monospace", fontSize: 10, fontWeight: 700,
                  cursor: "pointer", letterSpacing: 0.3,
                }}
              >
                Kill All
              </button>
            )}
          </div>

          {loading ? (
            <div style={{ textAlign: "center", padding: "30px 0", color: "#64748b" }}>
              <div style={{ fontSize: 28, marginBottom: 12, animation: "spin 1s linear infinite", display: "inline-block" }}>{"\u27F3"}</div>
              <div style={{ fontFamily: "monospace", fontSize: 13 }}>Scanning for Claude sessions...</div>
            </div>
          ) : externalSessions.length === 0 ? (
            <div style={{ textAlign: "center", padding: "30px 0", color: "#475569" }}>
              <div style={{ fontSize: 24, marginBottom: 10 }}>{"\u2713"}</div>
              <div style={{ fontFamily: "monospace", fontSize: 13 }}>
                {isScoped ? "No external sessions for this project" : "No external Claude sessions detected"}
              </div>
              <div style={{ fontSize: 11, marginTop: 4, color: "#334155" }}>
                {isScoped ? "Only the Vela session is running for this project" : "Start a Claude session in your terminal to see it here"}
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {externalSessions.map(session => {
                const existingWs = workspaces?.find(w => w.path === session.cwd);
                const isKilling = killingPids.has(session.pid);

                return renderSessionCard(session, (
                  <>
                    {isScoped ? (
                      <button
                        onClick={() => handleTakeOver(session)}
                        disabled={isKilling}
                        style={{
                          flex: 1,
                          background: isKilling ? "rgba(255,255,255,0.03)" : "rgba(59,130,246,0.1)",
                          border: `1px solid ${isKilling ? "rgba(255,255,255,0.07)" : "rgba(59,130,246,0.3)"}`,
                          color: isKilling ? "#334155" : "#60a5fa",
                          padding: "7px 14px", borderRadius: 6,
                          fontFamily: "monospace", fontSize: 11, fontWeight: 700,
                          cursor: isKilling ? "not-allowed" : "pointer",
                          transition: "all 0.15s",
                        }}
                      >
                        {"\u21CB"} Take Over Session
                      </button>
                    ) : existingWs ? (
                      <button
                        onClick={() => { openTerminalTab(existingWs); onClose(); }}
                        style={{
                          flex: 1,
                          background: "rgba(34,197,94,0.1)",
                          border: "1px solid rgba(34,197,94,0.3)",
                          color: "#4ade80",
                          padding: "7px 14px", borderRadius: 6,
                          fontFamily: "monospace", fontSize: 11, fontWeight: 600,
                          cursor: "pointer", transition: "all 0.15s",
                        }}
                      >
                        {"\u2713"} Open in Vela ({existingWs.name})
                      </button>
                    ) : (
                      <button
                        onClick={() => handleImport(session)}
                        disabled={isKilling}
                        style={{
                          flex: 1,
                          background: isKilling ? "rgba(255,255,255,0.03)" : tc.glow015,
                          border: `1px solid ${isKilling ? "rgba(255,255,255,0.07)" : tc.glow03}`,
                          color: isKilling ? "#334155" : tc.accent,
                          padding: "7px 14px", borderRadius: 6,
                          fontFamily: "monospace", fontSize: 11, fontWeight: 700,
                          cursor: isKilling ? "not-allowed" : "pointer",
                          transition: "all 0.15s",
                        }}
                      >
                        {"\u2B07"} Import to Vela
                      </button>
                    )}
                    <button
                      onClick={() => killProcess(session.pid)}
                      disabled={isKilling}
                      style={{
                        background: isKilling ? "rgba(255,255,255,0.03)" : "rgba(239,68,68,0.1)",
                        border: `1px solid ${isKilling ? "rgba(255,255,255,0.07)" : "rgba(239,68,68,0.25)"}`,
                        color: isKilling ? "#334155" : "#ef4444",
                        padding: "7px 14px", borderRadius: 6,
                        fontFamily: "monospace", fontSize: 11, fontWeight: 600,
                        cursor: isKilling ? "not-allowed" : "pointer",
                        transition: "all 0.15s",
                      }}
                    >
                      {"\u25AA"} Kill
                    </button>
                  </>
                ));
              })}
            </div>
          )}

          {/* Bottom actions */}
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            {!loading && externalSessions.length > 1 && (
              <button
                onClick={killAllExternal}
                style={{
                  flex: 1,
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.2)",
                  color: "#ef4444",
                  padding: "10px", borderRadius: 8,
                  fontFamily: "monospace", fontSize: 12, fontWeight: 600,
                  cursor: "pointer", transition: "all 0.15s",
                }}
              >
                {"\u25AA"} Kill All External Sessions
              </button>
            )}
            {!loading && (
              <button
                onClick={fetchSessions}
                style={{
                  flex: externalSessions.length > 1 ? 0 : 1,
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  minWidth: externalSessions.length > 1 ? 120 : undefined,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "#64748b",
                  padding: "10px", borderRadius: 8,
                  fontFamily: "monospace", fontSize: 12, fontWeight: 600,
                  cursor: "pointer", transition: "all 0.15s",
                }}
              >
                {"\u21BB"} Refresh
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Track whether the initial load succeeded to prevent data destruction
let _loadedFromStorage = false;

// --- Base64url helpers for WebAuthn ---
function base64urlToBuffer(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bufferToBase64url(buffer) {
  return bufferToBase64(buffer).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function getAuthToken() {
  return localStorage.getItem("vela-auth-token") || "";
}

function authHeaders(extra = {}) {
  const token = getAuthToken();
  const h = { "Content-Type": "application/json", ...extra };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

// --- PinInput component ---
function PinInput({ length = 4, onComplete, error, disabled }) {
  const [digits, setDigits] = useState(Array(length).fill(""));
  const inputRefs = useRef([]);

  useEffect(() => {
    if (inputRefs.current[0]) inputRefs.current[0].focus();
  }, []);

  // Reset digits when error changes (wrong PIN)
  useEffect(() => {
    if (error) {
      setDigits(Array(length).fill(""));
      setTimeout(() => { if (inputRefs.current[0]) inputRefs.current[0].focus(); }, 300);
    }
  }, [error, length]);

  function handleChange(index, value) {
    if (!/^\d?$/.test(value)) return;
    const next = [...digits];
    next[index] = value;
    setDigits(next);

    if (value && index < length - 1) {
      inputRefs.current[index + 1].focus();
    }
    if (next.every(d => d !== "")) {
      onComplete(next.join(""));
    }
  }

  function handleKeyDown(index, e) {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1].focus();
    }
  }

  function handlePaste(e) {
    e.preventDefault();
    const text = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, length);
    if (!text) return;
    const next = Array(length).fill("");
    for (let i = 0; i < text.length; i++) next[i] = text[i];
    setDigits(next);
    if (text.length >= length) onComplete(next.join(""));
    else if (inputRefs.current[text.length]) inputRefs.current[text.length].focus();
  }

  const boxStyle = (i) => ({
    width: 48, height: 56, textAlign: "center",
    fontSize: 24, fontWeight: 700,
    background: "#0d1117",
    border: `2px solid ${error ? "#ef4444" : digits[i] ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.08)"}`,
    borderRadius: 12, color: "#f1f5f9",
    fontFamily: "'JetBrains Mono', monospace",
    outline: "none", caretColor: "transparent",
    transition: "border-color 0.15s",
  });

  return (
    <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={el => inputRefs.current[i] = el}
          type="password"
          inputMode="numeric"
          maxLength={1}
          value={d}
          disabled={disabled}
          onChange={e => handleChange(i, e.target.value)}
          onKeyDown={e => handleKeyDown(i, e)}
          onPaste={handlePaste}
          style={boxStyle(i)}
        />
      ))}
    </div>
  );
}

// --- Onboarding Flow ---
function OnboardingFlow({ onComplete }) {
  const [step, setStep] = useState(0);
  const [roots, setRoots] = useState([]);
  const [cloneDir, setCloneDir] = useState("");
  const [newRoot, setNewRoot] = useState("");
  const [enableAuth, setEnableAuth] = useState(false);
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [pinStep, setPinStep] = useState("enter"); // "enter" | "confirm"
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Load defaults
  useEffect(() => {
    fetch(`${API_BASE}/api/config`, { headers: authHeaders({}) }).then(r => r.json()).then(data => {
      if (data.searchRoots?.length) setRoots(data.searchRoots);
      if (data.cloneDir) setCloneDir(data.cloneDir);
    }).catch(() => {});
  }, []);

  function addRoot() {
    const v = newRoot.trim();
    if (v && !roots.includes(v)) { setRoots(prev => [...prev, v]); setNewRoot(""); }
  }

  async function handleFinish() {
    if (enableAuth) {
      if (pin.length < 4) { setError("PIN must be at least 4 digits"); return; }
      if (pin !== pinConfirm) { setError("PINs do not match"); setPinStep("enter"); setPin(""); setPinConfirm(""); return; }
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/setup`, {
        method: "POST",
        headers: authHeaders({}),
        body: JSON.stringify({ enableAuth, pin: enableAuth ? pin : "", searchRoots: roots, cloneDir }),
      });
      const data = await res.json();
      if (data.success) {
        // Save settings to localStorage for the existing settings flow
        const s = { searchRoots: roots, cloneDir, defaultCodebaseDir: roots[0] || "" };
        try { localStorage.setItem("vela-settings", JSON.stringify(s)); } catch {}
        onComplete(data.token);
      } else {
        setError(data.error || "Setup failed");
      }
    } catch {
      setError("Could not connect to server");
    }
    setLoading(false);
  }

  const cardStyle = {
    background: "#0f1117", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20,
    width: "min(520px, 92vw)", padding: "36px 32px", boxShadow: "0 40px 80px rgba(0,0,0,0.8)",
    animation: "slideUp 0.3s ease",
  };
  const btnPrimary = {
    padding: "12px 32px", borderRadius: 10, border: "none", fontFamily: "'JetBrains Mono', monospace",
    fontWeight: 700, fontSize: 14, cursor: "pointer", letterSpacing: 0.5,
    background: "linear-gradient(135deg, #f97316, #fb923c)", color: "#fff",
    transition: "all 0.2s",
  };
  const btnSecondary = {
    padding: "12px 24px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.04)", color: "#94a3b8",
    fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 13, cursor: "pointer",
  };
  const inputStyle = {
    width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 8, padding: "10px 14px", color: "#f1f5f9", fontFamily: "monospace",
    fontSize: 13, outline: "none", boxSizing: "border-box",
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#080b10",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes slideUp { from { transform: translateY(20px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
        input:focus { border-color: rgba(255,255,255,0.25) !important; }
      `}</style>

      {/* Background grid */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none",
        backgroundImage: "linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)",
        backgroundSize: "40px 40px",
      }} />

      {step === 0 && (
        <div style={{ ...cardStyle, width: "min(640px, 92vw)", padding: "48px 40px", textAlign: "center" }}>
          {/* Glowing logo */}
          <div style={{
            width: 72, height: 72, margin: "0 auto 24px", borderRadius: 18,
            background: "linear-gradient(135deg, rgba(249,115,22,0.15), rgba(251,146,60,0.08))",
            border: "1px solid rgba(249,115,22,0.3)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 0 40px rgba(249,115,22,0.15), inset 0 0 20px rgba(249,115,22,0.05)",
          }}>
            <span style={{ fontSize: 36, color: "#f97316", filter: "drop-shadow(0 0 8px rgba(249,115,22,0.5))" }}>{"\u25C6"}</span>
          </div>

          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 32, color: "#f1f5f9", letterSpacing: 1.5 }}>
            Welcome to Vela
          </div>
          <div style={{ color: "#94a3b8", fontSize: 15, marginTop: 10, lineHeight: 1.7 }}>
            Your command center for AI coding agents.
          </div>

          {/* Feature highlights */}
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12,
            margin: "32px 0", textAlign: "left",
          }}>
            {[
              { icon: "\u25B6", title: "Launch Agents", desc: "Spawn Claude Code, Codex, or custom shells in managed terminals" },
              { icon: "\u21C4", title: "Multi-Service", desc: "Run multiple agents side by side in a single workspace" },
              { icon: "\u21BB", title: "Session Persistence", desc: "Sessions survive disconnects with full scrollback replay" },
              { icon: "\uD83D\uDD12", title: "Optional Security", desc: "PIN and fingerprint authentication to protect your dashboard" },
            ].map((f, i) => (
              <div key={i} style={{
                padding: "14px 16px", borderRadius: 12,
                background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 14, opacity: 0.7 }}>{f.icon}</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 12, color: "#e2e8f0", letterSpacing: 0.5 }}>
                    {f.title}
                  </span>
                </div>
                <div style={{ fontFamily: "monospace", fontSize: 11, color: "#64748b", lineHeight: 1.5 }}>
                  {f.desc}
                </div>
              </div>
            ))}
          </div>

          {/* Version / credits */}
          <div style={{ color: "#334155", fontSize: 11, fontFamily: "monospace", marginBottom: 28 }}>
            v1.0 {"\u00B7"} Built for developers who ship with AI
          </div>

          <button onClick={() => setStep(1)} style={{ ...btnPrimary, padding: "14px 40px", fontSize: 15 }}>
            Get Started {"\u2192"}
          </button>
        </div>
      )}

      {step === 1 && (
        <div style={{ ...cardStyle, width: "min(600px, 92vw)", padding: "40px 36px" }}>
          {/* Step indicator */}
          <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
            {[1, 2].map(n => (
              <div key={n} style={{
                height: 3, flex: 1, borderRadius: 2,
                background: n <= 1 ? "#f97316" : "rgba(255,255,255,0.08)",
                transition: "background 0.3s",
              }} />
            ))}
          </div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 22, color: "#f1f5f9", marginBottom: 6 }}>
            Project Directories
          </div>
          <div style={{ color: "#64748b", fontSize: 13, marginBottom: 8, fontFamily: "monospace", lineHeight: 1.6 }}>
            Tell Vela where your projects live. It will scan these directories (up to 5 levels deep) to find repos when you create a workspace.
          </div>
          <div style={{ color: "#475569", fontSize: 11, marginBottom: 24, fontFamily: "monospace", padding: "8px 12px", borderRadius: 8, background: "rgba(249,115,22,0.05)", border: "1px solid rgba(249,115,22,0.1)" }}>
            Tip: Add your main workspace folder (e.g. ~/Desktop/workplace) to cover all projects at once.
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 10, fontWeight: 700, color: "#475569", letterSpacing: 1.5, fontFamily: "monospace", display: "block", marginBottom: 6 }}>
              SEARCH ROOTS
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
              {roots.map(r => (
                <div key={r} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 6, padding: "6px 10px",
                }}>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "#94a3b8" }}>{r}</span>
                  <button onClick={() => setRoots(prev => prev.filter(x => x !== r))}
                    style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontFamily: "monospace", fontSize: 14 }}>
                    {"\u2715"}
                  </button>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={newRoot} onChange={e => setNewRoot(e.target.value)}
                placeholder="/path/to/projects" onKeyDown={e => e.key === "Enter" && addRoot()}
                style={{ ...inputStyle, flex: 1, fontSize: 12 }} />
              <button onClick={addRoot} style={{
                background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.25)",
                color: "#4ade80", padding: "8px 14px", borderRadius: 6,
                fontFamily: "monospace", fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>+ Add</button>
            </div>
          </div>

          <div style={{ marginBottom: 28 }}>
            <label style={{ fontSize: 10, fontWeight: 700, color: "#475569", letterSpacing: 1.5, fontFamily: "monospace", display: "block", marginBottom: 6 }}>
              CLONE DIRECTORY
            </label>
            <input value={cloneDir} onChange={e => setCloneDir(e.target.value)}
              placeholder="/path/to/cloned/repos" style={inputStyle} />
            <div style={{ fontSize: 10, color: "#475569", fontFamily: "monospace", marginTop: 4 }}>
              Where GitHub repos are forked/cloned to
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button onClick={() => setStep(0)} style={btnSecondary}>Back</button>
            <button onClick={() => setStep(2)} style={btnPrimary}>Continue</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div style={{ ...cardStyle, width: "min(600px, 92vw)", padding: "40px 36px" }}>
          {/* Step indicator */}
          <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
            {[1, 2].map(n => (
              <div key={n} style={{
                height: 3, flex: 1, borderRadius: 2,
                background: n <= 2 ? "#f97316" : "rgba(255,255,255,0.08)",
                transition: "background 0.3s",
              }} />
            ))}
          </div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 22, color: "#f1f5f9", marginBottom: 6 }}>
            Security
          </div>
          <div style={{ color: "#64748b", fontSize: 13, marginBottom: 8, fontFamily: "monospace", lineHeight: 1.6 }}>
            Add a PIN to protect your dashboard from unauthorized access. You can also set up fingerprint authentication later in Settings.
          </div>
          <div style={{ color: "#475569", fontSize: 11, marginBottom: 24, fontFamily: "monospace", padding: "8px 12px", borderRadius: 8, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
            You can always change these settings later from the Settings panel.
          </div>

          {/* Toggle */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "14px 16px", borderRadius: 10,
            background: enableAuth ? "rgba(249,115,22,0.08)" : "rgba(255,255,255,0.025)",
            border: `1px solid ${enableAuth ? "rgba(249,115,22,0.25)" : "rgba(255,255,255,0.06)"}`,
            marginBottom: 24, cursor: "pointer", transition: "all 0.2s",
          }} onClick={() => { setEnableAuth(!enableAuth); setError(""); }}>
            <div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 13, color: "#f1f5f9" }}>
                Enable PIN Authentication
              </div>
              <div style={{ fontFamily: "monospace", fontSize: 11, color: "#64748b", marginTop: 2 }}>
                Required each time you open the dashboard
              </div>
            </div>
            <div style={{
              width: 44, height: 24, borderRadius: 12, padding: 2,
              background: enableAuth ? "#f97316" : "rgba(255,255,255,0.1)",
              transition: "background 0.2s", flexShrink: 0,
            }}>
              <div style={{
                width: 20, height: 20, borderRadius: 10, background: "#fff",
                transform: enableAuth ? "translateX(20px)" : "translateX(0)",
                transition: "transform 0.2s",
              }} />
            </div>
          </div>

          {enableAuth && (
            <div style={{ marginBottom: 24 }}>
              {pinStep === "enter" ? (
                <>
                  <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 13, fontFamily: "'JetBrains Mono', monospace", marginBottom: 16 }}>
                    Enter a PIN (4+ digits)
                  </div>
                  <PinInput length={6} error={!!error} onComplete={(p) => { setPin(p); setPinStep("confirm"); setError(""); }} />
                </>
              ) : (
                <>
                  <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 13, fontFamily: "'JetBrains Mono', monospace", marginBottom: 16 }}>
                    Confirm your PIN
                  </div>
                  <PinInput length={6} error={!!error} onComplete={(p) => { setPinConfirm(p); }} />
                </>
              )}
              {error && (
                <div style={{ textAlign: "center", color: "#ef4444", fontSize: 12, fontFamily: "monospace", marginTop: 12 }}>
                  {error}
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button onClick={() => { setStep(1); setError(""); }} style={btnSecondary}>Back</button>
            <button
              onClick={handleFinish}
              disabled={loading || (enableAuth && pinStep === "enter") || (enableAuth && pinStep === "confirm" && !pinConfirm)}
              style={{
                ...btnPrimary,
                opacity: (loading || (enableAuth && pinStep === "enter") || (enableAuth && pinStep === "confirm" && !pinConfirm)) ? 0.5 : 1,
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              {loading ? "Setting up..." : "Complete Setup"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Auth Gate ---
function AuthGate({ authStatus, onSuccess }) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [fingerprintAttempted, setFingerprintAttempted] = useState(false);

  async function handlePinSubmit(pin) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/auth/verify-pin`, {
        method: "POST",
        headers: authHeaders({}),
        body: JSON.stringify({ pin }),
      });
      const data = await res.json();
      if (data.success) {
        onSuccess(data.token);
      } else {
        setError("Invalid PIN");
      }
    } catch {
      setError("Could not connect to server");
    }
    setLoading(false);
  }

  async function handleFingerprint() {
    setError("");
    try {
      const optRes = await fetch(`${API_BASE}/api/auth/webauthn/login-options`);
      const options = await optRes.json();
      if (options.error) { setError(options.error); return; }

      const credential = await navigator.credentials.get({
        publicKey: {
          challenge: base64urlToBuffer(options.challenge),
          rpId: options.rpId,
          allowCredentials: options.allowCredentials.map(c => ({
            type: c.type,
            id: base64urlToBuffer(c.id),
          })),
          userVerification: options.userVerification,
          timeout: options.timeout,
        },
      });

      const res = await fetch(`${API_BASE}/api/auth/webauthn/login`, {
        method: "POST",
        headers: authHeaders({}),
        body: JSON.stringify({
          sessionKey: options.sessionKey,
          credentialId: bufferToBase64url(credential.rawId),
          authenticatorData: bufferToBase64(credential.response.authenticatorData),
          clientDataJSON: bufferToBase64(credential.response.clientDataJSON),
          signature: bufferToBase64(credential.response.signature),
        }),
      });
      const data = await res.json();
      if (data.success) {
        onSuccess(data.token);
      } else {
        setError(data.error || "Fingerprint verification failed");
      }
    } catch (e) {
      if (e.name !== "NotAllowedError") {
        setError("Fingerprint verification failed");
      }
    }
  }

  // Auto-trigger fingerprint on mount
  useEffect(() => {
    if (authStatus.hasFingerprint && !fingerprintAttempted) {
      setFingerprintAttempted(true);
      handleFingerprint();
    }
  }, []);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#080b10",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes slideUp { from { transform: translateY(20px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
        input:focus { border-color: rgba(255,255,255,0.25) !important; }
      `}</style>

      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none",
        backgroundImage: "linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)",
        backgroundSize: "40px 40px",
      }} />

      <div style={{
        background: "#0f1117", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20,
        width: "min(420px, 92vw)", padding: "40px 32px", textAlign: "center",
        boxShadow: "0 40px 80px rgba(0,0,0,0.8)", animation: "slideUp 0.3s ease",
      }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>{"\u25C6"}</div>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 22, color: "#f1f5f9", letterSpacing: 0.5, marginBottom: 4 }}>
          Vela
        </div>
        <div style={{ color: "#64748b", fontSize: 12, fontFamily: "monospace", marginBottom: 32 }}>
          Enter your PIN to unlock
        </div>

        <PinInput length={6} error={!!error} disabled={loading} onComplete={handlePinSubmit} />

        {error && (
          <div style={{
            color: "#ef4444", fontSize: 12, fontFamily: "monospace", marginTop: 14,
            animation: "fadeIn 0.2s",
          }}>
            {error}
          </div>
        )}

        {authStatus.hasFingerprint && (
          <button onClick={handleFingerprint} style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            margin: "24px auto 0", padding: "10px 24px", borderRadius: 10,
            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
            color: "#94a3b8", fontFamily: "'JetBrains Mono', monospace", fontSize: 13,
            fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
          }}>
            <span style={{ fontSize: 18 }}>{"\uD83E\uDD1A"}</span> Use Fingerprint
          </button>
        )}
      </div>
    </div>
  );
}

function loadWorkspaces() {
  try {
    const saved = localStorage.getItem("vela-workspaces");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      const result = parsed.map(ws => {
        // Migrate old format: single agent/args → services array
        if (!ws.services) {
          const svc = {
            id: generateId(),
            name: AGENT_META[ws.agent]?.brand || ws.agent || "Agent",
            agent: ws.agent || "claude",
            args: ws.args || [],
          };
          if (ws.agent === "ralph") {
            svc.loopCount = ws.loopCount;
            svc.donePrompt = ws.donePrompt;
          }
          return { ...ws, services: [svc] };
        }
        return ws;
      });
      _loadedFromStorage = result.length > 0;
      return result;
    }
  } catch (e) {
    console.error("[Vela] Failed to load workspaces from localStorage:", e);
    // Don't return [] here — we'll mark _loadedFromStorage as false
    // so saveWorkspaces won't overwrite whatever is in storage
  }
  return [];
}

function saveWorkspaces(workspaces) {
  try {
    // Prevent saving empty array if we failed to load — avoids wiping real data
    if (workspaces.length === 0 && !_loadedFromStorage) {
      const existing = localStorage.getItem("vela-workspaces");
      if (existing && existing !== "[]") return;
    }
    localStorage.setItem("vela-workspaces", JSON.stringify(workspaces));
    _loadedFromStorage = true;
  } catch {}
}

function loadSettings() {
  try {
    const saved = localStorage.getItem("vela-settings");
    if (saved) return JSON.parse(saved);
  } catch {}
  return null;
}

function saveSettings(s) {
  try {
    localStorage.setItem("vela-settings", JSON.stringify(s));
  } catch {}
}

export default function App() {
  const [authStatus, setAuthStatus] = useState(null); // null = loading
  const [authToken, setAuthToken] = useState(() => getAuthToken());
  const [workspaces, setWorkspaces] = useState(loadWorkspaces);
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);

  // Check auth status on mount and when token changes
  useEffect(() => {
    const headers = {};
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
    fetch(`${API_BASE}/api/auth/status`, { headers })
      .then(r => r.json())
      .then(setAuthStatus)
      .catch(() => {
        // Backend unreachable — skip auth to avoid lockout
        setAuthStatus({ onboardingDone: true, enabled: false, authenticated: true });
      });
  }, [authToken]);

  function handleAuthSuccess(token) {
    if (token) {
      localStorage.setItem("vela-auth-token", token);
      setAuthToken(token);
    }
    // Refresh auth status
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    fetch(`${API_BASE}/api/auth/status`, { headers })
      .then(r => r.json())
      .then(setAuthStatus)
      .catch(() => {});
  }

  // Persist whenever workspaces change
  useEffect(() => {
    saveWorkspaces(workspaces);
  }, [workspaces]);

  // Reconcile workspace status with backend after system sleep / tab restore
  useEffect(() => {
    let lastHidden = 0;

    async function reconcileSessions() {
      try {
        const res = await fetch(`${API_BASE}/api/sessions`, { headers: authHeaders({}) });
        if (!res.ok) return;
        const { sessions: alive } = await res.json();
        const aliveIds = new Set(alive.filter(s => s.alive).map(s => s.id));

        setWorkspaces(prev => {
          let changed = false;
          const next = prev.map(w => {
            if (w.status === "running" && !aliveIds.has(w.id)) {
              changed = true;
              return { ...w, status: "stopped" };
            }
            return w;
          });
          return changed ? next : prev;
        });
      } catch {
        // Backend unreachable — mark all running as stopped
        setWorkspaces(prev => {
          let changed = false;
          const next = prev.map(w => {
            if (w.status === "running") {
              changed = true;
              return { ...w, status: "stopped" };
            }
            return w;
          });
          return changed ? next : prev;
        });
      }
    }

    function onVisibilityChange() {
      if (document.hidden) {
        lastHidden = Date.now();
      } else {
        // Only reconcile if we were hidden for >30 seconds (likely sleep or long background)
        if (lastHidden && Date.now() - lastHidden > 30_000) {
          reconcileSessions();
        }
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    // Also reconcile once on mount (handles page refresh after sleep)
    reconcileSessions();
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // Seed settings from server on first load
  useEffect(() => {
    if (settings !== null) {
      // Push existing settings to server on load
      fetch(`${API_BASE}/api/config`, {
        method: "POST",
        headers: authHeaders({}),
        body: JSON.stringify({ searchRoots: settings.searchRoots, cloneDir: settings.cloneDir }),
      }).catch(() => {});
      return;
    }
    fetch(`${API_BASE}/api/config`, { headers: authHeaders({}) })
      .then(r => r.json())
      .then(data => {
        const defaults = {
          defaultCodebaseDir: data.searchRoots?.[0] || "",
          searchRoots: data.searchRoots || [],
          cloneDir: data.cloneDir || "",
        };
        setSettings(defaults);
        saveSettings(defaults);
      })
      .catch(() => {
        setSettings({ defaultCodebaseDir: "", searchRoots: [], cloneDir: "" });
      });
  }, []);

  const [showCreate, setShowCreate] = useState(false);
  const [sessionManagerTarget, setSessionManagerTarget] = useState(null); // null=closed, "all"=unscoped, workspace=scoped
  const [filter, setFilter] = useState("all");

  function handleCreate(ws) {
    setWorkspaces(prev => [{
      id: generateId(), ...ws, status: "running", createdAt: Date.now(),
    }, ...prev]);
  }

  function handleTerminate(id) {
    // Kill the backend PTY session
    fetch(`${API_BASE}/api/kill-session`, {
      method: "POST",
      headers: authHeaders({}),
      body: JSON.stringify({ sessionId: id }),
    }).catch(() => {});
    setWorkspaces(prev => prev.map(w => w.id === id ? { ...w, status: "stopped" } : w));
  }

  function handleResume(id) {
    setWorkspaces(prev => prev.map(w => w.id === id ? { ...w, status: "running" } : w));
  }

  function handleDelete(id) {
    const ws = workspaces.find(w => w.id === id);
    // Kill backend session before removing from list
    fetch(`${API_BASE}/api/kill-session`, {
      method: "POST",
      headers: authHeaders({}),
      body: JSON.stringify({ sessionId: id }),
    }).catch(() => {});
    // Clean up worktree if isolated
    if (ws?.isolated && ws?.worktreePath) {
      fetch(`${API_BASE}/api/worktree/remove`, {
        method: "POST",
        headers: authHeaders({}),
        body: JSON.stringify({ worktreePath: ws.worktreePath, repoPath: ws.services?.[0]?.path || "" }),
      }).catch(() => {});
    }
    setWorkspaces(prev => prev.filter(w => w.id !== id));
  }

  function handleTakeOver(ws, externalSession) {
    const updatedArgs = ["--dangerously-skip-permissions", "--resume"];
    const updatedServices = (ws.services || []).map((s, i) =>
      i === 0 ? { ...s, args: updatedArgs } : s
    );
    setWorkspaces(prev => prev.map(w =>
      w.id === ws.id ? { ...w, services: updatedServices, status: "running" } : w
    ));
    openTerminalTab({ ...ws, services: updatedServices });
  }

  const [addServiceTarget, setAddServiceTarget] = useState(null); // workspace id for inline add

  function handleAddService(wsId) {
    setAddServiceTarget(wsId);
  }

  const tc = getThemeColors(settings?.theme);

  const filtered = workspaces.filter(w => {
    if (filter === "all") return true;
    if (filter === "running" || filter === "idle" || filter === "stopped") return w.status === filter;
    // Agent type filter — match if any service uses that agent
    return w.services?.some(s => s.agent === filter);
  });

  const counts = {
    running: workspaces.filter(w => w.status === "running").length,
    idle: workspaces.filter(w => w.status === "idle").length,
    stopped: workspaces.filter(w => w.status === "stopped").length,
  };

  // --- Auth gates (rendered before dashboard) ---
  if (authStatus === null) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#080b10" }}>
        <div style={{ width: 36, height: 36, borderRadius: "50%", border: "3px solid rgba(255,255,255,0.1)", borderTopColor: "#f97316", animation: "spin 1s linear infinite" }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    );
  }

  if (!authStatus.onboardingDone) {
    return <OnboardingFlow onComplete={handleAuthSuccess} />;
  }

  if (authStatus.enabled && !authStatus.authenticated) {
    return <AuthGate authStatus={authStatus} onSuccess={handleAuthSuccess} />;
  }

  return (
    <div style={{ minHeight: "100vh", background: "#080b10", color: "#f1f5f9", fontFamily: "system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes slideUp { from { transform: translateY(20px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }
        @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } }
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        @keyframes scanline { 0% { transform: translateY(-100%) } 100% { transform: translateY(100vh) } }
        ::-webkit-scrollbar { width: 6px } ::-webkit-scrollbar-track { background: transparent }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px }
        input:focus { border-color: rgba(255,255,255,0.25) !important; }
      `}</style>

      {/* Subtle grid background */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
        backgroundImage: "linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)",
        backgroundSize: "40px 40px",
      }} />

      <div style={{ position: "relative", zIndex: 1, maxWidth: 1440, margin: "0 auto", padding: "0 32px", display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        {/* Header */}
        <header style={{ padding: "24px 0 20px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ filter: `drop-shadow(0 0 8px ${tc.glow06})` }}>
                  <path d="M12 2 C12 2 4 14 4 18 C4 18 8 16 12 22 C16 16 20 18 20 18 C20 14 12 2 12 2Z" fill={tc.accent} opacity="0.9" />
                  <path d="M12 6 C12 6 7 14 7 17 C9 16 11 17 12 20 C13 17 15 16 17 17 C17 14 12 6 12 6Z" fill={tc.accentLight} opacity="0.5" />
                </svg>
                <h1 style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700, color: "#f1f5f9", letterSpacing: -0.3 }}>
                  Vela
                </h1>
              </div>
              <p style={{ color: "#475569", fontSize: 12, fontFamily: "monospace", marginLeft: 32 }}>
                Orchestrate AI coding agents from a single dashboard
              </p>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {authStatus?.enabled && (
                <button
                  onClick={() => {
                    localStorage.removeItem("vela-auth-token");
                    setAuthToken("");
                    fetch(`${API_BASE}/api/auth/logout`, { method: "POST", headers: authHeaders({}) }).catch(() => {});
                    setAuthStatus(prev => ({ ...prev, authenticated: false }));
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    background: "rgba(239,68,68,0.06)",
                    border: "1px solid rgba(239,68,68,0.15)",
                    borderRadius: 8, padding: "9px 14px",
                    color: "#ef4444", fontFamily: "monospace", fontWeight: 600,
                    fontSize: 12, cursor: "pointer",
                    transition: "all 0.2s",
                  }}
                  title="Lock Dashboard"
                >
                  {"\uD83D\uDD12"} Lock
                </button>
              )}
              <button
                onClick={() => setShowSettings(true)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 8, padding: "9px 14px",
                  color: "#64748b", fontFamily: "monospace", fontWeight: 600,
                  fontSize: 14, cursor: "pointer",
                  transition: "all 0.2s",
                }}
                title="Settings"
              >
                {"\u2699"}
              </button>
              <button
                onClick={() => setSessionManagerTarget("all")}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 8, padding: "9px 18px",
                  color: "#94a3b8", fontFamily: "monospace", fontWeight: 600,
                  fontSize: 12, cursor: "pointer", letterSpacing: 0.3,
                  transition: "all 0.2s",
                }}
              >
                <span style={{ fontSize: 15 }}>{"\u21CB"}</span>
                Import Session
              </button>
              <button
                onClick={() => setShowCreate(true)}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  background: `linear-gradient(135deg, ${tc.accent}, ${tc.accentLight})`,
                  border: "none", borderRadius: 8, padding: "9px 18px",
                  color: "#fff", fontFamily: "monospace", fontWeight: 700,
                  fontSize: 12, cursor: "pointer", letterSpacing: 0.3,
                  boxShadow: `0 0 24px ${tc.glow03}`,
                  transition: "all 0.2s",
                }}
              >
                <span style={{ fontSize: 15 }}>+</span>
                New Workspace
              </button>
            </div>
          </div>
        </header>

        {/* Toolbar: stats + filter tabs in one row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0", flexWrap: "wrap", gap: 12 }}>
          {/* Stats */}
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            {[
              { key: "running", color: "#22c55e", count: counts.running },
              { key: "idle", color: "#f59e0b", count: counts.idle },
              { key: "stopped", color: "#6b7280", count: counts.stopped },
            ].map(s => (
              <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: s.color }} />
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "#475569" }}>
                  <span style={{ color: "#94a3b8", fontWeight: 600 }}>{s.count}</span> {s.key}
                </span>
              </div>
            ))}
            <span style={{ fontFamily: "monospace", fontSize: 12, color: "#334155" }}>
              {"\u00B7"} {workspaces.length} total
            </span>
          </div>

          {/* Filter tabs */}
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {[
              { key: "all", label: "All" },
              { key: "running", label: "Running" },
              { key: "idle", label: "Idle" },
              { key: "stopped", label: "Stopped" },
              { key: "claude", label: "\u25C6 Claude" },
              { key: "codex", label: "\u2B21 Codex" },
              { key: "ralph", label: "\u21BB Ralph" },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setFilter(tab.key)}
                style={{
                  background: filter === tab.key ? tc.glow015 : "rgba(255,255,255,0.03)",
                  border: `1px solid ${filter === tab.key ? tc.glow04 : "rgba(255,255,255,0.06)"}`,
                  color: filter === tab.key ? tc.accent : "#6b7280",
                  padding: "6px 14px", borderRadius: 6, cursor: "pointer",
                  fontFamily: "monospace", fontSize: 12, fontWeight: 600,
                  transition: "all 0.15s", letterSpacing: 0.3,
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Grid */}
        <div style={{ flex: 1 }}>
          {filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "80px 0", color: "#334155" }}>
              <div style={{ fontSize: 40, marginBottom: 16 }}>{"\u2B21"}</div>
              <div style={{ fontFamily: "monospace", fontSize: 14 }}>No workspaces yet</div>
              <div style={{ fontSize: 12, marginTop: 6 }}>Create one to get started</div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12, paddingBottom: 40 }}>
              {filtered.map(ws => (
                <WorkspaceCard
                  key={ws.id}
                  ws={ws}
                  onTerminate={handleTerminate}
                  onResume={handleResume}
                  onDelete={handleDelete}
                  onManageSessions={setSessionManagerTarget}
                  onAddService={handleAddService}
                  onOpen={(w) => openTerminalTab(w, (worktreePath, branchName) => {
                    setWorkspaces(prev => prev.map(x => x.id === w.id ? { ...x, worktreePath, branchName } : x));
                  })}
                  tc={tc}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
          settings={settings}
        />
      )}

      {addServiceTarget && (
        <AddServiceModal
          onClose={() => setAddServiceTarget(null)}
          defaultDir={settings?.defaultCodebaseDir || ""}
          onAdd={(svc) => {
            setWorkspaces(prev => prev.map(w =>
              w.id === addServiceTarget ? { ...w, services: [...(w.services || []), svc] } : w
            ));
            setAddServiceTarget(null);
          }}
        />
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSave={(s) => { setSettings(s); saveSettings(s); }}
        />
      )}

      {sessionManagerTarget && (
        <SessionManagerModal
          workspace={sessionManagerTarget === "all" ? null : sessionManagerTarget}
          onClose={() => setSessionManagerTarget(null)}
          onImport={handleCreate}
          onTakeOver={handleTakeOver}
          workspaces={workspaces}
          tc={tc}
        />
      )}
    </div>
  );
}
