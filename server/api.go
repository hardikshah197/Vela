package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

func handleAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method == "OPTIONS" {
		sendJSON(w, map[string]any{}, 200)
		return
	}

	path := r.URL.Path
	method := r.Method

	switch {
	case path == "/api/config" && method == "GET":
		handleGetConfig(w, r)
	case path == "/api/config" && method == "POST":
		handlePostConfig(w, r)
	case path == "/api/resolve-project" && method == "GET":
		handleResolveProject(w, r)
	case path == "/api/github-search" && method == "GET":
		handleGitHubSearch(w, r)
	case path == "/api/fork-clone" && method == "POST":
		handleForkClone(w, r)
	case path == "/api/detect-claude-sessions" && method == "GET":
		handleDetectSessions(w, r)
	case path == "/api/kill-process" && method == "POST":
		handleKillProcess(w, r)
	case path == "/api/kill-session" && method == "POST":
		handleKillSession(w, r)
	case path == "/api/upload" && method == "POST":
		handleUpload(w, r)
	default:
		sendJSON(w, map[string]string{"error": "Not found"}, 404)
	}
}

// GET /api/config
func handleGetConfig(w http.ResponseWriter, r *http.Request) {
	cfgMu.RLock()
	defer cfgMu.RUnlock()

	defaultDir := ""
	if len(searchRoots) > 0 {
		defaultDir = searchRoots[0]
	}

	sendJSON(w, map[string]any{
		"searchRoots":       searchRoots,
		"cloneDir":          cloneDir,
		"defaultCodebaseDir": defaultDir,
	}, 200)
}

// POST /api/config
func handlePostConfig(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		sendJSON(w, map[string]string{"error": "Failed to read body"}, 400)
		return
	}

	var req struct {
		SearchRoots []string `json:"searchRoots"`
		CloneDir    string   `json:"cloneDir"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		sendJSON(w, map[string]string{"error": "Invalid JSON body"}, 400)
		return
	}

	cfgMu.Lock()
	if len(req.SearchRoots) > 0 {
		searchRoots = req.SearchRoots
	}
	if req.CloneDir != "" {
		cloneDir = req.CloneDir
		os.MkdirAll(cloneDir, 0755)
	}
	log.Printf("[Vela] Config updated: roots=%s, cloneDir=%s", strings.Join(searchRoots, ","), cloneDir)
	result := map[string]any{
		"success":     true,
		"searchRoots": searchRoots,
		"cloneDir":    cloneDir,
	}
	cfgMu.Unlock()

	sendJSON(w, result, 200)
}

// GET /api/resolve-project?name=...
func handleResolveProject(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		sendJSON(w, map[string]string{"error": "name required"}, 400)
		return
	}

	cfgMu.RLock()
	roots := make([]string, len(searchRoots))
	copy(roots, searchRoots)
	cfgMu.RUnlock()

	// Build find commands for each root
	parts := make([]string, len(roots))
	for i, root := range roots {
		parts[i] = fmt.Sprintf(`find "%s" -maxdepth 5 -type d -iname "%s" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null`, root, name)
	}
	findCmd := strings.Join(parts, " ; ")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, "sh", "-c", findCmd).Output()

	matches := []string{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line != "" {
			matches = append(matches, line)
		}
	}

	if len(matches) > 0 {
		sort.Slice(matches, func(i, j int) bool { return len(matches[i]) < len(matches[j]) })
		top := matches
		if len(top) > 10 {
			top = top[:10]
		}
		sendJSON(w, map[string]any{
			"found":      true,
			"source":     "local",
			"path":       matches[0],
			"allMatches": top,
		}, 200)
	} else {
		sendJSON(w, map[string]any{
			"found":       false,
			"source":      nil,
			"searchRoots": roots,
		}, 200)
	}
}

// GET /api/github-search?name=...
func handleGitHubSearch(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		sendJSON(w, map[string]string{"error": "name required"}, 400)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", "search", "repos", name, "--json", "fullName,url,description", "--limit", "8")
	cmd.Env = shellEnv
	out, err := cmd.Output()
	if err != nil {
		sendJSON(w, map[string]any{"results": []any{}, "error": "gh CLI not available or not authenticated"}, 200)
		return
	}

	var results []any
	if err := json.Unmarshal(out, &results); err != nil {
		sendJSON(w, map[string]any{"results": []any{}}, 200)
		return
	}

	sendJSON(w, map[string]any{"results": results}, 200)
}

// POST /api/fork-clone
func handleForkClone(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		sendJSON(w, map[string]string{"error": "Failed to read body"}, 400)
		return
	}

	var req struct {
		RepoFullName string `json:"repoFullName"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.RepoFullName == "" {
		sendJSON(w, map[string]string{"error": "repoFullName required"}, 400)
		return
	}

	parts := strings.Split(req.RepoFullName, "/")
	repoName := parts[len(parts)-1]

	cfgMu.RLock()
	cd := cloneDir
	cfgMu.RUnlock()

	clonePath := filepath.Join(cd, repoName)
	log.Printf("[Vela] Fork+clone: %s → %s", req.RepoFullName, clonePath)

	// Try fork+clone first
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", "repo", "fork", req.RepoFullName, "--clone", "--default-branch-only")
	cmd.Dir = cd
	cmd.Env = shellEnv
	err = cmd.Run()

	if err == nil || fileExists(clonePath) {
		sendJSON(w, map[string]any{"success": true, "path": clonePath, "action": "forked_and_cloned"}, 200)
		return
	}

	// Fallback: plain clone
	ctx2, cancel2 := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel2()
	cmd2 := exec.CommandContext(ctx2, "gh", "repo", "clone", req.RepoFullName, clonePath)
	cmd2.Env = shellEnv
	out, err := cmd2.CombinedOutput()
	if err != nil {
		sendJSON(w, map[string]any{"success": false, "error": strings.TrimSpace(string(out))}, 200)
		return
	}

	sendJSON(w, map[string]any{"success": true, "path": clonePath, "action": "cloned"}, 200)
}

