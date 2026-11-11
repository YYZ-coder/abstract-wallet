package sponsorship_test

import (
	wallet "abstract-wallet/services/sponsorship"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const accountA = "0x14791697260e4c9a71f18484c9f997b308e59325"
const ep = "0x2222222222222222222222222222222222222222"
const delegate = "0x3333333333333333333333333333333333333333"
const pm = "0x4444444444444444444444444444444444444444"

func sponsorConfig(t *testing.T) wallet.Config {
	t.Helper()
	c := config()
	c.PerUserBudgetWei = "100"
	c.ChainBudgetWei = "100"
	c.MaxSponsorCostWei = "100"
	c.Period = "test-period"
	c.SponsorPrivateKey = "1123456789012345678901234567890123456789012345678901234567890123"
	c.SponsorAllowedAccounts = []string{accountA}
	for k, a := range map[string]string{"entryPoint": ep, "delegate": delegate, "paymaster": pm} {
		c.Manifest[k] = map[string]any{"address": a, "runtimeCodeHash": crypto.Keccak256Hash([]byte{0x00}).Hex(), "version": "v1", "verified": false}
	}
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
			if q["params"].([]any)[0] != accountA {
				result = "0x00"
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": q["id"], "result": result})
	}))
	t.Cleanup(rpc.Close)
	c.RPCURL = rpc.URL
	return c
}
func operation(t *testing.T) map[string]any {
	t.Helper()
	a, e := abi.JSON(strings.NewReader(`[{"type":"function","name":"executeBatch","inputs":[{"name":"calls","type":"tuple[]","components":[{"name":"target","type":"address"},{"name":"value","type":"uint256"},{"name":"data","type":"bytes"}]}]}]`))
	if e != nil {
		t.Fatal(e)
	}
	type Call struct {
		Target common.Address
		Value  *big.Int
		Data   []byte
	}
	data, e := a.Pack("executeBatch", []Call{{common.HexToAddress(accountA), big.NewInt(0), []byte{}}})
	if e != nil {
		t.Fatal(e)
	}
	return map[string]any{"sender": accountA, "nonce": "0", "factory": "0x7702", "factoryData": "0x", "callData": fmt.Sprintf("0x%x", data), "callGasLimit": "10", "verificationGasLimit": "10", "preVerificationGas": "10", "maxFeePerGas": "1", "maxPriorityFeePerGas": "1", "paymaster": pm, "paymasterVerificationGasLimit": "10", "paymasterPostOpGasLimit": "0"}
}
func sponsorBody(t *testing.T, key string) map[string]any {
	return map[string]any{"schemaVersion": "1", "idempotencyKey": key, "manifestVersion": "arb-sepolia-mvp-v1", "chainId": "421614", "entryPoint": ep, "account": accountA, "expectedDelegate": delegate, "unsignedUserOperation": operation(t), "authorizationContext": map[string]any{"chainId": "421614", "address": delegate, "nonce": "0", "eip7702Auth": nil}, "accountWindow": map[string]any{"validAfter": "1799999999", "validUntil": "1800000200"}, "maxCost": "40"}
}
func body(v any) string { b, _ := json.Marshal(v); return string(b) }
func TestSponsorshipQuoteThenPermitReservesBudgetOnce(t *testing.T) {
	h := wallet.New(sponsorConfig(t))
	token, _, _ := signIn(t, h, "00000001")
	b := sponsorBody(t, "sponsor_prepare_0001")
	status, quote := request(t, h, "POST", "/v1/sponsorships/prepare", body(b), token)
	if status != 201 {
		t.Fatalf("quote status=%d data=%v", status, quote)
	}
	status, budget := request(t, h, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
	if status != 200 || budget["accountBudget"].(map[string]any)["availableNative"] != "100" {
		t.Fatalf("quote reserved budget: %d %v", status, budget)
	}
	b["idempotencyKey"] = "sponsor_create_00001"
	b["quoteId"] = quote["quoteId"]
	status, permit := request(t, h, "POST", "/v1/sponsorships", body(b), token)
	if status != 201 {
		t.Fatalf("permit=%d %v", status, permit)
	}
	p := permit["permit"].(map[string]any)
	if p["maxCost"] != "40" || len(p["paymasterData"].(string)) != 706 {
		t.Fatalf("bad permit data %v", p)
	}
	status, _ = request(t, h, "POST", "/v1/sponsorships", body(b), token)
	if status != 200 {
		t.Fatalf("retry status=%d", status)
	}
	_, budget = request(t, h, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
	ledger := budget["accountBudget"].(map[string]any)
	if ledger["availableNative"] != "60" || ledger["reservedRiskNative"] != "40" {
		t.Fatalf("budget=%v, want risk40 available60", budget)
	}
}

func TestQuoteStubHasCanonicalButUnsignablePaymasterEnvelope(t *testing.T) {
	h := wallet.New(sponsorConfig(t))
	token, _, _ := signIn(t, h, "00000001")
	status, q := request(t, h, "POST", "/v1/sponsorships/prepare", body(sponsorBody(t, "stub_prepare_000001")), token)
	if status != 201 {
		t.Fatalf("quote=%d %v", status, q)
	}
	raw, _ := hex.DecodeString(strings.TrimPrefix(q["stubPaymasterData"].(string), "0x"))
	if len(raw) != 352 || raw[31] != 1 {
		t.Fatalf("stub has malformed version/length: len=%d version=%d", len(raw), raw[31])
	}
	if raw[223] != 224 || raw[255] != 65 || raw[320] != 27 {
		t.Fatalf("stub offset/length/v malformed: %d/%d/%d", raw[223], raw[255], raw[320])
	}
	for _, b := range raw[256:320] {
		if b != 0 {
			t.Fatal("stub must not contain an executable signature")
		}
	}
	if q["stubIsExecutable"] != false {
		t.Fatal("stub advertised executable")
	}
}

func TestIssuedPermitQuoteExpiryDoesNotReleaseBudget(t *testing.T) {
	now := int64(1800000000)
	c := sponsorConfig(t)
	c.Clock = func() time.Time { return time.Unix(now, 0) }
	h := wallet.New(c)
	token, _, _ := signIn(t, h, "00000001")
	status, issued := reserve(t, h, token, "expiry_0000001")
	if status != 201 {
		t.Fatalf("issue=%d %v", status, issued)
	}
	now += 61
	status, view := request(t, h, "GET", "/v1/sponsorships/"+issued["sponsorshipId"].(string), "", token)
	if status != 200 || view["quoteState"] != "expired" || view["serverTime"] != "1800000061" {
		t.Fatalf("stale quote view=%d %v", status, view)
	}
	if view["state"] != "issued" || view["permit"] == nil {
		t.Fatalf("quote expiry revoked existing permit incorrectly: %v", view)
	}
	_, b := request(t, h, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
	if b["accountBudget"].(map[string]any)["availableNative"] != "60" {
		t.Fatalf("quote expiry released executable risk: %v", b)
	}
}
