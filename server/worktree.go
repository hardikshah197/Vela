package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var branchSanitizeRe = regexp.MustCompile(`[^a-z0-9]+`)

func sanitizeBranchName(name string) string {
	safe := branchSanitizeRe.ReplaceAllString(strings.ToLower(name), "-")
	safe = strings.Trim(safe, "-")
	if safe == "" {
		safe = "workspace"
	}
	return "vela/" + safe
}

// POST /api/worktree/create
func handleWorktreeCreate(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		sendJSON(w, map[string]string{"error": "Failed to read body"}, 400)
		return
	}

	var req struct {
		RepoPath    string `json:"repoPath"`
		WorkspaceID string `json:"workspaceId"`
		BranchName  string `json:"branchName"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.RepoPath == "" || req.WorkspaceID == "" {
		sendJSON(w, map[string]string{"error": "repoPath and workspaceId required"}, 400)
		return
	}

	// Validate it's a git repo
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "git", "-C", req.RepoPath, "rev-parse", "--git-dir").CombinedOutput(); err != nil {
		sendJSON(w, map[string]any{"success": false, "error": fmt.Sprintf("Not a git repository: %s", strings.TrimSpace(string(out)))}, 400)
		return
	}

	// Compute paths
	worktreePath := filepath.Join(worktreeBaseDir, req.WorkspaceID)

	// If worktree already exists (reconnect), return it
	if info, err := os.Stat(worktreePath); err == nil && info.IsDir() {
		log.Printf("[Vela] Worktree already exists: %s", worktreePath)
		sendJSON(w, map[string]any{"success": true, "worktreePath": worktreePath, "branchName": req.BranchName}, 200)
		return
	}

	// Sanitize branch name
	branch := sanitizeBranchName(req.BranchName)

	// Check if branch already exists — if so, append workspace ID suffix
	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	if err := exec.CommandContext(ctx2, "git", "-C", req.RepoPath, "show-ref", "--verify", "refs/heads/"+branch).Run(); err == nil {
		// Branch exists, make unique
		suffix := req.WorkspaceID
		if len(suffix) > 4 {
			suffix = suffix[:4]
		}
		branch = branch + "-" + strings.ToLower(suffix)
	}

	// Create worktree
	ctx3, cancel3 := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel3()
	cmd := exec.CommandContext(ctx3, "git", "-C", req.RepoPath, "worktree", "add", worktreePath, "-b", branch)
	cmd.Env = shellEnv
	out, err := cmd.CombinedOutput()
	if err != nil {
		errMsg := strings.TrimSpace(string(out))
		log.Printf("[Vela] Failed to create worktree: %s", errMsg)
		sendJSON(w, map[string]any{"success": false, "error": errMsg}, 500)
		return
	}

	log.Printf("[Vela] Created worktree: %s (branch: %s)", worktreePath, branch)
	sendJSON(w, map[string]any{"success": true, "worktreePath": worktreePath, "branchName": branch}, 200)
}

// POST /api/worktree/remove
func handleWorktreeRemove(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		sendJSON(w, map[string]string{"error": "Failed to read body"}, 400)
		return
	}

	var req struct {
		WorktreePath string `json:"worktreePath"`
		RepoPath     string `json:"repoPath"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.WorktreePath == "" {
		sendJSON(w, map[string]string{"error": "worktreePath required"}, 400)
		return
	}

	// Security: verify path is under worktreeBaseDir
	absPath, _ := filepath.Abs(req.WorktreePath)
	absBase, _ := filepath.Abs(worktreeBaseDir)
	if !strings.HasPrefix(absPath, absBase+"/") {
		sendJSON(w, map[string]string{"error": "Invalid worktree path"}, 403)
		return
	}

	// Try git worktree remove first
	if req.RepoPath != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "git", "-C", req.RepoPath, "worktree", "remove", req.WorktreePath, "--force")
		cmd.Env = shellEnv
		if err := cmd.Run(); err == nil {
			log.Printf("[Vela] Removed worktree via git: %s", req.WorktreePath)
			sendJSON(w, map[string]any{"success": true}, 200)
			return
		}
	}

	// Fallback: remove directory
	if err := os.RemoveAll(req.WorktreePath); err != nil {
		log.Printf("[Vela] Failed to remove worktree dir: %v", err)
		sendJSON(w, map[string]any{"success": false, "error": err.Error()}, 500)
		return
	}

	// Also prune worktree references
	if req.RepoPath != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		exec.CommandContext(ctx, "git", "-C", req.RepoPath, "worktree", "prune").Run()
	}

	log.Printf("[Vela] Removed worktree dir: %s", req.WorktreePath)
	sendJSON(w, map[string]any{"success": true}, 200)
}

// cleanupAllWorktrees removes all entries in worktreeBaseDir
func cleanupAllWorktrees() {
	entries, err := os.ReadDir(worktreeBaseDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		path := filepath.Join(worktreeBaseDir, e.Name())
		os.RemoveAll(path)
		log.Printf("[Vela] Cleaned up worktree: %s", path)
	}
}
