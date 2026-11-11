package sponsorship_test

import (
	wallet "abstract-wallet/services/sponsorship"
	"context"
	"encoding/hex"
	"encoding/json"
	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/crypto"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func postgresConfig(t *testing.T) wallet.Config {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set: real PostgreSQL not executed")
	}
	store, e := wallet.OpenPostgres(context.Background(), url, []byte(strings.Repeat("k", 32)), "backend-test-"+time.Now().Format("150405.000000000"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(store.Close)
	c := sponsorConfig(t)
	c.Store = store
	return c
}
func reserve(t *testing.T, h http.Handler, token, key string) (int, map[string]any) {
	t.Helper()
	b := sponsorBody(t, "prepare_"+key)
	status, q := request(t, h, "POST", "/v1/sponsorships/prepare", body(b), token)
	if status != 201 {
		t.Fatalf("prepare=%d %v", status, q)
	}
	b["idempotencyKey"] = "reserve_" + key
	b["quoteId"] = q["quoteId"]
	return request(t, h, "POST", "/v1/sponsorships", body(b), token)
}
func TestPostgresPreservesSessionAndReservedBudgetAcrossServiceInstances(t *testing.T) {
	c := postgresConfig(t)
	h1 := wallet.New(c)
	token, _, _ := signIn(t, h1, "00000001")
	status, p := reserve(t, h1, token, "000000001")
	if status != 201 {
		t.Fatalf("first permit=%d %v", status, p)
	}
	h2 := wallet.New(c)
	status, b := request(t, h2, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
	if status != 200 {
		t.Fatalf("second service lost persisted session: status=%d data=%v", status, b)
	}
	a := b["accountBudget"].(map[string]any)
	if a["availableNative"] != "60" || a["reservedRiskNative"] != "40" {
		t.Fatalf("persisted budget=%v, want available60 risk40", a)
	}
}

func TestPostgresConcurrentBudgetDenialHasSafeRecovery(t *testing.T) {
	c := postgresConfig(t)
	first := wallet.New(c)
	token, _, _ := signIn(t, first, "00000001")
	status, _ := reserve(t, first, token, "initial_00001")
	if status != 201 {
		t.Fatalf("initial reserve=%d", status)
	}
	h1, h2 := wallet.New(c), wallet.New(c)
	requests := []map[string]any{}
	for _, k := range []string{"parallel_one_0001", "parallel_two_0002"} {
		b := sponsorBody(t, "prepare_"+k)
		st, q := request(t, first, "POST", "/v1/sponsorships/prepare", body(b), token)
		if st != 201 {
			t.Fatalf("quote=%d %v", st, q)
		}
		b["quoteId"] = q["quoteId"]
		b["idempotencyKey"] = "reserve_" + k
		requests = append(requests, b)
	}
	type result struct {
		status int
		data   map[string]any
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	for i, h := range []http.Handler{h1, h2} {
		go func(i int, h http.Handler) {
			<-start
			st, data := request(t, h, "POST", "/v1/sponsorships", body(requests[i]), token)
			results <- result{st, data}
		}(i, h)
	}
	close(start)
	success, denied := 0, 0
	for i := 0; i < 2; i++ {
		r := <-results
		if r.status == 201 {
			success++
			continue
		}
		if r.status == 409 {
			e := r.data["error"].(map[string]any)
			if e["code"] != "BUDGET_EXCEEDED" || e["requiredAction"] != "CHOOSE_SELF_PAY" || e["retryable"] != false {
				t.Fatalf("unsafe concurrent denial=%v", r.data)
			}
			denied++
		} else {
			t.Fatalf("unexpected result=%d %v", r.status, r.data)
		}
	}
	if success != 1 || denied != 1 {
		t.Fatalf("success=%d denied=%d want1/1", success, denied)
	}
	_, b := request(t, first, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
	a := b["accountBudget"].(map[string]any)
	if a["availableNative"] != "20" || a["reservedRiskNative"] != "80" {
		t.Fatalf("overspent budget=%v", a)
	}
}

func TestPostgresSigningReservationRecoversOnSameRequestAfterRestart(t *testing.T) {
	c := postgresConfig(t)
	bad := c
	bad.SponsorPrivateKey = "temporarily-unavailable-signing-key"
	h1 := wallet.New(bad)
	token, _, _ := signIn(t, h1, "00000001")
	b := sponsorBody(t, "recovery_prepare_001")
	status, q := request(t, h1, "POST", "/v1/sponsorships/prepare", body(b), token)
	if status != 201 {
		t.Fatalf("quote=%d %v", status, q)
	}
	b["quoteId"] = q["quoteId"]
	b["idempotencyKey"] = "recovery_reserve_001"
	status, waiting := request(t, h1, "POST", "/v1/sponsorships", body(b), token)
	if status != 202 || waiting["permit"] != nil || waiting["state"] != "signing" {
		t.Fatalf("expected persistent unsigned reservation: %d %v", status, waiting)
	}
	h2 := wallet.New(c)
	status, recovered := request(t, h2, "POST", "/v1/sponsorships", body(b), token)
	if status != 200 || recovered["state"] != "issued" || recovered["permit"] == nil {
		t.Fatalf("same-request signing recovery did not issue original permit: %d %v", status, recovered)
	}
	if recovered["sponsorshipId"] != waiting["sponsorshipId"] || recovered["reservationId"] != waiting["reservationId"] {
		t.Fatalf("recovery created new logical reservation: %v", recovered)
	}
	_, budgets := request(t, h2, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
	a := budgets["accountBudget"].(map[string]any)
	if a["reservedRiskNative"] != "40" || a["availableNative"] != "60" {
		t.Fatalf("recovery double-reserved: %v", a)
	}
}

func TestPostgresLoginArtifactsCannotCrossServiceAudience(t *testing.T) {
	for _, realm := range []string{"domain", "uri", "project", "chain"} {
		t.Run(realm, func(t *testing.T) {
			c := postgresConfig(t)
			h1 := wallet.New(c)
			token, _, _ := signIn(t, h1, "00000001")
			_, challenge := request(t, h1, "POST", "/v1/auth/challenges", `{"schemaVersion":"1","idempotencyKey":"unused_challenge_001","chainId":"421614","account":"`+accountA+`"}`, "")
			key, _ := crypto.HexToECDSA("0123456789012345678901234567890123456789012345678901234567890123")
			sig, _ := crypto.Sign(accounts.TextHash([]byte(challenge["message"].(string))), key)
			sig[64] += 27
			oldProof := map[string]any{"schemaVersion": "1", "idempotencyKey": "new_realm_session_001", "challengeId": challenge["challengeId"], "signatureScheme": "root-eip191-65", "signature": "0x" + hex.EncodeToString(sig)}
			changed := c
			switch realm {
			case "domain":
				changed.Domain = "another.wallet.example"
				changed.URI = "https://another.wallet.example"
			case "uri":
				changed.URI = "https://wallet.local/different-audience"
			case "project":
				changed.ProjectID = "another_project_0001"
			case "chain":
				raw, _ := json.Marshal(c.Manifest)
				changed.Manifest = nil
				_ = json.Unmarshal(raw, &changed.Manifest)
				changed.Manifest["chainId"] = "31337"
			}
			h2 := wallet.New(changed)
			t.Run("bearer", func(t *testing.T) {
				status, out := request(t, h2, "GET", "/v1/budgets?chainId="+changed.Manifest["chainId"].(string)+"&period=test-period", "", token)
				if status != 401 || out["error"].(map[string]any)["code"] != "AUTH_REQUIRED" {
					t.Fatalf("old bearer accepted by another %s: status=%d", realm, status)
				}
			})
			t.Run("challenge", func(t *testing.T) {
				status, out := request(t, h2, "POST", "/v1/auth/sessions", body(oldProof), "")
				if status != 403 || out["error"].(map[string]any)["code"] != "AUTH_SCOPE_MISMATCH" {
					t.Fatalf("old challenge accepted by another %s: status=%d", realm, status)
				}
			})
		})
	}
}
