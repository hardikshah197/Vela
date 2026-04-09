package main

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// --- Auth config persisted to ~/.vela/auth.json ---

type AuthConfig struct {
	OnboardingDone     bool   `json:"onboardingDone"`
	Enabled            bool   `json:"enabled"`
	PinHash            string `json:"pinHash,omitempty"`
	PinSalt            string `json:"pinSalt,omitempty"`
	FingerprintEnabled bool   `json:"fingerprintEnabled"`
	WebAuthnCredID     string `json:"webauthnCredId,omitempty"`
	WebAuthnPubKey     string `json:"webauthnPubKey,omitempty"` // base64 SPKI DER
}

var (
	authMu  sync.RWMutex
	authCfg AuthConfig

	// In-memory session tokens (token → expiry)
	authTokens  = map[string]time.Time{}
	authTokenMu sync.RWMutex

	// Pending WebAuthn challenges (key → challenge bytes)
	webauthnChallenges   = map[string][]byte{}
	webauthnChallengesMu sync.Mutex
)

const authSessionDuration = 24 * time.Hour

func velaConfigDir() string {
	home := os.Getenv("HOME")
	if home == "" {
		home = "/root"
	}
	return filepath.Join(home, ".vela")
}

func loadAuthConfig() {
	authMu.Lock()
	defer authMu.Unlock()

	data, err := os.ReadFile(filepath.Join(velaConfigDir(), "auth.json"))
	if err != nil {
		authCfg = AuthConfig{}
		return
	}
	json.Unmarshal(data, &authCfg)
}

func saveAuthConfigLocked() error {
	dir := velaConfigDir()
	os.MkdirAll(dir, 0700)
	data, err := json.MarshalIndent(&authCfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "auth.json"), data, 0600)
}

// --- Helpers ---

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	rand.Read(b)
	return b
}

func hashPIN(pin, salt string) string {
	h := sha256.Sum256([]byte(salt + ":" + pin))
	return hex.EncodeToString(h[:])
}

// --- Token management ---

func createAuthToken() string {
	token := randomHex(32)
	authTokenMu.Lock()
	authTokens[token] = time.Now().Add(authSessionDuration)
	authTokenMu.Unlock()
	return token
}

func validateAuthToken(token string) bool {
	if token == "" {
		return false
	}
	authTokenMu.RLock()
	expiry, ok := authTokens[token]
	authTokenMu.RUnlock()
	return ok && time.Now().Before(expiry)
}

func startAuthTokenCleanup() {
	go func() {
		ticker := time.NewTicker(time.Hour)
		for range ticker.C {
			now := time.Now()
			authTokenMu.Lock()
			for t, exp := range authTokens {
				if now.After(exp) {
					delete(authTokens, t)
				}
			}
			authTokenMu.Unlock()
		}
	}()
}

// --- Middleware helpers ---

func isAuthRequired() bool {
	authMu.RLock()
	defer authMu.RUnlock()
	return authCfg.Enabled
}

func extractToken(r *http.Request) string {
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	return r.URL.Query().Get("token")
}

func isAuthExempt(path string) bool {
	return path == "/api/auth/status" ||
		path == "/api/auth/setup" ||
		path == "/api/auth/verify-pin" ||
		path == "/api/auth/update" ||
		path == "/api/auth/webauthn/register-options" ||
		path == "/api/auth/webauthn/register" ||
		path == "/api/auth/webauthn/login-options" ||
		path == "/api/auth/webauthn/login"
}

// --- Handlers ---

// GET /api/auth/status
func handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	authMu.RLock()
	cfg := authCfg
	authMu.RUnlock()

	authenticated := validateAuthToken(extractToken(r)) || !cfg.Enabled

	sendJSON(w, map[string]any{
		"onboardingDone": cfg.OnboardingDone,
		"enabled":        cfg.Enabled,
		"hasPIN":         cfg.PinHash != "",
		"hasFingerprint": cfg.FingerprintEnabled && cfg.WebAuthnCredID != "",
		"authenticated":  authenticated,
	}, 200)
}

