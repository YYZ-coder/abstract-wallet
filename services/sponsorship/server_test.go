package sponsorship_test

import (
	wallet "abstract-wallet/services/sponsorship"
	"encoding/hex"
	"encoding/json"
	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/crypto"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func config() wallet.Config {
	return wallet.Config{Manifest: map[string]any{"schemaVersion": "1", "manifestVersion": "arb-sepolia-mvp-v1", "chainId": "421614", "name": "Arbitrum Sepolia", "capabilityStatus": "unverified"}, Clock: func() time.Time { return time.Unix(1800000000, 0) }}
}
func request(t *testing.T, h http.Handler, method, path, body, token string) (int, map[string]any) {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var data map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &data)
	return w.Code, data
}
func TestConfiguredArbitrumManifest(t *testing.T) {
	status, data := request(t, wallet.New(config()), "GET", "/v1/chains", "", "")
	if status != 200 {
		t.Fatalf("GET chains status=%d, want 200", status)
	}
	chains, ok := data["chains"].([]any)
	if !ok || len(chains) != 1 {
		t.Fatalf("chains=%v, want one configured chain", data)
	}
	chain := chains[0].(map[string]any)
	if chain["chainId"] != "421614" || chain["capabilityStatus"] != "unverified" {
		t.Fatalf("manifest=%v", chain)
	}
}

func TestRootAccountCanCreateBoundBearerSession(t *testing.T) {
	c := config()
	c.ProjectID = "example_project_0001"
	c.Domain = "wallet.example"
	c.URI = "https://wallet.example"
	h := wallet.New(c)
	key, _ := crypto.HexToECDSA("0123456789012345678901234567890123456789012345678901234567890123")
	account := strings.ToLower(crypto.PubkeyToAddress(key.PublicKey).Hex())
	status, ch := request(t, h, "POST", "/v1/auth/challenges", `{"schemaVersion":"1","idempotencyKey":"challenge_key_0001","chainId":"421614","account":"`+account+`"}`, "")
	if status != 201 {
		t.Fatalf("challenge status=%d data=%v, want 201", status, ch)
	}
	message, ok := ch["message"].(string)
	if !ok || !strings.Contains(message, "wallet.example wants") {
		t.Fatalf("missing domain-bound message: %v", ch)
	}
	sig, _ := crypto.Sign(accounts.TextHash([]byte(message)), key)
	sig[64] += 27
	status, session := request(t, h, "POST", "/v1/auth/sessions", `{"schemaVersion":"1","idempotencyKey":"session_key_000001","challengeId":"`+ch["challengeId"].(string)+`","signatureScheme":"root-eip191-65","signature":"0x`+hex.EncodeToString(sig)+`"}`, "")
	if status != 201 || session["account"] != account || session["chainId"] != "421614" || session["tokenType"] != "Bearer" {
		t.Fatalf("session status=%d data=%v", status, session)
	}
	if session["expiresAt"] != "1800000300" {
		t.Fatalf("expiry=%v, want independent 1800000300", session["expiresAt"])
	}
}

func signIn(t *testing.T, h http.Handler, keySuffix string) (string, string, string) {
	t.Helper()
	key, _ := crypto.HexToECDSA("0123456789012345678901234567890123456789012345678901234567890123")
	account := strings.ToLower(crypto.PubkeyToAddress(key.PublicKey).Hex())
	challengeBody := `{"schemaVersion":"1","idempotencyKey":"challenge_key_` + keySuffix + `","chainId":"421614","account":"` + account + `"}`
	status, ch := request(t, h, "POST", "/v1/auth/challenges", challengeBody, "")
	if status != 201 {
		t.Fatalf("challenge=%d %v", status, ch)
	}
	sig, _ := crypto.Sign(accounts.TextHash([]byte(ch["message"].(string))), key)
	sig[64] += 27
	sessionBody := `{"schemaVersion":"1","idempotencyKey":"session_key_` + keySuffix + `","challengeId":"` + ch["challengeId"].(string) + `","signatureScheme":"root-eip191-65","signature":"0x` + hex.EncodeToString(sig) + `"}`
	status, ses := request(t, h, "POST", "/v1/auth/sessions", sessionBody, "")
	if status != 201 {
		t.Fatalf("session=%d %v", status, ses)
	}
	return ses["accessToken"].(string), challengeBody, sessionBody
}
func TestSignInRetriesRestoreOneSessionWithoutChallengeReplay(t *testing.T) {
	h := wallet.New(config())
	token, chBody, sBody := signIn(t, h, "00000001")
	status, ch := request(t, h, "POST", "/v1/auth/challenges", chBody, "")
	if status != 200 {
		t.Fatalf("challenge retry=%d", status)
	}
	if _, leaked := ch["consumed"]; leaked {
		t.Fatal("challenge response leaked undeclared consumed field")
	}
	status, ses := request(t, h, "POST", "/v1/auth/sessions", sBody, "")
	if status != 200 || ses["accessToken"] != token {
		t.Fatalf("retry changed logical session: %d %v", status, ses)
	}
	status, replay := request(t, h, "POST", "/v1/auth/sessions", strings.Replace(sBody, "session_key_00000001", "session_key_00000002", 1), "")
	if status != 409 || replay["error"].(map[string]any)["code"] != "CHALLENGE_REPLAY" {
		t.Fatalf("replay=%d %v", status, replay)
	}
}
