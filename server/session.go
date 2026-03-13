package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

const (
	scrollbackLimit = 512 * 1024       // 512KB
	orphanTimeout   = 10 * time.Minute // 10 minutes
)

// Session represents a terminal session
type Session struct {
	mu             sync.Mutex
	ptyFile        *os.File
	cmd            *exec.Cmd
	ws             *websocket.Conn
	scrollback     []string
	scrollbackSize int
	dead           bool
	orphanTimer    *time.Timer
	cwd            string
	agent          string
	writeCh        chan []byte // serialized writes to WebSocket
	doneCh         chan struct{}
}

func (s *Session) pushScrollback(data string) {
	s.scrollback = append(s.scrollback, data)
	s.scrollbackSize += len(data)
	for s.scrollbackSize > scrollbackLimit && len(s.scrollback) > 1 {
		s.scrollbackSize -= len(s.scrollback[0])
		s.scrollback = s.scrollback[1:]
	}
}

// kill terminates the session's PTY process and cleans up
func (s *Session) kill() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dead = true
	if s.orphanTimer != nil {
		s.orphanTimer.Stop()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
	}
	if s.ptyFile != nil {
		s.ptyFile.Close()
	}
}

// wsSend safely sends data through the write channel
func (s *Session) wsSend(data []byte) {
	select {
	case s.writeCh <- data:
	default:
		// Drop if channel full (back-pressure)
	}
}

// wsWriter drains the write channel and sends to WebSocket
func (s *Session) wsWriter() {
	for data := range s.writeCh {
		s.mu.Lock()
		ws := s.ws
		s.mu.Unlock()
		if ws != nil {
			ws.WriteMessage(websocket.TextMessage, data)
		}
	}
}

func spawnPTY(command string, args []string, dir string) (*os.File, *exec.Cmd, error) {
	cmd := exec.Command(command, args...)
	cmd.Dir = dir
	cmd.Env = shellEnv
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 30, Cols: 120})
	if err != nil {
		return nil, nil, err
	}
	return ptmx, cmd, nil
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[Vela] WebSocket upgrade failed: %v", err)
		return
	}

	q := r.URL.Query()
	agent := q.Get("agent")
	if agent == "" {
		agent = "bash"
	}
	argsStr := q.Get("args")
	args := []string{}
	if argsStr != "" {
		for _, a := range strings.Split(argsStr, ",") {
			if a != "" {
				args = append(args, a)
			}
		}
	}
	sessionId := q.Get("id")
	if sessionId == "" {
		sessionId = "unknown"
	}
	cwd := q.Get("cwd")
	if cwd == "" {
		cwd = os.Getenv("HOME")
	}

	// Check for existing session (reconnect)
	if val, ok := sessions.Load(sessionId); ok {
		s := val.(*Session)
		s.mu.Lock()
		if !s.dead && s.cmd != nil {
			log.Printf("[Vela] Reconnecting session: %s", sessionId)

			// Cancel orphan timer
			if s.orphanTimer != nil {
				s.orphanTimer.Stop()
				s.orphanTimer = nil
			}

			// Swap WebSocket
			s.ws = conn

			// Signal reconnect
			conn.WriteMessage(websocket.TextMessage, []byte(`{"__vela":"reconnect"}`))

			// Replay scrollback
			if len(s.scrollback) > 0 {
				replay := strings.Join(s.scrollback, "")
				conn.WriteMessage(websocket.TextMessage, []byte(replay))
			}

			ptmx := s.ptyFile
			s.mu.Unlock()

			// Start new PTY reader for this connection
			go readPTYToSession(s, ptmx, sessionId)

			// Handle messages from client
			handleClientMessages(conn, s, sessionId)
			return
		}
		s.mu.Unlock()
	}

	// New session
	log.Printf("[Vela] New session: %s → %s %s in %s", sessionId, agent, strings.Join(args, " "), cwd)

	conn.WriteMessage(websocket.TextMessage, []byte(`{"__vela":"new_session"}`))

	session := &Session{
		cwd:     cwd,
		agent:   agent,
		writeCh: make(chan []byte, 1024),
		doneCh:  make(chan struct{}),
	}
	sessions.Store(sessionId, session)

	// Start WebSocket writer goroutine
	go session.wsWriter()

	session.mu.Lock()
	session.ws = conn
	session.mu.Unlock()

	// Spawn PTY
	ptmx, cmd, err := spawnPTY(agent, args, cwd)
	if err != nil {
		errMsg := fmt.Sprintf("\r\n\x1b[31mFailed to start %s: %v\x1b[0m\r\n", agent, err)
		conn.WriteMessage(websocket.TextMessage, []byte(errMsg))
		conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(4000, "spawn_failed"))
		conn.Close()
		sessions.Delete(sessionId)
		close(session.writeCh)
		return
	}

	session.mu.Lock()
	session.ptyFile = ptmx
	session.cmd = cmd
	session.mu.Unlock()

	// PTY reader goroutine
	go readPTYToSession(session, ptmx, sessionId)

	// Wait for agent exit, then drop to shell
	go func() {
		exitCode := 0
		if err := cmd.Wait(); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			}
		}

		log.Printf("[Vela] %s exited for %s with code %d", agent, sessionId, exitCode)

		exitMsg := fmt.Sprintf("\r\n\x1b[90m[%s exited with code %d]\x1b[0m\r\n\x1b[90m[Dropping to shell in %s]\x1b[0m\r\n\r\n", agent, exitCode, cwd)
		session.mu.Lock()
		session.pushScrollback(exitMsg)
		session.mu.Unlock()
		session.wsSend([]byte(exitMsg))

		// Spawn fallback shell
		shellPtmx, shellCmd, err := spawnPTY(loginShell, []string{"-l"}, cwd)
		if err != nil {
			log.Printf("[Vela] Failed to spawn shell for %s: %v", sessionId, err)
			session.mu.Lock()
			session.dead = true
			session.mu.Unlock()
			endMsg := "\r\n\x1b[90m[Session ended]\x1b[0m\r\n"
			session.wsSend([]byte(endMsg))
			session.mu.Lock()
			if session.ws != nil {
				session.ws.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(4000, "session_ended"))
			}
			session.mu.Unlock()
			sessions.Delete(sessionId)
			return
		}

		session.mu.Lock()
		session.ptyFile = shellPtmx
		session.cmd = shellCmd
		session.mu.Unlock()

		// Read from new shell PTY
		go readPTYToSession(session, shellPtmx, sessionId)

		// Wait for shell exit
		shellCmd.Wait()
		log.Printf("[Vela] Shell exited for %s", sessionId)

		session.mu.Lock()
		session.dead = true
		session.mu.Unlock()

		endMsg := "\r\n\x1b[90m[Session ended]\x1b[0m\r\n"
		session.wsSend([]byte(endMsg))

		session.mu.Lock()
		if session.ws != nil {
			session.ws.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(4000, "session_ended"))
		}
		session.mu.Unlock()

		sessions.Delete(sessionId)
	}()

	// Handle messages from client
	handleClientMessages(conn, session, sessionId)
}

