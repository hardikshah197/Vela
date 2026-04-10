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

	// Auth middleware — enforce token for non-exempt endpoints
	if !isAuthExempt(path) && isAuthRequired() {
		if !validateAuthToken(extractToken(r)) {
			sendJSON(w, map[string]string{"error": "unauthorized"}, 401)
			return
		}
	}

	switch {
	// --- Auth endpoints ---
	case path == "/api/auth/status" && method == "GET":
		handleAuthStatus(w, r)
	case path == "/api/auth/setup" && method == "POST":
		handleAuthSetup(w, r)
	case path == "/api/auth/verify-pin" && method == "POST":
		handleVerifyPin(w, r)
	case path == "/api/auth/update" && method == "POST":
		handleAuthUpdate(w, r)
	case path == "/api/auth/logout" && method == "POST":
		handleAuthLogout(w, r)
	case path == "/api/auth/webauthn/register-options" && method == "GET":
		handleWebAuthnRegisterOptions(w, r)
	case path == "/api/auth/webauthn/register" && method == "POST":
		handleWebAuthnRegister(w, r)
	case path == "/api/auth/webauthn/login-options" && method == "GET":
		handleWebAuthnLoginOptions(w, r)
	case path == "/api/auth/webauthn/login" && method == "POST":
		handleWebAuthnLogin(w, r)

	// --- Existing endpoints ---
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
	case path == "/api/sessions" && method == "GET":
		handleListSessions(w, r)
	case path == "/api/kill-session" && method == "POST":
		handleKillSession(w, r)
	case path == "/api/worktree/create" && method == "POST":
		handleWorktreeCreate(w, r)
	case path == "/api/worktree/remove" && method == "POST":
		handleWorktreeRemove(w, r)
	case path == "/api/upload" && method == "POST":
		handleUpload(w, r)
	case path == "/api/file-preview" && method == "GET":
		handleFilePreview(w, r)
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
// Tiered search: personal repos → org repos → global
func handleGitHubSearch(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		sendJSON(w, map[string]string{"error": "name required"}, 400)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	type repoResult struct {
		FullName    string `json:"fullName"`
		Description string `json:"description"`
		Source      string `json:"source"` // "personal", "org:<name>", "global"
	}

	// 1. Get authenticated user's login
	userOut, _ := exec.CommandContext(ctx, "gh", "api", "/user", "--jq", ".login").Output()
	username := strings.TrimSpace(string(userOut))
	if username == "" {
		username = "hardikshah197"
	}

	// 2. Get user's orgs
	orgsOut, _ := exec.CommandContext(ctx, "gh", "api", "/user/orgs", "--jq", ".[].login").Output()
	var orgs []string
	for _, o := range strings.Split(strings.TrimSpace(string(orgsOut)), "\n") {
		o = strings.TrimSpace(o)
		if o != "" {
			orgs = append(orgs, o)
		}
	}

	// 3. Search in parallel: personal + each org + global
	type searchResult struct {
		repos  []repoResult
		source string
	}

	numSearches := 1 + len(orgs) + 1 // personal + orgs + global
	ch := make(chan searchResult, numSearches)

	// Helper to run a gh search
	ghSearch := func(owner, source string, limit int) {
		args := []string{"search", "repos", name, "--json", "fullName,description", "--limit", strconv.Itoa(limit)}
		if owner != "" {
			args = append(args, "--owner", owner)
		}
		cmd := exec.CommandContext(ctx, "gh", args...)
		cmd.Env = shellEnv
		out, err := cmd.Output()
		if err != nil {
			ch <- searchResult{source: source}
			return
		}
		var parsed []struct {
			FullName    string `json:"fullName"`
			Description string `json:"description"`
		}
		json.Unmarshal(out, &parsed)
		repos := make([]repoResult, len(parsed))
		for i, p := range parsed {
			repos[i] = repoResult{FullName: p.FullName, Description: p.Description, Source: source}
		}
		ch <- searchResult{repos: repos, source: source}
	}

	// Personal
	go ghSearch(username, "personal", 5)
	// Orgs
	for _, org := range orgs {
		go ghSearch(org, "org:"+org, 5)
	}
	// Global
	go ghSearch("", "global", 8)

	// 4. Collect results in order: personal → orgs → global
	resultMap := map[string][]repoResult{}
	for i := 0; i < numSearches; i++ {
		sr := <-ch
		resultMap[sr.source] = sr.repos
	}

	seen := map[string]bool{}
	var results []repoResult

	// Personal first
	for _, r := range resultMap["personal"] {
		if !seen[r.FullName] {
			seen[r.FullName] = true
			results = append(results, r)
		}
	}
	// Then orgs
	for _, org := range orgs {
		for _, r := range resultMap["org:"+org] {
			if !seen[r.FullName] {
				seen[r.FullName] = true
				results = append(results, r)
			}
		}
	}
	// Then global
	for _, r := range resultMap["global"] {
		if !seen[r.FullName] {
			seen[r.FullName] = true
			results = append(results, r)
		}
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

	// Kill the entire process group to ensure child processes are also terminated
	// Try SIGTERM first, then SIGKILL after a brief delay
	syscall.Kill(-req.Pid, syscall.SIGTERM)
	syscall.Kill(req.Pid, syscall.SIGTERM)
	go func() {
		time.Sleep(2 * time.Second)
		syscall.Kill(-req.Pid, syscall.SIGKILL)
		syscall.Kill(req.Pid, syscall.SIGKILL)
	}()

	log.Printf("[Vela] Killed external process group: %d", req.Pid)
	sendJSON(w, map[string]any{"success": true}, 200)
}

// GET /api/sessions — list active backend sessions for frontend reconciliation
func handleListSessions(w http.ResponseWriter, r *http.Request) {
	type sessionInfo struct {
		ID    string `json:"id"`
		Agent string `json:"agent"`
		Cwd   string `json:"cwd"`
		Alive bool   `json:"alive"`
	}

	var results []sessionInfo
	sessions.Range(func(key, value any) bool {
		s := value.(*Session)
		s.mu.Lock()
		alive := !s.dead && s.cmd != nil
		results = append(results, sessionInfo{
			ID:    key.(string),
			Agent: s.agent,
			Cwd:   s.cwd,
			Alive: alive,
		})
		s.mu.Unlock()
		return true
	})

	if results == nil {
		results = []sessionInfo{}
	}
	sendJSON(w, map[string]any{"sessions": results}, 200)
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
		// Kill the entire process group, not just the direct process
		syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
	}
	if s.ptyFile != nil {
		s.ptyFile.Close()
	}
	if s.ws != nil {
		s.ws.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(4000, "killed"))
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

// GET /api/file-preview?path=...
func handleFilePreview(w http.ResponseWriter, r *http.Request) {
	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		http.Error(w, "path required", 400)
		return
	}

	absPath, err := filepath.Abs(filePath)
	if err != nil {
		http.Error(w, "invalid path", 400)
		return
	}

	// Security: only serve from screenshot dir or upload dir
	uploadDir := filepath.Join(os.TempDir(), "vela-uploads")
	allowed := false
	for _, dir := range []string{screenshotDir, uploadDir} {
		absDir, _ := filepath.Abs(dir)
		if strings.HasPrefix(absPath, absDir+"/") {
			allowed = true
			break
		}
	}
	if !allowed {
		http.Error(w, "forbidden", 403)
		return
	}

	data, err := os.ReadFile(absPath)
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}

	ext := strings.ToLower(filepath.Ext(absPath))
	contentType := "application/octet-stream"
	switch ext {
	case ".png":
		contentType = "image/png"
	case ".jpg", ".jpeg":
		contentType = "image/jpeg"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Write(data)
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