var claudeProcessRe = regexp.MustCompile(`(?:^|/)claude\s|(?:^|/)claude$`)

// GET /api/detect-claude-sessions?cwd=...
func handleDetectSessions(w http.ResponseWriter, r *http.Request) {
	filterCwd := r.URL.Query().Get("cwd")

	// Collect managed PIDs
	managedPids := map[int]bool{}
	sessions.Range(func(key, value any) bool {
		s := value.(*Session)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.cmd != nil && s.cmd.Process != nil && !s.dead {
			managedPids[s.cmd.Process.Pid] = true
		}
		return true
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-eo", "pid,command").Output()
	if err != nil {
		sendJSON(w, map[string]any{"sessions": []any{}}, 200)
		return
	}

	type detected struct {
		Pid     int    `json:"pid"`
		Command string `json:"command"`
	}

	myPid := os.Getpid()
	var found []detected

	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Parse "  PID COMMAND"
		spaceIdx := strings.IndexFunc(line, func(r rune) bool { return r == ' ' || r == '\t' })
		if spaceIdx < 0 {
			continue
		}
		pidStr := strings.TrimSpace(line[:spaceIdx])
		cmd := strings.TrimSpace(line[spaceIdx:])

		pid, err := strconv.Atoi(pidStr)
		if err != nil {
			continue
		}

		// Must be a claude CLI invocation
		if !claudeProcessRe.MatchString(cmd) {
			continue
		}
		// Skip shell wrappers and utilities
		if strings.HasPrefix(cmd, "/bin/") || strings.Contains(cmd, "server.js") ||
			strings.Contains(cmd, "grep") || strings.Contains(cmd, "lsof") ||
			strings.Contains(cmd, "vela-server") {
			continue
		}
		if managedPids[pid] || pid == myPid {
			continue
		}

		if len(cmd) > 120 {
			cmd = cmd[:120] + "..."
		}
		found = append(found, detected{Pid: pid, Command: cmd})
	}

	if len(found) == 0 {
		sendJSON(w, map[string]any{"sessions": []any{}}, 200)
		return
	}

	// Get working directories via lsof
	pids := make([]string, len(found))
	for i, d := range found {
		pids[i] = strconv.Itoa(d.Pid)
	}

	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	lsofOut, _ := exec.CommandContext(ctx2, "lsof", "-a", "-d", "cwd", "-Fn", "-p", strings.Join(pids, ",")).Output()

	cwdMap := map[int]string{}
	currentPid := 0
	for _, line := range strings.Split(string(lsofOut), "\n") {
		if strings.HasPrefix(line, "p") {
			p, _ := strconv.Atoi(line[1:])
			currentPid = p
		} else if strings.HasPrefix(line, "n") && currentPid > 0 {
			cwdMap[currentPid] = line[1:]
		}
	}

	type sessionResult struct {
		Pid         int    `json:"pid"`
		Command     string `json:"command"`
		Cwd         string `json:"cwd"`
		ProjectName string `json:"projectName"`
	}

	var results []sessionResult
	for _, d := range found {
		cwd, ok := cwdMap[d.Pid]
		if !ok {
			continue
		}
		if filterCwd != "" && cwd != filterCwd {
			continue
		}
		projName := filepath.Base(cwd)
		if projName == "" {
			projName = "unknown"
		}
		results = append(results, sessionResult{
			Pid:         d.Pid,
			Command:     d.Command,
			Cwd:         cwd,
			ProjectName: projName,
		})
	}

	if results == nil {
		results = []sessionResult{}
	}
	sendJSON(w, map[string]any{"sessions": results}, 200)
}

// POST /api/kill-process
func handleKillProcess(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		sendJSON(w, map[string]string{"error": "Failed to read body"}, 400)
		return
	}

	var req struct {
		Pid int `json:"pid"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.Pid == 0 {
		sendJSON(w, map[string]string{"error": "valid pid required"}, 400)
		return
	}

	// Safety check: verify it's a claude process
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-p", strconv.Itoa(req.Pid), "-o", "command=").Output()
	if err != nil || !strings.Contains(string(out), "claude") {
		sendJSON(w, map[string]string{"error": "Process not found or not a Claude session"}, 404)
		return
	}

	if err := syscall.Kill(req.Pid, syscall.SIGTERM); err != nil {
		sendJSON(w, map[string]any{"success": false, "error": err.Error()}, 500)
		return
	}

	log.Printf("[Vela] Killed external process: %d", req.Pid)
	sendJSON(w, map[string]any{"success": true}, 200)
}

// POST /api/kill-session
func handleKillSession(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		sendJSON(w, map[string]string{"error": "Failed to read body"}, 400)
		return
	}

	var req struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.SessionID == "" {
		sendJSON(w, map[string]string{"error": "sessionId required"}, 400)
		return
	}

	val, ok := sessions.Load(req.SessionID)
	if !ok {
		sendJSON(w, map[string]string{"error": "Session not found"}, 404)
		return
	}

	s := val.(*Session)
	log.Printf("[Vela] Killing Vela session via API: %s", req.SessionID)

	s.mu.Lock()
	s.dead = true
	if s.orphanTimer != nil {
		s.orphanTimer.Stop()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Kill()
	}
	if s.ptyFile != nil {
		s.ptyFile.Close()
	}
	if s.ws != nil {
		s.ws.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(4000, "killed"), )
		s.ws.Close()
	}
	s.mu.Unlock()

	sessions.Delete(req.SessionID)
	sendJSON(w, map[string]any{"success": true}, 200)
}

// POST /api/upload
func handleUpload(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		sendJSON(w, map[string]string{"error": "Failed to read body"}, 400)
		return
	}

	var req struct {
		SessionID string `json:"sessionId"`
		FileName  string `json:"fileName"`
		Data      string `json:"data"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.Data == "" {
		sendJSON(w, map[string]string{"error": "data required"}, 400)
		return
	}

	sid := req.SessionID
	if sid == "" {
		sid = "unknown"
	}

	uploadDir := filepath.Join(os.TempDir(), "vela-uploads", sid)
	os.MkdirAll(uploadDir, 0755)

	// Sanitize filename
	safeName := req.FileName
	if safeName == "" {
		safeName = "image.png"
	}
	safeName = sanitizeFilename(safeName)
	ts := time.Now().UnixMilli()
	filePath := filepath.Join(uploadDir, fmt.Sprintf("%d-%s", ts, safeName))

	decoded, err := base64.StdEncoding.DecodeString(req.Data)
	if err != nil {
		sendJSON(w, map[string]any{"error": "Invalid base64 data"}, 400)
		return
	}

	if err := os.WriteFile(filePath, decoded, 0644); err != nil {
		sendJSON(w, map[string]any{"error": err.Error()}, 500)
		return
	}

	log.Printf("[Vela] Upload: %s (%d bytes)", filePath, len(decoded))
	sendJSON(w, map[string]any{"success": true, "path": filePath}, 200)
}

func sanitizeFilename(name string) string {
	var b strings.Builder
	for _, c := range name {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
			c == '.' || c == '-' || c == '_' {
			b.WriteRune(c)
		} else {
			b.WriteRune('_')
		}
	}
	return b.String()
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
