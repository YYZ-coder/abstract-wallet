package sponsorship_test

import (
	wallet "abstract-wallet/services/sponsorship"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/crypto"
)

// Public fixture keys 9 and 10; addresses fixed independently using viem 2.57.17.
const accessAccountB = "0xf7edc8fa1ecc32967f827c9043fcae6ba73afa5c"
const accessAccountC = "0x4cceba2d7d2b4fdce4304d3e09a1fea9fbeb1528"

func accessConfig(t *testing.T) wallet.Config {
	t.Helper()
	c := sponsorConfig(t)
	c.SponsorAccountPolicy = "authenticated"
	c.SponsorAllowedAccounts = nil
	rpc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var q map[string]any
		_ = json.NewDecoder(r.Body).Decode(&q)
		result := "0x"
		switch q["method"] {
		case "eth_chainId":
			result = "0x66eee"
		case "eth_getTransactionCount":
			result = "0x0"
		case "eth_getCode":
			address := q["params"].([]any)[0]
			if address == ep || address == delegate || address == pm {
				result = "0x00"
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": q["id"], "result": result})
	}))
	t.Cleanup(rpc.Close)
	c.RPCURL = rpc.URL
	return c
}

func accessSignIn(t *testing.T, h http.Handler, address string, fixtureKey int, suffix string) string {
	t.Helper()
	status, ch := request(t, h, "POST", "/v1/auth/challenges", body(map[string]any{"schemaVersion": "1", "idempotencyKey": "access_challenge_" + suffix, "chainId": "421614", "account": address}), "")
	if status != 201 {
		t.Fatalf("challenge=%d %v", status, ch)
	}
	key, err := crypto.HexToECDSA(fmt.Sprintf("%064x", fixtureKey))
	if err != nil {
		t.Fatal(err)
	}
	sig, err := crypto.Sign(accounts.TextHash([]byte(ch["message"].(string))), key)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27
	status, session := request(t, h, "POST", "/v1/auth/sessions", body(map[string]any{"schemaVersion": "1", "idempotencyKey": "access_session_" + suffix, "challengeId": ch["challengeId"], "signatureScheme": "root-eip191-65", "signature": "0x" + hex.EncodeToString(sig)}), "")
	if status != 201 || session["account"] != address {
		t.Fatalf("session=%d %v", status, session)
	}
	return session["accessToken"].(string)
}

func accessBody(t *testing.T, address, key string) map[string]any {
	t.Helper()
	b := sponsorBody(t, key)
	b["account"] = address
	b["unsignedUserOperation"].(map[string]any)["sender"] = address
	return b
}

func accessReserve(t *testing.T, h http.Handler, address, token, suffix string) (int, map[string]any) {
	t.Helper()
	b := accessBody(t, address, "access_prepare_"+suffix)
	status, quote := request(t, h, "POST", "/v1/sponsorships/prepare", body(b), token)
	if status != 201 {
		t.Fatalf("quote=%d %v", status, quote)
	}
	b["quoteId"] = quote["quoteId"]
	b["idempotencyKey"] = "access_reserve_" + suffix
	return request(t, h, "POST", "/v1/sponsorships", body(b), token)
}

