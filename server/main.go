package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// --- Global mutable config ---
var (
	cfgMu       sync.RWMutex
	searchRoots []string
	cloneDir    string
	loginShell  string
	shellEnv    []string
	distDir     string
)

// --- Sessions ---
var sessions sync.Map // map[string]*Session

// MIME types for static file serving
var mimeTypes = map[string]string{
	".html":  "text/html",
	".js":    "application/javascript",
	".css":   "text/css",
	".json":  "application/json",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".ico":   "image/x-icon",
	".woff":  "font/woff",
	".woff2": "font/woff2",
}

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func main() {
	home := os.Getenv("HOME")
	if home == "" {
		home = "/root"
	}

	// Read config from env
	if roots := os.Getenv("VELA_SEARCH_ROOTS"); roots != "" {
		searchRoots = strings.Split(roots, ",")
	} else {
		searchRoots = []string{filepath.Join(home, "Desktop")}
	}

	cloneDir = os.Getenv("VELA_CLONE_DIR")
	if cloneDir == "" {
		cloneDir = filepath.Join(home, "Desktop", "workplace", "lambdatest")
	}

	loginShell = os.Getenv("SHELL")
	if loginShell == "" {
		loginShell = "/bin/zsh"
	}

	os.MkdirAll(cloneDir, 0755)

	// Extract full PATH from user's login shell
	shellPath := os.Getenv("PATH")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	out, err := exec.CommandContext(ctx, loginShell, "-ilc", "echo $PATH").Output()
	cancel()
	if err == nil && len(strings.TrimSpace(string(out))) > 0 {
		shellPath = strings.TrimSpace(string(out))
	}

	shellEnv = buildShellEnv(shellPath)
	distDir = resolveDistDir()

	port := os.Getenv("PORT")
	if port == "" {
		port = "3001"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/", handleAPI)
	mux.HandleFunc("/", handleRoot)

	server := &http.Server{
		Addr:    ":" + port,
		Handler: mux,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("[Vela] Shutting down...")
		sessions.Range(func(key, value any) bool {
			s := value.(*Session)
			s.kill()
			return true
		})
		server.Close()
	}()

	log.Printf("[Vela] Running on port %s", port)
	log.Printf("[Vela] Search roots: %s", strings.Join(searchRoots, ", "))
	log.Printf("[Vela] Serving static from: %s", distDir)

	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("[Vela] Server error: %v", err)
	}
}

// handleRoot dispatches WebSocket upgrades vs static files
func handleRoot(w http.ResponseWriter, r *http.Request) {
	if websocket.IsWebSocketUpgrade(r) {
		handleWebSocket(w, r)
		return
	}
	serveStatic(w, r)
}

// serveStatic serves files from dist/ with SPA fallback
func serveStatic(w http.ResponseWriter, r *http.Request) {
	urlPath := r.URL.Path
	if urlPath == "/" {
		urlPath = "/index.html"
	}

	filePath := filepath.Join(distDir, filepath.Clean(urlPath))

	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		if strings.HasPrefix(r.URL.Path, "/terminal") {
			filePath = filepath.Join(distDir, "terminal.html")
		} else {
			filePath = filepath.Join(distDir, "index.html")
		}
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		http.Error(w, "Not found", 404)
		return
	}

	ext := filepath.Ext(filePath)
	ct := mimeTypes[ext]
	if ct == "" {
		ct = "application/octet-stream"
	}

	w.Header().Set("Content-Type", ct)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(data)
}

// sendJSON writes a JSON response with CORS headers
func sendJSON(w http.ResponseWriter, data any, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// readBody reads the full request body
func readBody(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	return io.ReadAll(r.Body)
}

func buildShellEnv(shellPath string) []string {
	env := []string{}
	for _, e := range os.Environ() {
		key := strings.SplitN(e, "=", 2)[0]
		if key == "CLAUDECODE" || key == "PATH" {
			continue
		}
		env = append(env, e)
	}
	env = append(env, "PATH="+shellPath)
	env = append(env, "TERM=xterm-256color")
	env = append(env, "FORCE_COLOR=1")
	return env
}

func resolveDistDir() string {
	// Try relative to binary location
	if exe, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(exe), "..", "dist")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			abs, _ := filepath.Abs(candidate)
			return abs
		}
	}
	// Try cwd/dist
	if info, err := os.Stat("dist"); err == nil && info.IsDir() {
		abs, _ := filepath.Abs("dist")
		return abs
	}
	// Try parent (when running from server/ subdir)
	if info, err := os.Stat("../dist"); err == nil && info.IsDir() {
		abs, _ := filepath.Abs("../dist")
		return abs
	}
	return "dist"
}