// POST /api/auth/setup — first-time onboarding
func handleAuthSetup(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		sendJSON(w, map[string]string{"error": "Failed to read body"}, 400)
		return
	}

	var req struct {
		EnableAuth  bool     `json:"enableAuth"`
		Pin         string   `json:"pin"`
		SearchRoots []string `json:"searchRoots"`
		CloneDir    string   `json:"cloneDir"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		sendJSON(w, map[string]string{"error": "Invalid JSON"}, 400)
		return
	}

	authMu.Lock()
	authCfg.OnboardingDone = true
	authCfg.Enabled = req.EnableAuth

	if req.EnableAuth && req.Pin != "" {
		if len(req.Pin) < 4 {
			authMu.Unlock()
			sendJSON(w, map[string]string{"error": "PIN must be at least 4 digits"}, 400)
			return
		}
		salt := randomHex(16)
		authCfg.PinSalt = salt
		authCfg.PinHash = hashPIN(req.Pin, salt)
	}

	if err := saveAuthConfigLocked(); err != nil {
		authMu.Unlock()
		log.Printf("[Vela] Failed to save auth config: %v", err)
		sendJSON(w, map[string]string{"error": "Failed to save"}, 500)
		return
	}
	authMu.Unlock()

	// Also update server config
	if len(req.SearchRoots) > 0 || req.CloneDir != "" {
		cfgMu.Lock()
		if len(req.SearchRoots) > 0 {
			searchRoots = req.SearchRoots
		}
		if req.CloneDir != "" {
			cloneDir = req.CloneDir
			os.MkdirAll(cloneDir, 0755)
		}
		cfgMu.Unlock()
	}

	token := createAuthToken()
	log.Printf("[Vela] Onboarding completed (auth=%v)", req.EnableAuth)
	sendJSON(w, map[string]any{"success": true, "token": token}, 200)
}

// POST /api/auth/verify-pin
func handleVerifyPin(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		sendJSON(w, map[string]string{"error": "Failed to read body"}, 400)
		return
	}

	var req struct {
		Pin string `json:"pin"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		sendJSON(w, map[string]string{"error": "Invalid JSON"}, 400)
		return
	}

	authMu.RLock()
	hash := hashPIN(req.Pin, authCfg.PinSalt)
	expected := authCfg.PinHash
	authMu.RUnlock()

	if subtle.ConstantTimeCompare([]byte(hash), []byte(expected)) != 1 {
		sendJSON(w, map[string]any{"success": false, "error": "Invalid PIN"}, 401)
		return
	}

	token := createAuthToken()
	sendJSON(w, map[string]any{"success": true, "token": token}, 200)
}

