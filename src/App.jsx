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

function openTerminalTab(ws) {
  const args = ws.args.join(",");
  const cwd = ws.path || "";
  let url = `/terminal.html?agent=${ws.agent}&args=${encodeURIComponent(args)}&name=${encodeURIComponent(ws.name)}&id=${ws.id}&cwd=${encodeURIComponent(cwd)}`;
  if (ws.agent === "ralph") {
    url += `&loopCount=${ws.loopCount || 20}&donePrompt=${encodeURIComponent(ws.donePrompt || "")}`;
  }
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

function WorkspaceCard({ ws, onTerminate, onResume, onDelete, onManageSessions, tc }) {
  const meta = AGENT_META[ws.agent];
  const [hovered, setHovered] = useState(false);

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
          <span style={{ fontSize: 16, color: tc.accent, flexShrink: 0 }}>{meta.icon}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 14, color: "#f1f5f9", letterSpacing: 0.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ws.name}</div>
            <div style={{ fontSize: 10, color: "#64748b", fontFamily: "monospace", marginTop: 1 }}>{ws.id} {"\u00B7"} {getRelativeTime(ws.createdAt)}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <StatusBadge status={ws.status} />
        </div>
      </div>

      {ws.path && <div style={{ fontSize: 10, color: "#334155", fontFamily: "monospace", marginBottom: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ws.path}</div>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 14 }}>
        <span style={{
          background: hexToRgba(tc.accent, 0.09),
          color: tc.accent,
          border: `1px solid ${hexToRgba(tc.accent, 0.2)}`,
          padding: "2px 9px",
          borderRadius: 20,
          fontSize: 10,
          fontFamily: "monospace",
          fontWeight: 600,
          letterSpacing: 0.3,
        }}>{meta.brand}</span>
        {ws.agent === "ralph" ? (
          <>
            <span style={{ background: "rgba(6,182,212,0.1)", border: "1px solid rgba(6,182,212,0.25)", color: "#06b6d4", padding: "2px 7px", borderRadius: 4, fontSize: 9, fontFamily: "monospace" }}>
              {ws.loopCount || 20} iter
            </span>
          </>
        ) : ws.args.length > 0 && ws.args.map(a => (
          <span key={a} style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#94a3b8", padding: "2px 7px", borderRadius: 4, fontSize: 9, fontFamily: "monospace", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a}</span>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          onClick={() => openTerminalTab(ws)}
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
        {ws.agent === "claude" && ws.path && (
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

const API_BASE = window.__VELA_API_BASE__ || (window.location.port === "5173" ? "http://localhost:3001" : "");

function CreateModal({ onClose, onCreate, settings }) {
  const [name, setName] = useState("");
  const [project, setProject] = useState("");
  const [agent, setAgent] = useState("claude");
  const [selectedArgs, setSelectedArgs] = useState([]);
  const [step, setStep] = useState(1); // 1 = form, 2 = launching
  const [loopCount, setLoopCount] = useState(20);
  const [donePrompt, setDonePrompt] = useState("");
  const args = AGENT_ARGS[agent];

  // Project resolution state
  const [projectStatus, setProjectStatus] = useState(null);
  // null | 'checking' | 'local' | 'not-found' | 'searching-github' | 'github-found' | 'forking' | 'cloned' | 'fork-error'
  const [projectPath, setProjectPath] = useState(null);
  const [localMatches, setLocalMatches] = useState([]);
  const [searchRoots, setSearchRoots] = useState([]);
  const [githubResults, setGithubResults] = useState([]);
  const [forkError, setForkError] = useState("");

  // Debounced project resolution — driven by `project` field
  useEffect(() => {
    if (!project.trim()) {
      setProjectStatus(null);
      setProjectPath(null);
      setLocalMatches([]);
      setGithubResults([]);
      setForkError("");
      return;
    }

    setProjectStatus("checking");
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/resolve-project?name=${encodeURIComponent(project.trim())}`);
        const data = await res.json();

        if (data.found) {
          setProjectStatus("local");
          setProjectPath(data.path);
          setLocalMatches(data.allMatches || [data.path]);
        } else {
          setSearchRoots(data.searchRoots || []);
          setProjectStatus("searching-github");

          const ghRes = await fetch(`${API_BASE}/api/github-search?name=${encodeURIComponent(project.trim())}`);
          const ghData = await ghRes.json();

          if (ghData.results?.length > 0) {
            setProjectStatus("github-found");
            setGithubResults(ghData.results);
          } else {
            setProjectStatus("not-found");
            setGithubResults([]);
          }
        }
      } catch {
        setProjectStatus(null);
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [project]);

  async function handleForkClone(repoFullName) {
    setProjectStatus("forking");
    setForkError("");
    try {
      const res = await fetch(`${API_BASE}/api/fork-clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoFullName }),
      });
      const data = await res.json();

      if (data.success) {
        setProjectStatus("cloned");
        setProjectPath(data.path);
        setGithubResults([]);
      } else {
        setProjectStatus("fork-error");
        setForkError(data.error || "Fork/clone failed");
      }
    } catch {
      setProjectStatus("fork-error");
      setForkError("Network error");
    }
  }

  function toggleArg(id) {
    setSelectedArgs(prev => prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id]);
  }

  function handleAgentChange(a) {
    setAgent(a);
    setSelectedArgs([]);
    if (a !== "ralph") {
      setLoopCount(20);
      setDonePrompt("");
    }
  }

  function handleCreate() {
    if (!name.trim()) return;
    if (agent === "ralph" && (!loopCount || loopCount < 1)) return;
    setStep(2);
    setTimeout(() => {
      const argLabels = selectedArgs.map(id => args.find(a => a.id === id)?.label).filter(Boolean);
      const wsData = { name: name.trim(), agent, args: argLabels, path: projectPath || settings?.defaultCodebaseDir || "" };
      if (agent === "ralph") {
        wsData.loopCount = loopCount;
        wsData.donePrompt = donePrompt.trim();
      }
      onCreate(wsData);
      onClose();
    }, 1800);
  }

  const meta = AGENT_META[agent];

  function renderProjectStatus() {
    // Show default directory hint when project field is empty
    if (!projectStatus && !project.trim() && settings?.defaultCodebaseDir) {
      return (
        <div style={{ borderRadius: 8, padding: "10px 14px", marginTop: 10, fontSize: 13, fontFamily: "monospace", background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.15)", color: "#60a5fa" }}>
          {"\u2139"} Will use default directory: <span style={{ color: "#94a3b8" }}>{settings.defaultCodebaseDir}</span>
          <div style={{ fontSize: 10, color: "#475569", marginTop: 4 }}>Configure in Settings {"\u2699"}</div>
        </div>
      );
    }
    if (!projectStatus) return null;

    const statusBox = {
      borderRadius: 8,
      padding: "10px 14px",
      marginTop: 10,
      fontSize: 13,
      fontFamily: "monospace",
    };

    if (projectStatus === "checking" || projectStatus === "searching-github") {
      return (
        <div style={{ ...statusBox, background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)", color: "#60a5fa" }}>
          <span style={{ display: "inline-block", animation: "spin 1s linear infinite", marginRight: 8 }}>{"\u27F3"}</span>
          {projectStatus === "checking" ? "Checking local projects..." : "Not found locally. Searching GitHub..."}
        </div>
      );
    }

    if (projectStatus === "local") {
      if (localMatches.length <= 1) {
        return (
          <div style={{ ...statusBox, background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)", color: "#4ade80" }}>
            {"\u2713"} Found locally at <span style={{ color: "#94a3b8" }}>{projectPath}</span>
          </div>
        );
      }
      return (
        <div style={{ marginTop: 10 }}>
          <div style={{ ...statusBox, background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)", color: "#4ade80", marginTop: 0 }}>
            {"\u2713"} Found {localMatches.length} matches. Select one:
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8, maxHeight: 150, overflowY: "auto" }}>
            {localMatches.map(p => (
              <button
                key={p}
                onClick={() => { setProjectPath(p); setLocalMatches([p]); }}
                style={{
                  display: "flex", alignItems: "center",
                  background: p === projectPath ? "rgba(34,197,94,0.1)" : "rgba(255,255,255,0.025)",
                  border: `1px solid ${p === projectPath ? "rgba(34,197,94,0.3)" : "rgba(255,255,255,0.06)"}`,
                  borderRadius: 6, padding: "8px 12px", cursor: "pointer",
                  fontFamily: "monospace", fontSize: 11, color: p === projectPath ? "#4ade80" : "#94a3b8",
                  textAlign: "left", transition: "all 0.15s",
                }}
              >
                {p === projectPath && <span style={{ marginRight: 6 }}>{"\u2713"}</span>}
                {p}
              </button>
            ))}
          </div>
        </div>
      );
    }

    if (projectStatus === "cloned") {
      return (
        <div style={{ ...statusBox, background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)", color: "#4ade80" }}>
          {"\u2713"} Cloned to <span style={{ color: "#94a3b8" }}>{projectPath}</span>
        </div>
      );
    }

    if (projectStatus === "forking") {
      return (
        <div style={{ ...statusBox, background: "rgba(249,115,22,0.08)", border: "1px solid rgba(249,115,22,0.2)", color: "#fb923c" }}>
          <span style={{ display: "inline-block", animation: "spin 1s linear infinite", marginRight: 8 }}>{"\u27F3"}</span>
          Forking & cloning...
        </div>
      );
    }

    if (projectStatus === "fork-error") {
      return (
        <div style={{ ...statusBox, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }}>
          {"\u2715"} {forkError}
        </div>
      );
    }

    if (projectStatus === "not-found") {
      return (
        <div style={{ ...statusBox, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", color: "#fbbf24" }}>
          <div>Not found locally or on GitHub.</div>
          {settings?.defaultCodebaseDir ? (
            <button
              onClick={() => { setProjectPath(settings.defaultCodebaseDir); setProjectStatus("local"); setLocalMatches([settings.defaultCodebaseDir]); }}
              style={{
                background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.25)",
                color: "#60a5fa", padding: "5px 12px", borderRadius: 6, marginTop: 8,
                fontFamily: "monospace", fontSize: 11, fontWeight: 600, cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              Use default: {settings.defaultCodebaseDir}
            </button>
          ) : (
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>Will launch in home directory.</div>
          )}
        </div>
      );
    }

    if (projectStatus === "github-found") {
      return (
        <div style={{ marginTop: 10 }}>
          <div style={{ ...statusBox, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", color: "#fbbf24", marginTop: 0 }}>
            Not found locally. Found on GitHub:
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8, maxHeight: 180, overflowY: "auto" }}>
            {githubResults.map(repo => (
              <div key={repo.fullName} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: 6, padding: "8px 12px",
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: "#94a3b8", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {repo.fullName}
                  </div>
                  {repo.description && (
                    <div style={{ fontSize: 10, color: "#475569", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {repo.description}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleForkClone(repo.fullName)}
                  style={{
                    background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.25)",
                    color: "#4ade80", padding: "4px 10px", borderRadius: 5,
                    fontFamily: "monospace", fontSize: 10, fontWeight: 600,
                    cursor: "pointer", whiteSpace: "nowrap", marginLeft: 10,
                    transition: "all 0.15s",
                  }}
                >
                  Fork & Clone
                </button>
              </div>
            ))}
          </div>
        </div>
      );
    }

    return null;
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
              Spawning terminal for <span style={{ color: meta.color }}>{name}</span>
              {projectPath && <> in <span style={{ color: "#94a3b8" }}>{projectPath}</span></>}...
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

              {/* Project Directory */}
              <div style={{ marginBottom: 18 }}>
                <label style={labelStyle}>PROJECT <span style={{ color: "#334155", fontWeight: 400 }}>(optional {"\u2014"} leave empty for default directory)</span></label>
                <input
                  value={project}
                  onChange={e => setProject(e.target.value)}
                  placeholder="e.g. my-app, JIRA-1234, owner/repo"
                  style={{
                    width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 8, padding: "10px 14px", color: "#f1f5f9", fontFamily: "monospace",
                    fontSize: 14, outline: "none", boxSizing: "border-box",
                    transition: "border-color 0.15s",
                  }}
                />
                {renderProjectStatus()}
              </div>

              {/* Agent */}
              <div style={{ marginBottom: 20 }}>
                <label style={labelStyle}>AGENT TYPE</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                  {["claude", "codex", "ralph"].map(a => {
                    const m = AGENT_META[a];
                    const active = agent === a;
                    const desc = a === "claude" ? "Anthropic CLI" : a === "codex" ? "OpenAI CLI" : "Autonomous Loop";
                    return (
                      <button
                        key={a}
                        onClick={() => handleAgentChange(a)}
                        style={{
                          display: "flex", alignItems: "center", gap: 12,
                          background: active ? m.color + "18" : "rgba(255,255,255,0.03)",
                          border: `1px solid ${active ? m.color + "55" : "rgba(255,255,255,0.08)"}`,
                          borderRadius: 8, padding: "12px 16px", cursor: "pointer",
                          transition: "all 0.15s", textAlign: "left",
                        }}
                      >
                        <span style={{ fontSize: 20, color: m.color }}>{m.icon}</span>
                        <div>
                          <div style={{ fontFamily: "monospace", fontWeight: 700, color: active ? m.color : "#94a3b8", fontSize: 14 }}>{m.brand}</div>
                          <div style={{ fontSize: 11, color: "#475569", fontFamily: "monospace" }}>
                            {desc}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Ralph Loop config or Arguments */}
              {agent === "ralph" ? (
                <div style={{ marginBottom: 22 }}>
                  <div style={{ marginBottom: 16 }}>
                    <label style={labelStyle}>LOOP COUNT</label>
                    <input
                      type="number"
                      min="1"
                      max="200"
                      value={loopCount}
                      onChange={e => setLoopCount(Math.max(1, parseInt(e.target.value) || 1))}
                      style={{
                        width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: 8, padding: "10px 14px", color: "#f1f5f9", fontFamily: "monospace",
                        fontSize: 14, outline: "none", boxSizing: "border-box",
                        transition: "border-color 0.15s",
                      }}
                    />
                    <div style={{ fontSize: 10, color: "#475569", fontFamily: "monospace", marginTop: 4 }}>
                      Max iterations before stopping (each gets a fresh context window)
                    </div>
                  </div>
                  <div>
                    <label style={labelStyle}>DONE PROMPT <span style={{ color: "#334155", fontWeight: 400 }}>(optional)</span></label>
                    <textarea
                      value={donePrompt}
                      onChange={e => setDonePrompt(e.target.value)}
                      placeholder={"e.g. Build a REST API for todos.\n\nWhen complete:\n- All CRUD endpoints working\n- Tests passing\n\nOutput: <promise>COMPLETE</promise>"}
                      rows={5}
                      style={{
                        width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: 8, padding: "10px 14px", color: "#f1f5f9", fontFamily: "monospace",
                        fontSize: 13, outline: "none", boxSizing: "border-box", resize: "vertical",
                        transition: "border-color 0.15s", lineHeight: 1.5,
                      }}
                    />
                    <div style={{ fontSize: 10, color: "#475569", fontFamily: "monospace", marginTop: 4 }}>
                      Written to PROMPT.md in the project directory. Leave empty to use existing PROMPT.md.
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ marginBottom: 22 }}>
                  <label style={labelStyle}>ARGUMENTS <span style={{ color: "#334155", fontWeight: 400 }}>(optional)</span></label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    {args.map(arg => {
                      const active = selectedArgs.includes(arg.id);
                      return (
                        <button
                          key={arg.id}
                          onClick={() => toggleArg(arg.id)}
                          style={{
                            display: "flex", alignItems: "center", gap: 10,
                            background: active ? meta.color + "10" : "rgba(255,255,255,0.02)",
                            border: `1px solid ${active ? meta.color + "40" : "rgba(255,255,255,0.06)"}`,
                            borderRadius: 7, padding: "8px 12px", cursor: "pointer",
                            transition: "all 0.15s", textAlign: "left",
                          }}
                        >
                          <span style={{
                            width: 16, height: 16, borderRadius: 4, border: `1.5px solid ${active ? meta.color : "#334155"}`,
                            background: active ? meta.color : "transparent", display: "flex", alignItems: "center", justifyContent: "center",
                            flexShrink: 0, fontSize: 10, color: "#fff", transition: "all 0.15s",
                          }}>
                            {active ? "\u2713" : ""}
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontFamily: "monospace", fontSize: 12, color: active ? meta.color : "#94a3b8", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{arg.label}</div>
                            <div style={{ fontSize: 10, color: "#475569", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{arg.desc}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Command preview */}
              {name && (
                <div style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: "10px 14px", marginBottom: 18 }}>
                  <div style={{ fontSize: 11, color: "#475569", fontFamily: "monospace", marginBottom: 5, letterSpacing: 1 }}>COMMAND PREVIEW</div>
                  <div style={{ fontFamily: "monospace", fontSize: 13, color: "#4ade80", wordBreak: "break-all" }}>
                    {(projectPath || settings?.defaultCodebaseDir) && <><span style={{ color: "#64748b" }}>cd {projectPath || settings.defaultCodebaseDir} &&</span>{" "}</>}
                    {agent === "ralph" ? (
                      <>$ ~/.claude/bin/ralph.sh {loopCount}{donePrompt ? " PROMPT.md" : ""}</>
                    ) : (
                      <>$ {agent} {selectedArgs.map(id => args.find(a => a.id === id)?.label).filter(Boolean).join(" ")}</>
                    )}
                  </div>
                </div>
              )}

              <button
                onClick={handleCreate}
                disabled={!name.trim() || projectStatus === "forking"}
                style={{
                  width: "100%", padding: "14px", borderRadius: 10,
                  background: name.trim() && projectStatus !== "forking" ? meta.color : "rgba(255,255,255,0.05)",
                  border: "none", color: name.trim() ? "#fff" : "#334155",
                  fontFamily: "monospace", fontWeight: 700, fontSize: 15,
                  cursor: name.trim() && projectStatus !== "forking" ? "pointer" : "not-allowed",
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

function SettingsModal({ settings, onClose, onSave }) {
  const [defaultDir, setDefaultDir] = useState(settings?.defaultCodebaseDir || "");
  const [roots, setRoots] = useState(settings?.searchRoots || []);
  const [cloneDir, setCloneDir] = useState(settings?.cloneDir || "");
  const [newRoot, setNewRoot] = useState("");
  const [saving, setSaving] = useState(false);
  const [themeId, setThemeId] = useState(settings?.theme?.id || "ember");
  const [customColor, setCustomColor] = useState(settings?.theme?.accent || "#f97316");
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchRoots: updated.searchRoots, cloneDir: updated.cloneDir }),
      });
    } catch {}
    onSave(updated);
    setSaving(false);
    onClose();
  }

  async function handleReset() {
    try {
      const res = await fetch(`${API_BASE}/api/config`);
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
      const res = await fetch(url);
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
        headers: { "Content-Type": "application/json" },
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
          headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid: session.pid }),
      });
    } catch {}

    // 2. Kill current Vela session so new one can use --resume
    if (workspace) {
      try {
        await fetch(`${API_BASE}/api/kill-session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
        agent: "claude",
        args: ["--dangerously-skip-permissions", "--resume"],
        path: session.cwd,
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
          <div style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace", letterSpacing: 1, fontWeight: 700, marginBottom: 10 }}>
            EXTERNAL SESSIONS {!loading && `(${externalSessions.length})`}
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

function loadWorkspaces() {
  try {
    const saved = localStorage.getItem("vela-workspaces");
    if (saved) return JSON.parse(saved);
  } catch {}
  return [];
}

function saveWorkspaces(workspaces) {
  try {
    localStorage.setItem("vela-workspaces", JSON.stringify(workspaces));
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
  const [workspaces, setWorkspaces] = useState(loadWorkspaces);
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);

  // Persist whenever workspaces change
  useEffect(() => {
    saveWorkspaces(workspaces);
  }, [workspaces]);

  // Seed settings from server on first load
  useEffect(() => {
    if (settings !== null) {
      // Push existing settings to server on load
      fetch(`${API_BASE}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchRoots: settings.searchRoots, cloneDir: settings.cloneDir }),
      }).catch(() => {});
      return;
    }
    fetch(`${API_BASE}/api/config`)
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
    setWorkspaces(prev => prev.map(w => w.id === id ? { ...w, status: "stopped" } : w));
  }

  function handleResume(id) {
    setWorkspaces(prev => prev.map(w => w.id === id ? { ...w, status: "running" } : w));
  }

  function handleDelete(id) {
    setWorkspaces(prev => prev.filter(w => w.id !== id));
  }

  function handleTakeOver(ws, externalSession) {
    // Update workspace to use --resume and mark as running
    const updatedArgs = ["--dangerously-skip-permissions", "--resume"];
    setWorkspaces(prev => prev.map(w =>
      w.id === ws.id ? { ...w, args: updatedArgs, status: "running" } : w
    ));
    // Open terminal tab with --resume (old session was killed by the modal)
    openTerminalTab({ ...ws, args: updatedArgs });
  }

  const tc = getThemeColors(settings?.theme);

  const filtered = workspaces.filter(w => filter === "all" || w.status === filter || w.agent === filter);

  const counts = {
    running: workspaces.filter(w => w.status === "running").length,
    idle: workspaces.filter(w => w.status === "idle").length,
    stopped: workspaces.filter(w => w.status === "stopped").length,
  };

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