func TestAuthenticatedPolicyIssuesPermitForAccountOutsideAllowlist(t *testing.T) {
	h := wallet.New(accessConfig(t))
	token := accessSignIn(t, h, accessAccountB, 9, "nonlisted_0001")
	status, issued := accessReserve(t, h, accessAccountB, token, "nonlisted_0001")
	if status != 201 || issued["state"] != "issued" {
		t.Fatalf("nonlisted authenticated account denied: %d %v", status, issued)
	}
	permit := issued["permit"].(map[string]any)
	if permit["sender"] != accessAccountB || permit["maxCost"] != "40" {
		t.Fatalf("permit does not bind authenticated account and finite limit: %v", permit)
	}
	status, budgets := request(t, h, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
	if status != 200 {
		t.Fatalf("budget=%d %v", status, budgets)
	}
	for _, scope := range []string{"accountBudget", "chainBudget"} {
		b := budgets[scope].(map[string]any)
		if b["reservedRiskNative"] != "40" || b["availableNative"] != "60" {
			t.Fatalf("%s did not retain finite reservation: %v", scope, b)
		}
	}
}

func TestUnknownSponsorPolicyRejectsEvenAnAllowlistedAccount(t *testing.T) {
	c := accessConfig(t)
	c.SponsorAccountPolicy = "public"
	c.SponsorAllowedAccounts = []string{accessAccountB}
	h := wallet.New(c)
	token := accessSignIn(t, h, accessAccountB, 9, "unknown_policy_0001")
	status, out := request(t, h, "POST", "/v1/sponsorships/prepare", body(accessBody(t, accessAccountB, "unknown_policy_quote_001")), token)
	if status != 403 || out["error"].(map[string]any)["code"] != "SPONSORSHIP_DENIED" {
		t.Fatalf("unknown policy must deny rather than inherit allowlist: %d %v", status, out)
	}
}

func TestAuthenticatedPolicyRequiresExplicitPositiveFiniteBudgets(t *testing.T) {
	for _, field := range []string{"account", "chain", "per-operation"} {
		for _, value := range []string{"", "0", "-1", "unlimited", "1" + strings.Repeat("0", 78)} {
			t.Run(field+"/"+value, func(t *testing.T) {
				c := accessConfig(t)
				switch field {
				case "account":
					c.PerUserBudgetWei = value
				case "chain":
					c.ChainBudgetWei = value
				case "per-operation":
					c.MaxSponsorCostWei = value
				}
				h := wallet.New(c)
				token := accessSignIn(t, h, accessAccountB, 9, "budget_policy_0001")
				status, out := request(t, h, "POST", "/v1/sponsorships/prepare", body(accessBody(t, accessAccountB, "budget_policy_quote_001")), token)
				if status != 403 || out["error"].(map[string]any)["code"] != "SPONSORSHIP_DENIED" {
					t.Fatalf("policy with nonpositive/nonfinite %s budget accepted: status=%d", field, status)
				}
			})
		}
	}
}

func TestPostgresAuthenticatedAccountsCompeteWithinOneFiniteChainBudget(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set: real PostgreSQL not executed")
	}
	namespace := fmt.Sprintf("access-policy-%d", time.Now().UnixNano())
	stateKey := []byte(strings.Repeat("a", 32))
	firstStore, err := wallet.OpenPostgres(context.Background(), url, stateKey, namespace)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(firstStore.Close)
	secondStore, err := wallet.OpenPostgres(context.Background(), url, stateKey, namespace)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(secondStore.Close)
	c := accessConfig(t)
	c.Store = firstStore
	c.ChainBudgetWei = "60"
	other := c
	other.Store = secondStore
	h1, h2 := wallet.New(c), wallet.New(other)
	tokens := []string{accessSignIn(t, h1, accessAccountB, 9, "postgres_b_0001"), accessSignIn(t, h1, accessAccountC, 10, "postgres_c_0001")}
	addresses := []string{accessAccountB, accessAccountC}
	bodies := []map[string]any{}
	for i, address := range addresses {
		b := accessBody(t, address, fmt.Sprintf("chain_race_quote_%02d", i))
		status, quote := request(t, h1, "POST", "/v1/sponsorships/prepare", body(b), tokens[i])
		if status != 201 {
			t.Fatalf("quote=%d %v", status, quote)
		}
		b["quoteId"] = quote["quoteId"]
		b["idempotencyKey"] = fmt.Sprintf("chain_race_reserve_%02d", i)
		bodies = append(bodies, b)
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
			status, data := request(t, h, "POST", "/v1/sponsorships", body(bodies[i]), tokens[i])
			results <- result{status, data}
		}(i, h)
	}
	close(start)
	issued, denied := 0, 0
	for range 2 {
		r := <-results
		switch r.status {
		case 201:
			if r.data["state"] != "issued" || r.data["permit"] == nil {
				t.Fatalf("unsigned issue=%v", r.data)
			}
			issued++
		case 409:
			if r.data["error"].(map[string]any)["code"] != "BUDGET_EXCEEDED" {
				t.Fatalf("denied=%v", r.data)
			}
			denied++
		default:
			t.Fatalf("unexpected status=%d %v", r.status, r.data)
		}
	}
	if issued != 1 || denied != 1 {
		t.Fatalf("issued=%d denied=%d, want 1/1", issued, denied)
	}
	accountRiskSum := int64(0)
	for i, token := range tokens {
		status, budgets := request(t, h2, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
		if status != 200 {
			t.Fatalf("persisted session %d=%d", i, status)
		}
		chain := budgets["chainBudget"].(map[string]any)
		if chain["reservedRiskNative"] != "40" || chain["availableNative"] != "20" {
			t.Fatalf("chain over-reserved across accounts: %v", chain)
		}
		account := budgets["accountBudget"].(map[string]any)
		if account["reservedRiskNative"] == "40" && account["availableNative"] == "60" {
			accountRiskSum += 40
		} else if account["reservedRiskNative"] != "0" || account["availableNative"] != "100" {
			t.Fatalf("per-account isolation failed: %v", account)
		}
	}
	if accountRiskSum != 40 {
		t.Fatalf("sum of account reservations=%d, want40", accountRiskSum)
	}
}