// POST /api/auth/update — change PIN, toggle fingerprint, disable auth
func handleAuthUpdate(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		sendJSON(w, map[string]string{"error": "Failed to read body"}, 400)
		return
	}

	var req struct {
		Enabled            *bool  `json:"enabled"`
		NewPin             string `json:"newPin"`
		DisableFingerprint bool   `json:"disableFingerprint"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		sendJSON(w, map[string]string{"error": "Invalid JSON"}, 400)
		return
	}

	authMu.Lock()
	if req.Enabled != nil {
		authCfg.Enabled = *req.Enabled
		if !*req.Enabled {
			authCfg.PinHash = ""
			authCfg.PinSalt = ""
			authCfg.FingerprintEnabled = false
			authCfg.WebAuthnCredID = ""
			authCfg.WebAuthnPubKey = ""
		}
	}

	if req.NewPin != "" {
		if len(req.NewPin) < 4 {
			authMu.Unlock()
			sendJSON(w, map[string]string{"error": "PIN must be at least 4 digits"}, 400)
			return
		}
		salt := randomHex(16)
		authCfg.PinSalt = salt
		authCfg.PinHash = hashPIN(req.NewPin, salt)
	}

	if req.DisableFingerprint {
		authCfg.FingerprintEnabled = false
		authCfg.WebAuthnCredID = ""
		authCfg.WebAuthnPubKey = ""
	}

	if err := saveAuthConfigLocked(); err != nil {
		authMu.Unlock()
		sendJSON(w, map[string]string{"error": "Failed to save"}, 500)
		return
	}
	authMu.Unlock()

	sendJSON(w, map[string]any{"success": true}, 200)
}

// POST /api/auth/logout — clear current session
func handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	token := extractToken(r)
	if token != "" {
		authTokenMu.Lock()
		delete(authTokens, token)
		authTokenMu.Unlock()
	}
	sendJSON(w, map[string]any{"success": true}, 200)
}

// --- WebAuthn (fingerprint / Touch ID) ---

// GET /api/auth/webauthn/register-options — requires auth
func handleWebAuthnRegisterOptions(w http.ResponseWriter, r *http.Request) {
	challenge := randomBytes(32)
	challengeB64 := base64.RawURLEncoding.EncodeToString(challenge)

	token := extractToken(r)
	key := "reg:" + token
	webauthnChallengesMu.Lock()
	webauthnChallenges[key] = challenge
	webauthnChallengesMu.Unlock()

	go func() {
		time.Sleep(5 * time.Minute)
		webauthnChallengesMu.Lock()
		delete(webauthnChallenges, key)
		webauthnChallengesMu.Unlock()
	}()

	sendJSON(w, map[string]any{
		"challenge": challengeB64,
		"rp":        map[string]string{"id": "localhost", "name": "Vela"},
		"user": map[string]any{
			"id":          base64.RawURLEncoding.EncodeToString([]byte("vela-user")),
			"name":        "Vela User",
			"displayName": "Vela User",
		},
		"pubKeyCredParams": []map[string]any{
			{"type": "public-key", "alg": -7}, // ES256
		},
		"authenticatorSelection": map[string]any{
			"authenticatorAttachment": "platform",
			"userVerification":        "required",
		},
		"timeout": 60000,
	}, 200)
}

// POST /api/auth/webauthn/register — requires auth
func handleWebAuthnRegister(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		sendJSON(w, map[string]string{"error": "Failed to read body"}, 400)
		return
	}

	var req struct {
		CredentialID   string `json:"credentialId"`
		PublicKey      string `json:"publicKey"`
		ClientDataJSON string `json:"clientDataJSON"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		sendJSON(w, map[string]string{"error": "Invalid JSON"}, 400)
		return
	}

	// Verify challenge from clientDataJSON
	clientData, err := base64.StdEncoding.DecodeString(req.ClientDataJSON)
	if err != nil {
		sendJSON(w, map[string]string{"error": "Invalid clientDataJSON encoding"}, 400)
		return
	}

	var cd struct {
		Type      string `json:"type"`
		Challenge string `json:"challenge"`
		Origin    string `json:"origin"`
	}
	if err := json.Unmarshal(clientData, &cd); err != nil {
		sendJSON(w, map[string]string{"error": "Invalid client data"}, 400)
		return
	}

	if cd.Type != "webauthn.create" {
		sendJSON(w, map[string]string{"error": "Invalid ceremony type"}, 400)
		return
	}
	if !strings.HasPrefix(cd.Origin, "http://localhost") {
		sendJSON(w, map[string]string{"error": "Invalid origin"}, 400)
		return
	}

	token := extractToken(r)
	key := "reg:" + token
	webauthnChallengesMu.Lock()
	expected, ok := webauthnChallenges[key]
	delete(webauthnChallenges, key)
	webauthnChallengesMu.Unlock()

	if !ok {
		sendJSON(w, map[string]string{"error": "Challenge expired"}, 400)
		return
	}
	if cd.Challenge != base64.RawURLEncoding.EncodeToString(expected) {
		sendJSON(w, map[string]string{"error": "Challenge mismatch"}, 400)
		return
	}

	// Validate public key
	pubKeyDER, err := base64.StdEncoding.DecodeString(req.PublicKey)
	if err != nil {
		sendJSON(w, map[string]string{"error": "Invalid public key encoding"}, 400)
		return
	}
	if _, err := x509.ParsePKIXPublicKey(pubKeyDER); err != nil {
		sendJSON(w, map[string]string{"error": "Invalid public key"}, 400)
		return
	}

	authMu.Lock()
	authCfg.Enabled = true
	authCfg.FingerprintEnabled = true
	authCfg.WebAuthnCredID = req.CredentialID
	authCfg.WebAuthnPubKey = req.PublicKey
	if err := saveAuthConfigLocked(); err != nil {
		authMu.Unlock()
		sendJSON(w, map[string]string{"error": "Failed to save"}, 500)
		return
	}
	authMu.Unlock()

	log.Printf("[Vela] Fingerprint registered")
	sendJSON(w, map[string]any{"success": true}, 200)
}

// GET /api/auth/webauthn/login-options — no auth required
func handleWebAuthnLoginOptions(w http.ResponseWriter, r *http.Request) {
	authMu.RLock()
	credID := authCfg.WebAuthnCredID
	enabled := authCfg.FingerprintEnabled
	authMu.RUnlock()

	if !enabled || credID == "" {
		sendJSON(w, map[string]string{"error": "No fingerprint configured"}, 400)
		return
	}

	challenge := randomBytes(32)
	challengeB64 := base64.RawURLEncoding.EncodeToString(challenge)
	sessionKey := randomHex(16)

	webauthnChallengesMu.Lock()
	webauthnChallenges["login:"+sessionKey] = challenge
	webauthnChallengesMu.Unlock()

	go func() {
		time.Sleep(5 * time.Minute)
		webauthnChallengesMu.Lock()
		delete(webauthnChallenges, "login:"+sessionKey)
		webauthnChallengesMu.Unlock()
	}()

	sendJSON(w, map[string]any{
		"challenge":  challengeB64,
		"sessionKey": sessionKey,
		"rpId":       "localhost",
		"allowCredentials": []map[string]any{
			{"type": "public-key", "id": credID},
		},
		"userVerification": "required",
		"timeout":          60000,
	}, 200)
}