// readPTYToSession reads from PTY and sends to session's WebSocket
func readPTYToSession(s *Session, ptmx *os.File, sessionId string) {
	buf := make([]byte, 4096)
	for {
		n, err := ptmx.Read(buf)
		if n > 0 {
			data := string(buf[:n])
			s.mu.Lock()
			s.pushScrollback(data)
			s.mu.Unlock()
			s.wsSend(buf[:n])
		}
		if err != nil {
			if err != io.EOF {
				// PTY closed or process exited — expected
			}
			return
		}
	}
}

// handleClientMessages reads WebSocket messages and writes to PTY
func handleClientMessages(conn *websocket.Conn, s *Session, sessionId string) {
	defer func() {
		log.Printf("[Vela] Session %s disconnected (will persist)", sessionId)
		s.mu.Lock()
		s.ws = nil
		s.mu.Unlock()
		scheduleOrphanCleanup(s, sessionId)
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}

		// Try parsing as JSON
		var parsed struct {
			Type string `json:"type"`
			Data string `json:"data"`
			Cols uint16 `json:"cols"`
			Rows uint16 `json:"rows"`
		}

		if err := json.Unmarshal(msg, &parsed); err == nil {
			switch parsed.Type {
			case "kill":
				log.Printf("[Vela] Kill requested for session: %s", sessionId)
				s.mu.Lock()
				s.dead = true
				if s.orphanTimer != nil {
					s.orphanTimer.Stop()
				}
				if s.cmd != nil && s.cmd.Process != nil {
					syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
				}
				if s.ptyFile != nil {
					s.ptyFile.Close()
				}
				s.mu.Unlock()
				conn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(4000, "killed"))
				conn.Close()
				sessions.Delete(sessionId)
				return

			case "input":
				s.mu.Lock()
				ptmx := s.ptyFile
				s.mu.Unlock()
				if ptmx != nil {
					ptmx.Write([]byte(parsed.Data))
				}

			case "resize":
				s.mu.Lock()
				ptmx := s.ptyFile
				s.mu.Unlock()
				if ptmx != nil && parsed.Cols > 0 && parsed.Rows > 0 {
					pty.Setsize(ptmx, &pty.Winsize{
						Cols: parsed.Cols,
						Rows: parsed.Rows,
					})
				}
			}
		} else {
			// Raw input fallback
			s.mu.Lock()
			ptmx := s.ptyFile
			s.mu.Unlock()
			if ptmx != nil {
				ptmx.Write(msg)
			}
		}
	}
}

func scheduleOrphanCleanup(s *Session, sessionId string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.orphanTimer != nil {
		s.orphanTimer.Stop()
	}

	s.orphanTimer = time.AfterFunc(orphanTimeout, func() {
		s.mu.Lock()
		wsGone := s.ws == nil
		s.mu.Unlock()

		if wsGone {
			if _, ok := sessions.Load(sessionId); ok {
				log.Printf("[Vela] Cleaning up orphaned session: %s", sessionId)
				s.kill()
				sessions.Delete(sessionId)
			}
		}
	})
}
