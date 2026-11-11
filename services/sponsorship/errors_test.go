package sponsorship_test

import (
	wallet "abstract-wallet/services/sponsorship"
	"strconv"
	"testing"
)

func TestRejectedSponsorshipReturnsTheContractRecoveryAction(t *testing.T) {
	for _, test := range []struct {
		name, code, action string
		status             int
		change             func(*wallet.Config, map[string]any)
	}{
		{"policy", "SPONSORSHIP_DENIED", "CHOOSE_SELF_PAY", 403, func(c *wallet.Config, b map[string]any) { c.SponsorPrivateKey = "" }},
		{"cost", "COST_CAP_EXCEEDED", "REPREPARE", 422, func(c *wallet.Config, b map[string]any) { b["maxCost"] = "1" }},
		{"window", "INVALID_TIME_WINDOW", "FIX_REQUEST", 422, func(c *wallet.Config, b map[string]any) {
			b["accountWindow"].(map[string]any)["validUntil"] = "1799999999"
		}},
		{"configuration", "MANIFEST_CHANGED", "REFRESH_CONFIGURATION", 409, func(c *wallet.Config, b map[string]any) { b["manifestVersion"] = "different-version" }},
		{"call", "INVALID_OPERATION", "FIX_REQUEST", 422, func(c *wallet.Config, b map[string]any) {
			b["unsignedUserOperation"].(map[string]any)["callData"] = "0x"
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			c := sponsorConfig(t)
			b := sponsorBody(t, "denied_request_0001")
			test.change(&c, b)
			h := wallet.New(c)
			token, _, _ := signIn(t, h, "00000001")
			status, result := request(t, h, "POST", "/v1/sponsorships/prepare", body(b), token)
			if status != test.status {
				t.Fatalf("status=%d result=%v", status, result)
			}
			e := result["error"].(map[string]any)
			if e["code"] != test.code || e["requiredAction"] != test.action || e["retryable"] != false {
				t.Fatalf("contract recovery mismatch: got=%v want code=%s action=%s retryable=false", e, test.code, test.action)
			}
			_, budgets := request(t, h, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
			if budgets["accountBudget"].(map[string]any)["availableNative"] != "100" {
				t.Fatalf("rejected request reserved budget: %v", budgets)
			}
		})
	}
}

func TestUnauthenticatedHTTPRequestsHaveABoundedRate(t *testing.T) {
	c := config()
	c.RequestsPerMinute = 2
	h := wallet.New(c)
	for i := 0; i < 2; i++ {
		status, result := request(t, h, "POST", "/v1/auth/challenges", `{"schemaVersion":"1","idempotencyKey":"rate_challenge_000`+strconv.Itoa(i)+`","chainId":"421614","account":"`+accountA+`"}`, "")
		if status != 201 {
			t.Fatalf("allowed request=%d %v", status, result)
		}
	}
	status, result := request(t, h, "POST", "/v1/auth/challenges", `{"schemaVersion":"1","idempotencyKey":"rate_challenge_0002","chainId":"421614","account":"`+accountA+`"}`, "")
	if status != 429 {
		t.Fatalf("unbounded requests status=%d want429 result=%v", status, result)
	}
	e := result["error"].(map[string]any)
	if e["code"] != "RATE_LIMITED" || e["retryable"] != true || e["requiredAction"] != "WAIT_AND_RETRY_SAME_REQUEST" {
		t.Fatalf("rate recovery=%v", e)
	}
}
