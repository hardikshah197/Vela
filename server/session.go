package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

const (
	scrollbackLimit = 512 * 1024       // 512KB
	orphanTimeout   = 10 * time.Minute // 10 minutes
)

// wsMsg wraps a WebSocket message with its type
type wsMsg struct {
	data []byte
	text bool // true = TextMessage, false = BinaryMessage
}

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
	writeCh        chan wsMsg // serialized writes to WebSocket
	doneCh         chan struct{}
	writeErr       bool // set when WebSocket write fails
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

// wsSend safely sends binary data through the write channel
func (s *Session) wsSend(data []byte) {
	select {
	case s.writeCh <- wsMsg{data: data}:
	case <-time.After(5 * time.Second):
		log.Printf("[Vela] Write channel full, dropping data (%d bytes)", len(data))
	}
}

// sendControl sends a JSON control message as TextMessage through the write channel
func (s *Session) sendControl(data []byte) {
	select {
	case s.writeCh <- wsMsg{data: data, text: true}:
	case <-time.After(5 * time.Second):
		log.Printf("[Vela] Write channel full, dropping control message")
	}
}

// wsWriter drains the write channel and sends to WebSocket
func (s *Session) wsWriter() {
	for msg := range s.writeCh {
		s.mu.Lock()
		ws := s.ws
		s.mu.Unlock()
		if ws != nil {
			msgType := websocket.BinaryMessage
			if msg.text {
				msgType = websocket.TextMessage
			}
			if err := ws.WriteMessage(msgType, msg.data); err != nil {
				log.Printf("[Vela] WebSocket write error: %v", err)
				s.mu.Lock()
				s.writeErr = true
				s.mu.Unlock()
				// Drain remaining messages to avoid blocking senders
				for range s.writeCh {
				}
				return
			}
		}
	}
}

func spawnPTY(command string, args []string, dir string) (*os.File, *exec.Cmd, error) {
	master, slave, err := openPTY()
	if err != nil {
		return nil, nil, err
	}

	cmd := exec.Command(command, args...)
	cmd.Dir = dir
	cmd.Env = shellEnv
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	// Setsid creates a new session so the PTY becomes the controlling terminal.
	// NOTE: Do NOT combine Setsid with Setpgid — on macOS Sequoia this triggers
	// "operation not permitted" for ad-hoc signed binaries.
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
		Ctty:   int(slave.Fd()),
	}

	if err := cmd.Start(); err != nil {
		master.Close()
		slave.Close()
		return nil, nil, err
	}
	slave.Close()

	setWinSize(master, 30, 120)
	return master, cmd, nil
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

			// Close old WebSocket to force old handleClientMessages to exit cleanly.
			// This prevents the old defer from racing with us and nulling s.ws.
			if s.ws != nil {
				s.ws.Close()
			}

			// Set new WebSocket
			s.ws = conn

			// If previous wsWriter exited due to write error, restart it
			if s.writeErr {
				s.writeErr = false
				s.writeCh = make(chan wsMsg, 4096)
				go s.wsWriter()
			} else {
				// Drain stale data from writeCh to avoid sending old buffered
				// PTY output before the reconnect signal
				drained := 0
			drain:
				for {
					select {
					case <-s.writeCh:
						drained++
					default:
						break drain
					}
				}
				if drained > 0 {
					log.Printf("[Vela] Drained %d stale messages from writeCh for %s", drained, sessionId)
				}
			}

			// Send reconnect signal (wsWriter is blocked waiting on lock we hold,
			// so these direct writes are safe — no concurrent writers)
			if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"__vela":"reconnect"}`)); err != nil {
				log.Printf("[Vela] Failed to send reconnect signal for %s: %v", sessionId, err)
				s.ws = nil
				s.mu.Unlock()
				conn.Close()
				return
			}

			// Replay scrollback as BinaryMessage (PTY data may contain invalid UTF-8)
			if len(s.scrollback) > 0 {
				replay := strings.Join(s.scrollback, "")
				if err := conn.WriteMessage(websocket.BinaryMessage, []byte(replay)); err != nil {
					log.Printf("[Vela] Failed to send scrollback (%d bytes) for %s: %v", len(replay), sessionId, err)
					s.ws = nil
					s.mu.Unlock()
					conn.Close()
					return
				}
			}

			s.mu.Unlock()

			// Do NOT start another readPTYToSession — the original goroutine
			// from session creation is still running and feeding writeCh.
			// Starting duplicates causes goroutine leaks and data races.

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
		writeCh: make(chan wsMsg, 4096),
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
		session.wsSend([]byte(errMsg))
		time.Sleep(200 * time.Millisecond)
		close(session.writeCh)
		session.mu.Lock()
		if session.ws != nil {
			// Send spawn_failed as TextMessage so the client detects it as a control message
			session.ws.WriteMessage(websocket.TextMessage, []byte(`{"__vela":"spawn_failed"}`))
			time.Sleep(300 * time.Millisecond)
			session.ws.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(4000, "spawn_failed"))
			session.ws.Close()
		}
		session.mu.Unlock()
		sessions.Delete(sessionId)
		return
	}

	session.mu.Lock()
	session.ptyFile = ptmx
	session.cmd = cmd
	session.mu.Unlock()

	// PTY reader goroutine — only ONE per session, ever
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
			session.wsSend([]byte("\r\n\x1b[90m[Session ended]\x1b[0m\r\n"))
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

		// New PTY reader for the shell
		go readPTYToSession(session, shellPtmx, sessionId)

		// Wait for shell exit
		shellCmd.Wait()
		log.Printf("[Vela] Shell exited for %s", sessionId)

		session.mu.Lock()
		session.dead = true
		session.mu.Unlock()

		session.wsSend([]byte("\r\n\x1b[90m[Session ended]\x1b[0m\r\n"))

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
			// Copy data before sending — buf is reused on next Read
			chunk := make([]byte, n)
			copy(chunk, buf[:n])

			s.mu.Lock()
			s.pushScrollback(string(chunk))
			s.mu.Unlock()
			s.wsSend(chunk)
		}
		if err != nil {
			return
		}
	}
}

// handleClientMessages reads WebSocket messages and writes to PTY
func handleClientMessages(conn *websocket.Conn, s *Session, sessionId string) {
	defer func() {
		// Only nil out s.ws if WE are still the active connection.
		// A newer reconnect may have already replaced s.ws — don't clobber it.
		s.mu.Lock()
		if s.ws == conn {
			log.Printf("[Vela] Session %s disconnected (will persist)", sessionId)
			s.ws = nil
			s.mu.Unlock()
			scheduleOrphanCleanup(s, sessionId)
		} else {
			log.Printf("[Vela] Session %s old connection closed (superseded by reconnect)", sessionId)
			s.mu.Unlock()
		}
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Printf("[Vela] Session %s read error: %v", sessionId, err)
			}
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
					setWinSize(ptmx, parsed.Rows, parsed.Cols)
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