// POST /api/auth/webauthn/login — no auth required
func handleWebAuthnLogin(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		sendJSON(w, map[string]string{"error": "Failed to read body"}, 400)
		return
	}

	var req struct {
		SessionKey        string `json:"sessionKey"`
		CredentialID      string `json:"credentialId"`
		AuthenticatorData string `json:"authenticatorData"`
		ClientDataJSON    string `json:"clientDataJSON"`
		Signature         string `json:"signature"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		sendJSON(w, map[string]string{"error": "Invalid JSON"}, 400)
		return
	}

	// Retrieve challenge
	webauthnChallengesMu.Lock()
	expected, ok := webauthnChallenges["login:"+req.SessionKey]
	delete(webauthnChallenges, "login:"+req.SessionKey)
	webauthnChallengesMu.Unlock()

	if !ok {
		sendJSON(w, map[string]any{"success": false, "error": "Challenge expired"}, 401)
		return
	}

	// Decode and verify clientDataJSON
	clientData, err := base64.StdEncoding.DecodeString(req.ClientDataJSON)
	if err != nil {
		sendJSON(w, map[string]any{"success": false, "error": "Invalid encoding"}, 400)
		return
	}

	var cd struct {
		Type      string `json:"type"`
		Challenge string `json:"challenge"`
		Origin    string `json:"origin"`
	}
	if err := json.Unmarshal(clientData, &cd); err != nil {
		sendJSON(w, map[string]any{"success": false, "error": "Invalid client data"}, 400)
		return
	}

	if cd.Type != "webauthn.get" {
		sendJSON(w, map[string]any{"success": false, "error": "Wrong ceremony type"}, 400)
		return
	}
	if !strings.HasPrefix(cd.Origin, "http://localhost") {
		sendJSON(w, map[string]any{"success": false, "error": "Invalid origin"}, 400)
		return
	}
	if cd.Challenge != base64.RawURLEncoding.EncodeToString(expected) {
		sendJSON(w, map[string]any{"success": false, "error": "Challenge mismatch"}, 401)
		return
	}

	// Verify ECDSA signature
	authMu.RLock()
	pubKeyB64 := authCfg.WebAuthnPubKey
	authMu.RUnlock()

	pubKeyDER, err := base64.StdEncoding.DecodeString(pubKeyB64)
	if err != nil {
		sendJSON(w, map[string]any{"success": false, "error": "Server key error"}, 500)
		return
	}

	pubKeyIface, err := x509.ParsePKIXPublicKey(pubKeyDER)
	if err != nil {
		sendJSON(w, map[string]any{"success": false, "error": "Key parse error"}, 500)
		return
	}

	ecdsaKey, ok := pubKeyIface.(*ecdsa.PublicKey)
	if !ok {
		sendJSON(w, map[string]any{"success": false, "error": "Unsupported key type"}, 500)
		return
	}

	authData, err := base64.StdEncoding.DecodeString(req.AuthenticatorData)
	if err != nil {
		sendJSON(w, map[string]any{"success": false, "error": "Invalid authenticatorData"}, 400)
		return
	}

	sig, err := base64.StdEncoding.DecodeString(req.Signature)
	if err != nil {
		sendJSON(w, map[string]any{"success": false, "error": "Invalid signature"}, 400)
		return
	}

	// WebAuthn: signedData = authenticatorData || SHA-256(clientDataJSON)
	clientDataHash := sha256.Sum256(clientData)
	signedData := append(authData, clientDataHash[:]...)
	signedDataHash := sha256.Sum256(signedData)

	if !ecdsa.VerifyASN1(ecdsaKey, signedDataHash[:], sig) {
		sendJSON(w, map[string]any{"success": false, "error": "Signature verification failed"}, 401)
		return
	}

	token := createAuthToken()
	log.Printf("[Vela] Fingerprint login successful")
	sendJSON(w, map[string]any{"success": true, "token": token}, 200)
}