func TestSponsorPolicyDefaultsRemainAllowlistScoped(t *testing.T) {
	for _, policy := range []string{"", "allowlist"} {
		for _, listed := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/listed=%t", policy, listed), func(t *testing.T) {
				c := accessConfig(t)
				c.SponsorAccountPolicy = policy
				if listed {
					c.SponsorAllowedAccounts = []string{accessAccountB}
				}
				h := wallet.New(c)
				token := accessSignIn(t, h, accessAccountB, 9, "default_scope_0001")
				status, out := request(t, h, "POST", "/v1/sponsorships/prepare", body(accessBody(t, accessAccountB, "default_scope_quote_001")), token)
				if listed {
					if status != 201 {
						t.Fatalf("listed account denied=%d %v", status, out)
					}
				} else if status != 403 || out["error"].(map[string]any)["code"] != "SPONSORSHIP_DENIED" {
					t.Fatalf("default expanded account eligibility=%d %v", status, out)
				}
			})
		}
	}
}

func TestAuthenticatedPolicyPreservesSessionScopeAndDeploymentChecks(t *testing.T) {
	for _, scenario := range []string{"missing_session", "other_account", "other_chain", "deployment_hash"} {
		t.Run(scenario, func(t *testing.T) {
			c := accessConfig(t)
			if scenario == "deployment_hash" {
				c.Manifest["delegate"].(map[string]any)["runtimeCodeHash"] = "0x" + strings.Repeat("0", 64)
			}
			h := wallet.New(c)
			token := accessSignIn(t, h, accessAccountB, 9, "protected_scope_001")
			b := accessBody(t, accessAccountB, "protected_scope_quote_001")
			wantStatus, wantCode := 401, "AUTH_REQUIRED"
			switch scenario {
			case "missing_session":
				token = ""
			case "other_account":
				b["account"] = accessAccountC
				b["unsignedUserOperation"].(map[string]any)["sender"] = accessAccountC
				wantStatus, wantCode = 403, "AUTH_SCOPE_MISMATCH"
			case "other_chain":
				b["chainId"] = "56"
				wantStatus, wantCode = 403, "AUTH_SCOPE_MISMATCH"
			case "deployment_hash":
				wantStatus, wantCode = 422, "DEPLOYMENT_MISMATCH"
			}
			status, out := request(t, h, "POST", "/v1/sponsorships/prepare", body(b), token)
			if status != wantStatus || out["error"].(map[string]any)["code"] != wantCode {
				t.Fatalf("guard lost for %s: %d %v", scenario, status, out)
			}
		})
	}
}
