package sponsorship_test

import (
	wallet "abstract-wallet/services/sponsorship"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTestFundsDisabledByDefault(t *testing.T) {
	status, out := request(t, wallet.New(config()), "POST", "/v1/test-funds/claims", `{"schemaVersion":"1","chainId":"421614","address":"0x1111111111111111111111111111111111111111","idempotencyKey":"test_funds_disabled"}`, "")
	if status != 503 || errorCode(out) != "FAUCET_UNAVAILABLE" {
		t.Fatalf("disabled faucet=%d %v want503 FAUCET_UNAVAILABLE", status, out)
	}
}
func errorCode(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	code, _ := e["code"].(string)
	return code
}

func TestTestFundsRejectsMalformedRequestsAndUnsupportedChain(t *testing.T) {
	for _, tc := range []struct {
		name, payload, code string
		status              int
	}{
		{"body", `{`, "INVALID_REQUEST", 400},
		{"version", `{"schemaVersion":"2","chainId":"421614","address":"0x1111111111111111111111111111111111111111","idempotencyKey":"valid_key_001"}`, "INVALID_REQUEST", 400},
		{"numericchain", `{"schemaVersion":"1","chainId":421614,"address":"0x1111111111111111111111111111111111111111","idempotencyKey":"valid_key_001"}`, "INVALID_REQUEST", 400},
		{"chain", `{"schemaVersion":"1","chainId":"1","address":"0x1111111111111111111111111111111111111111","idempotencyKey":"valid_key_001"}`, "UNSUPPORTED_CHAIN", 422},
		{"address", `{"schemaVersion":"1","chainId":"421614","address":"0x123","idempotencyKey":"valid_key_001"}`, "INVALID_REQUEST", 400},
		{"zero", `{"schemaVersion":"1","chainId":"421614","address":"0x0000000000000000000000000000000000000000","idempotencyKey":"valid_key_001"}`, "INVALID_REQUEST", 400},
		{"emptykey", `{"schemaVersion":"1","chainId":"421614","address":"0x1111111111111111111111111111111111111111","idempotencyKey":""}`, "INVALID_REQUEST", 400},
		{"extra", `{"schemaVersion":"1","chainId":"421614","address":"0x1111111111111111111111111111111111111111","idempotencyKey":"valid_key_001","amountWei":"999"}`, "INVALID_REQUEST", 400},
		{"duplicate", `{"schemaVersion":"1","chainId":"1","chainId":"421614","address":"0x1111111111111111111111111111111111111111","idempotencyKey":"valid_key_001"}`, "INVALID_REQUEST", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, out := request(t, wallet.New(config()), "POST", "/v1/test-funds/claims", tc.payload, "")
			if status != tc.status || errorCode(out) != tc.code {
				t.Fatalf("request rejection=%d %v want%d %s", status, out, tc.status, tc.code)
			}
		})
	}
}

func faucetBody(address, key string) string {
	return `{"schemaVersion":"1","chainId":"421614","address":"` + address + `","idempotencyKey":"` + key + `"}`
}
func faucetConfig() wallet.Config {
	c := config()
	c.FaucetPrivateKey = "0000000000000000000000000000000000000000000000000000000000000001"
	return c
}
func TestTestFundsCreatesUnauthenticatedIdempotentClaim(t *testing.T) {
	h := wallet.New(faucetConfig())
	st, out := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0xAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCdAbCd", "faucet_claim_0001"), "")
	if st != 202 || out["chainId"] != "421614" || out["address"] != "0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd" || out["amountWei"] != "1000000000000000" || out["status"] != "pending" || out["schemaVersion"] != "1" {
		t.Fatalf("new unauthenticated claim=%d %v", st, out)
	}
	id, _ := out["claimId"].(string)
	if len(id) != 32 || out["requestId"] == nil {
		t.Fatalf("claim identifiers=%v", out)
	}
	st, retry := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd", "faucet_claim_0001"), "")
	if st != 200 || retry["claimId"] != id {
		t.Fatalf("same request=%d %v original=%v", st, retry, out)
	}
	st, changed := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x2222222222222222222222222222222222222222", "faucet_claim_0001"), "")
	if st != 409 || errorCode(changed) != "IDEMPOTENCY_CONFLICT" {
		t.Fatalf("changed input=%d %v", st, changed)
	}
	for _, secret := range []string{"raw", "rawTx", "privateKey", "idempotencyKey"} {
		if _, ok := out[secret]; ok {
			t.Fatalf("private field %s exposed", secret)
		}
	}
}

func TestTestFundsInvalidConfigAndSharedRoleKeysFailClosed(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*wallet.Config)
	}{
		{"invalidkey", func(c *wallet.Config) { c.FaucetPrivateKey = "invalid" }},
		{"sponsorkey", func(c *wallet.Config) { c.SponsorPrivateKey = "0x" + c.FaucetPrivateKey }},
		{"relaykey", func(c *wallet.Config) { c.RelayPrivateKey = c.FaucetPrivateKey }},
		{"smallamount", func(c *wallet.Config) { c.FaucetAmountWei = "1" }},
		{"largeamount", func(c *wallet.Config) { c.FaucetAmountWei = "1000000000000001" }},
		{"invalidamount", func(c *wallet.Config) { c.FaucetAmountWei = "1e15" }},
		{"zerobudget", func(c *wallet.Config) { c.FaucetDailyBudgetWei = "0" }},
		{"largebudget", func(c *wallet.Config) { c.FaucetDailyBudgetWei = "10000000000000001" }},
		{"invalidbudget", func(c *wallet.Config) { c.FaucetDailyBudgetWei = "-1" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := faucetConfig()
			tc.change(&c)
			st, out := request(t, wallet.New(c), "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "invalid_config_01"), "")
			if st != 503 || errorCode(out) != "FAUCET_UNAVAILABLE" {
				t.Fatalf("unsafe configuration accepted=%d %v", st, out)
			}
		})
	}
}

func TestTestFundsAddressRollingCooldownAndUTCGlobalBudget(t *testing.T) {
	t.Run("rolling24hours", func(t *testing.T) {
		now := time.Date(2026, 11, 11, 23, 30, 0, 0, time.UTC)
		c := faucetConfig()
		c.Clock = func() time.Time { return now }
		h := wallet.New(c)
		st, first := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "cooldown_first_001"), "")
		if st != 202 {
			t.Fatalf("first=%d %v", st, first)
		}
		now = now.Add(24*time.Hour - time.Second)
		st, out := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "cooldown_second_002"), "")
		if st != 429 || errorCode(out) != "FAUCET_COOLDOWN" {
			t.Fatalf("23h59m59s=%d %v want cooldown", st, out)
		}
		now = now.Add(time.Second)
		st, out = request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "cooldown_third_003"), "")
		if st != 202 || out["claimId"] == first["claimId"] {
			t.Fatalf("24h=%d %v", st, out)
		}
	})
	t.Run("UTCDailyBudget", func(t *testing.T) {
		now := time.Date(2026, 11, 11, 23, 59, 0, 0, time.UTC)
		c := faucetConfig()
		c.Clock = func() time.Time { return now }
		h := wallet.New(c)
		for i := 1; i <= 11; i++ {
			st, out := request(t, h, "POST", "/v1/test-funds/claims", faucetBody(fmt.Sprintf("0x%040x", i), fmt.Sprintf("daily_claim_%04d", i)), "")
			if i <= 10 && st != 202 {
				t.Fatalf("claim%d=%d %v", i, st, out)
			}
			if i == 11 && (st != 429 || errorCode(out) != "FAUCET_BUDGET_EXCEEDED") {
				t.Fatalf("eleventh claim=%d %v", st, out)
			}
		}
		now = now.Add(time.Minute)
		st, out := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x2222222222222222222222222222222222222222", "daily_nextday_001"), "")
		if st != 202 {
			t.Fatalf("new UTC day=%d %v", st, out)
		}
	})
}

func TestTestFundsStatusIsPublicAndUnknownClaimIsExplicit(t *testing.T) {
	h := wallet.New(faucetConfig())
	_, first := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "query_claim_00001"), "")
	id := first["claimId"].(string)
	st, out := request(t, h, "GET", "/v1/test-funds/claims/"+id, "", "")
	if st != 200 || out["claimId"] != id || out["address"] != "0x1111111111111111111111111111111111111111" || out["status"] != "pending" {
		t.Fatalf("query claim=%d %v", st, out)
	}
	for _, secret := range []string{"raw", "rawTx", "privateKey", "idempotencyKey", "createdAt"} {
		if _, ok := out[secret]; ok {
			t.Fatalf("private field %s exposed", secret)
		}
	}
	st, out = request(t, h, "GET", "/v1/test-funds/claims/00000000000000000000000000000000", "", "")
	if st != 404 || errorCode(out) != "RESOURCE_NOT_FOUND" {
		t.Fatalf("unknown claim=%d %v", st, out)
	}
	st, out = request(t, h, "GET", "/v1/test-funds/claims/not-a-claim", "", "")
	if st != 400 || errorCode(out) != "INVALID_REQUEST" {
		t.Fatalf("invalid identifier=%d %v", st, out)
	}
}

func faucetRPC(t *testing.T, override func(string, []any) (any, bool)) string {
	t.Helper()
	rpc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var q map[string]any
		if e := json.NewDecoder(r.Body).Decode(&q); e != nil {
			t.Error(e)
			return
		}
		method := q["method"].(string)
		params, _ := q["params"].([]any)
		var result any
		if v, ok := override(method, params); ok {
			result = v
		} else {
			switch method {
			case "eth_chainId":
				result = "0x66eee"
			case "eth_getCode":
				result = "0x"
			case "eth_getBalance":
				result = "0xde0b6b3a7640000"
			case "eth_getTransactionCount":
				result = "0x7"
			case "eth_gasPrice":
				result = "0x1"
			case "eth_estimateGas":
				result = "0x5208"
			case "eth_getTransactionReceipt", "eth_getTransactionByHash":
				result = nil
			default:
				t.Errorf("unexpected fixture RPC %s", method)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": q["id"], "result": result})
	}))
	t.Cleanup(rpc.Close)
	return rpc.URL
}
func TestTestFundsPreflightRejectsWrongChainDelegatedSenderAndEmptyPool(t *testing.T) {
	for _, tc := range []struct {
		name, method string
		result       any
		code         string
	}{
		{"wrongchain", "eth_chainId", "0x1", "FAUCET_UNAVAILABLE"},
		{"delegatedsender", "eth_getCode", "0xef01001111111111111111111111111111111111111111", "FAUCET_UNAVAILABLE"},
		{"empty", "eth_getBalance", "0x0", "FAUCET_EMPTY"},
		{"invalidbalance", "eth_getBalance", "0xzz", "UPSTREAM_UNAVAILABLE"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := faucetConfig()
			c.RPCURL = faucetRPC(t, func(method string, _ []any) (any, bool) { return tc.result, method == tc.method })
			st, out := request(t, wallet.New(c), "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "preflight_claim_001"), "")
			if st != 503 || errorCode(out) != tc.code {
				t.Fatalf("unsafe preflight=%d %v want503 %s", st, out, tc.code)
			}
		})
	}
}

func TestTestFundsBroadcastsOrdinaryArbitrumEOATransfer(t *testing.T) {
	var transaction *types.Transaction
	var mu sync.Mutex
	c := faucetConfig()
	c.RPCURL = faucetRPC(t, func(method string, params []any) (any, bool) {
		if method != "eth_sendRawTransaction" {
			return nil, false
		}
		raw, e := hex.DecodeString(strings.TrimPrefix(params[0].(string), "0x"))
		if e != nil {
			t.Error(e)
		}
		tx := new(types.Transaction)
		if e = tx.UnmarshalBinary(raw); e != nil {
			t.Error(e)
		}
		mu.Lock()
		transaction = tx
		mu.Unlock()
		return tx.Hash().Hex(), true
	})
	st, out := request(t, wallet.New(c), "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "ordinary_transfer_001"), "")
	mu.Lock()
	defer mu.Unlock()
	if st != 202 || out["status"] != "submitted" || transaction == nil {
		t.Fatalf("funding submission=%d %v transaction=%v", st, out, transaction)
	}
	if transaction.Type() != types.LegacyTxType || transaction.ChainId().String() != "421614" || transaction.Nonce() != 7 || transaction.To() == nil || *transaction.To() != common.HexToAddress("0x1111111111111111111111111111111111111111") || transaction.Value().String() != "1000000000000000" || len(transaction.Data()) != 0 || transaction.Gas() != 21000 {
		t.Fatalf("unsafe transfer transaction=%v", transaction)
	}
	from, e := types.Sender(types.LatestSignerForChainID(big.NewInt(421614)), transaction)
	if e != nil || strings.ToLower(from.Hex()) != "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf" || out["transactionHash"] != strings.ToLower(transaction.Hash().Hex()) {
		t.Fatalf("sender/hash incorrect: %v %v %v", from, e, out)
	}
	if _, leak := out["raw"]; leak {
		t.Fatalf("signed raw leaked: %v", out)
	}
}

func TestTestFundsPendingReservationsCannotOvercommitPoolBalance(t *testing.T) {
	c := faucetConfig()
	c.RPCURL = faucetRPC(t, func(method string, params []any) (any, bool) {
		if method == "eth_getBalance" {
			return "0x38d7ea4c72410", true
		}
		if method == "eth_sendRawTransaction" {
			raw, _ := hex.DecodeString(strings.TrimPrefix(params[0].(string), "0x"))
			tx := new(types.Transaction)
			_ = tx.UnmarshalBinary(raw)
			return tx.Hash().Hex(), true
		}
		return nil, false
	})
	h := wallet.New(c)
	st, out := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "liquidity_first_001"), "")
	if st != 202 || out["status"] != "submitted" {
		t.Fatalf("first exact funded transfer=%d %v", st, out)
	}
	st, out = request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x2222222222222222222222222222222222222222", "liquidity_second_002"), "")
	if st != 503 || errorCode(out) != "FAUCET_EMPTY" {
		t.Fatalf("unmined reservation overcommitted pool=%d %v", st, out)
	}
}

func minedFaucetRPC(t *testing.T, change func(string, map[string]any)) string {
	t.Helper()
	var mu sync.Mutex
	hash := ""
	return faucetRPC(t, func(method string, params []any) (any, bool) {
		mu.Lock()
		defer mu.Unlock()
		switch method {
		case "eth_sendRawTransaction":
			raw, _ := hex.DecodeString(strings.TrimPrefix(params[0].(string), "0x"))
			tx := new(types.Transaction)
			if e := tx.UnmarshalBinary(raw); e != nil {
				t.Error(e)
			}
			hash = strings.ToLower(tx.Hash().Hex())
			return hash, true
		case "eth_getTransactionReceipt":
			receipt := map[string]any{"transactionHash": hash, "status": "0x1", "blockNumber": "0x64", "blockHash": "0x" + strings.Repeat("a", 64), "from": "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf", "to": "0x1111111111111111111111111111111111111111"}
			if change != nil {
				change(method, receipt)
			}
			return receipt, true
		case "eth_getTransactionByHash":
			tx := map[string]any{"hash": hash, "from": "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf", "to": "0x1111111111111111111111111111111111111111", "value": "0x38d7ea4c68000", "chainId": "0x66eee", "nonce": "0x7", "input": "0x", "blockNumber": "0x64", "blockHash": "0x" + strings.Repeat("a", 64)}
			if change != nil {
				change(method, tx)
			}
			return tx, true
		case "eth_getBlockByNumber":
			block := map[string]any{"number": "0x64", "hash": "0x" + strings.Repeat("a", 64)}
			if change != nil {
				change(method, block)
			}
			return block, true
		}
		return nil, false
	})
}
func TestTestFundsConfirmsOnlySuccessfulMatchingCanonicalTransfer(t *testing.T) {
	c := faucetConfig()
	c.RPCURL = minedFaucetRPC(t, nil)
	h := wallet.New(c)
	st, claim := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "confirmed_claim_001"), "")
	if st != 202 || claim["status"] != "submitted" {
		t.Fatalf("submit=%d %v", st, claim)
	}
	st, out := request(t, h, "GET", "/v1/test-funds/claims/"+claim["claimId"].(string), "", "")
	if st != 200 || out["status"] != "confirmed" || out["transactionHash"] != claim["transactionHash"] || out["amountWei"] != "1000000000000000" {
		t.Fatalf("confirmed transfer=%d %v", st, out)
	}
	for _, private := range []string{"raw", "rawTx", "senderNonce", "reservedNative", "privateKey"} {
		if _, ok := out[private]; ok {
			t.Fatalf("query leaked %s", private)
		}
	}
}

func TestTestFundsDoesNotConfirmFailedMismatchedOrReorgedReceipts(t *testing.T) {
	for _, tc := range []struct{ name, method, field, value, status, code string }{
		{"reverted", "eth_getTransactionReceipt", "status", "0x0", "failed", "FAUCET_TRANSFER_FAILED"},
		{"wrongrecipient", "eth_getTransactionByHash", "to", "0x2222222222222222222222222222222222222222", "failed", "FAUCET_TRANSACTION_MISMATCH"},
		{"wrongvalue", "eth_getTransactionByHash", "value", "0x1", "failed", "FAUCET_TRANSACTION_MISMATCH"},
		{"wrongsender", "eth_getTransactionByHash", "from", "0x2222222222222222222222222222222222222222", "failed", "FAUCET_TRANSACTION_MISMATCH"},
		{"wrongchain", "eth_getTransactionByHash", "chainId", "0x1", "failed", "FAUCET_TRANSACTION_MISMATCH"},
		{"wrongnonce", "eth_getTransactionByHash", "nonce", "0x8", "failed", "FAUCET_TRANSACTION_MISMATCH"},
		{"calldata", "eth_getTransactionByHash", "input", "0x1234", "failed", "FAUCET_TRANSACTION_MISMATCH"},
		{"hashmismatch", "eth_getTransactionReceipt", "transactionHash", "0x" + strings.Repeat("b", 64), "failed", "FAUCET_TRANSACTION_MISMATCH"},
		{"reorg", "eth_getBlockByNumber", "hash", "0x" + strings.Repeat("b", 64), "unknown", ""},
		{"malformedstatus", "eth_getTransactionReceipt", "status", "0x2", "unknown", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := faucetConfig()
			c.RPCURL = minedFaucetRPC(t, func(method string, record map[string]any) {
				if method == tc.method {
					record[tc.field] = tc.value
				}
			})
			h := wallet.New(c)
			_, claim := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "invalid_receipt_001"), "")
			st, out := request(t, h, "GET", "/v1/test-funds/claims/"+claim["claimId"].(string), "", "")
			code, _ := out["failureCode"].(string)
			if st != 200 || out["status"] != tc.status || code != tc.code {
				t.Fatalf("receipt evidence=%d %v want %s %s", st, out, tc.status, tc.code)
			}
		})
	}
}

func TestTestFundsUnknownBroadcastRestartReplaysOnlySavedTransaction(t *testing.T) {
	c := postgresConfig(t)
	f := faucetConfig()
	c.FaucetPrivateKey = f.FaucetPrivateKey
	var mu sync.Mutex
	accept := false
	raws := map[string]struct{}{}
	c.RPCURL = faucetRPC(t, func(method string, params []any) (any, bool) {
		if method != "eth_sendRawTransaction" {
			return nil, false
		}
		mu.Lock()
		defer mu.Unlock()
		raw := params[0].(string)
		raws[raw] = struct{}{}
		if !accept {
			return "0x" + strings.Repeat("0", 64), true
		}
		encoded, _ := hex.DecodeString(strings.TrimPrefix(raw, "0x"))
		tx := new(types.Transaction)
		_ = tx.UnmarshalBinary(encoded)
		return tx.Hash().Hex(), true
	})
	first := wallet.New(c)
	st, claim := request(t, first, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "restart_unknown_001"), "")
	if st != 202 || claim["status"] != "unknown" {
		t.Fatalf("unknown delivery=%d %v", st, claim)
	}
	mu.Lock()
	accept = true
	mu.Unlock()
	restarted := wallet.New(c)
	st, out := request(t, restarted, "GET", "/v1/test-funds/claims/"+claim["claimId"].(string), "", "")
	if st != 200 || out["status"] != "submitted" || out["transactionHash"] != claim["transactionHash"] {
		t.Fatalf("restart must replay saved bytes without new nonce=%d %v", st, out)
	}
	st, retry := request(t, restarted, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "restart_unknown_001"), "")
	if st != 200 || retry["claimId"] != claim["claimId"] || retry["transactionHash"] != claim["transactionHash"] {
		t.Fatalf("restart idempotence=%d %v", st, retry)
	}
	st, denied := request(t, restarted, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "restart_new_key_002"), "")
	if st != 429 || errorCode(denied) != "FAUCET_COOLDOWN" {
		t.Fatalf("restart reset address reservation=%d %v", st, denied)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(raws) != 1 {
		t.Fatalf("created %d different wire transactions; want1", len(raws))
	}
	for raw := range raws {
		encoded, _ := hex.DecodeString(strings.TrimPrefix(raw, "0x"))
		tx := new(types.Transaction)
		_ = tx.UnmarshalBinary(encoded)
		if tx.Nonce() != 7 {
			t.Fatalf("restarted nonce=%d want7", tx.Nonce())
		}
	}
}

func TestTestFundsPostgresConcurrentClaimsReserveBudgetAndNoncesOnce(t *testing.T) {
	c := postgresConfig(t)
	c.FaucetPrivateKey = faucetConfig().FaucetPrivateKey
	c.FaucetDailyBudgetWei = "2000000000000000"
	var mu sync.Mutex
	nonces := map[uint64]string{}
	c.RPCURL = faucetRPC(t, func(method string, params []any) (any, bool) {
		if method != "eth_sendRawTransaction" {
			return nil, false
		}
		raw, _ := hex.DecodeString(strings.TrimPrefix(params[0].(string), "0x"))
		tx := new(types.Transaction)
		_ = tx.UnmarshalBinary(raw)
		mu.Lock()
		if old := nonces[tx.Nonce()]; old != "" && old != tx.Hash().Hex() {
			t.Errorf("same nonce signed two different transactions")
		}
		nonces[tx.Nonce()] = tx.Hash().Hex()
		mu.Unlock()
		return tx.Hash().Hex(), true
	})
	handlers := []http.Handler{wallet.New(c), wallet.New(c), wallet.New(c)}
	start := make(chan struct{})
	results := make(chan struct {
		status int
		out    map[string]any
	}, 3)
	for i, h := range handlers {
		go func(i int, h http.Handler) {
			<-start
			st, out := request(t, h, "POST", "/v1/test-funds/claims", faucetBody(fmt.Sprintf("0x%040x", i+1), fmt.Sprintf("atomic_claim_%04d", i)), "")
			results <- struct {
				status int
				out    map[string]any
			}{st, out}
		}(i, h)
	}
	close(start)
	succeeded, denied := 0, 0
	for range handlers {
		r := <-results
		if r.status == 202 && r.out["status"] == "submitted" {
			succeeded++
		} else if r.status == 429 && errorCode(r.out) == "FAUCET_BUDGET_EXCEEDED" {
			denied++
		} else {
			t.Fatalf("concurrent claim=%d %v", r.status, r.out)
		}
	}
	if succeeded != 2 || denied != 1 {
		t.Fatalf("atomic budget accepted%d denied%d want2/1", succeeded, denied)
	}
	mu.Lock()
	if len(nonces) != 2 || nonces[7] == "" || nonces[8] == "" {
		t.Errorf("persisted atomic nonce leases=%v want7,8", nonces)
	}
	mu.Unlock()
	st, out := request(t, wallet.New(c), "POST", "/v1/test-funds/claims", faucetBody("0x2222222222222222222222222222222222222222", "after_restart_001"), "")
	if st != 429 || errorCode(out) != "FAUCET_BUDGET_EXCEEDED" {
		t.Fatalf("restart reset UTC pool budget=%d %v", st, out)
	}
}

func testFundsServerProcess(t *testing.T, variables ...string) (string, error) {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "wallet-api")
	build := exec.Command("go", "build", "-o", binary, "./cmd/server")
	if out, e := build.CombinedOutput(); e != nil {
		t.Fatalf("test environment build failure: %v %s", e, out)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binary)
	command.Env = append([]string{"PATH=" + os.Getenv("PATH"), "WALLET_ALLOW_IN_MEMORY=true", "WALLET_API_LISTEN=127.0.0.1:0"}, variables...)
	out, e := command.CombinedOutput()
	return string(out), e
}
func TestTestFundsServerRequiresPersistentPostgresWhenEnabled(t *testing.T) {
	out, e := testFundsServerProcess(t, "TEST_FAUCET_PRIVATE_KEY="+faucetConfig().FaucetPrivateKey, "WALLET_RPC_URL=http://127.0.0.1:1")
	if e == nil || !strings.Contains(out, "test faucet requires persistent PostgreSQL") {
		t.Fatalf("enabled in-memory faucet was not rejected: error=%v output=%s", e, out)
	}
}

func TestTestFundsServerRefusesNonLoopbackBind(t *testing.T) {
	for _, address := range []string{"0.0.0.0:0", ":0", "[::]:0"} {
		t.Run(address, func(t *testing.T) {
			out, e := testFundsServerProcess(t, "WALLET_API_LISTEN="+address)
			if e == nil || !strings.Contains(out, "WALLET_API_LISTEN must be a loopback address") {
				t.Fatalf("non-loopback listener not rejected: error=%v output=%s", e, out)
			}
		})
	}
}

func TestTestFundsRetryRechecksRPCChainBeforeBroadcast(t *testing.T) {
	c := faucetConfig()
	var mu sync.Mutex
	wrongChain := false
	c.RPCURL = faucetRPC(t, func(method string, params []any) (any, bool) {
		mu.Lock()
		defer mu.Unlock()
		if method == "eth_chainId" && wrongChain {
			return "0x1", true
		}
		if method == "eth_sendRawTransaction" {
			if !wrongChain {
				return "0x" + strings.Repeat("0", 64), true
			}
			raw, _ := hex.DecodeString(strings.TrimPrefix(params[0].(string), "0x"))
			tx := new(types.Transaction)
			_ = tx.UnmarshalBinary(raw)
			return tx.Hash().Hex(), true
		}
		return nil, false
	})
	h := wallet.New(c)
	payload := faucetBody("0x1111111111111111111111111111111111111111", "chain_retry_00001")
	_, first := request(t, h, "POST", "/v1/test-funds/claims", payload, "")
	if first["status"] != "unknown" {
		t.Fatalf("initial uncertain response=%v", first)
	}
	mu.Lock()
	wrongChain = true
	mu.Unlock()
	st, out := request(t, h, "POST", "/v1/test-funds/claims", payload, "")
	if st != 200 || out["status"] != "unknown" || out["failureCode"] != nil || out["transactionHash"] != first["transactionHash"] {
		t.Fatalf("retry trusted wrong-chain transport=%d %v", st, out)
	}
}

func TestTestFundsUnknownResponseMatchesClientContract(t *testing.T) {
	c := faucetConfig()
	c.RPCURL = faucetRPC(t, func(method string, params []any) (any, bool) {
		if method == "eth_sendRawTransaction" {
			return "0x" + strings.Repeat("0", 64), true
		}
		return nil, false
	})
	h := wallet.New(c)
	st, claim := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "public_unknown_contract"), "")
	if st != 202 || claim["status"] != "unknown" {
		t.Fatalf("uncertain response=%d %v", st, claim)
	}
	if _, present := claim["failureCode"]; present {
		t.Fatalf("unknown response must not carry terminal failureCode: %v", claim)
	}
	st, queried := request(t, h, "GET", "/v1/test-funds/claims/"+claim["claimId"].(string), "", "")
	if st != 200 || queried["status"] != "unknown" || queried["claimId"] != claim["claimId"] || queried["transactionHash"] != claim["transactionHash"] {
		t.Fatalf("same uncertain claim=%d %v", st, queried)
	}
	if _, present := queried["failureCode"]; present {
		t.Fatalf("unknown query must not carry terminal failureCode: %v", queried)
	}
}

func TestTestFundsCapsPerTransferGasExpense(t *testing.T) {
	for _, tc := range []struct {
		name, gas, price string
		want             int
	}{
		{"oneETHgas", "0xf4240", "0xe8d4a51000", 503},
		{"exact00001ETHcap", "0x186a0", "0x1dcd6500", 202},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := faucetConfig()
			c.RPCURL = faucetRPC(t, func(method string, params []any) (any, bool) {
				switch method {
				case "eth_getBalance":
					return "0x56bc75e2d63100000", true
				case "eth_estimateGas":
					return tc.gas, true
				case "eth_gasPrice":
					return tc.price, true
				case "eth_sendRawTransaction":
					raw, _ := hex.DecodeString(strings.TrimPrefix(params[0].(string), "0x"))
					tx := new(types.Transaction)
					_ = tx.UnmarshalBinary(raw)
					return tx.Hash().Hex(), true
				}
				return nil, false
			})
			st, out := request(t, wallet.New(c), "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "gas_cap_claim_001"), "")
			if st != tc.want || (tc.want == 503 && errorCode(out) != "FAUCET_UNAVAILABLE") || (tc.want == 202 && out["status"] != "submitted") {
				t.Fatalf("gas expense cap=%d %v want%d", st, out, tc.want)
			}
		})
	}
}

func TestTestFundsDisabledPoolStillRecoversExistingIdempotentClaim(t *testing.T) {
	c := postgresConfig(t)
	c.FaucetPrivateKey = faucetConfig().FaucetPrivateKey
	var mu sync.Mutex
	disabled := false
	c.RPCURL = faucetRPC(t, func(method string, _ []any) (any, bool) {
		if method == "eth_sendRawTransaction" {
			mu.Lock()
			defer mu.Unlock()
			if disabled {
				t.Error("closed pool broadcast a saved transaction")
			}
			return "0x" + strings.Repeat("0", 64), true
		}
		return nil, false
	})
	payload := faucetBody("0x1111111111111111111111111111111111111111", "closing_pool_00001")
	st, first := request(t, wallet.New(c), "POST", "/v1/test-funds/claims", payload, "")
	if st != 202 || first["status"] != "unknown" {
		t.Fatalf("initial=%d %v", st, first)
	}
	mu.Lock()
	disabled = true
	mu.Unlock()
	for _, mode := range []string{"keyremoved", "zerobudget"} {
		t.Run(mode, func(t *testing.T) {
			closed := c
			if mode == "keyremoved" {
				closed.FaucetPrivateKey = ""
			} else {
				closed.FaucetDailyBudgetWei = "0"
			}
			h := wallet.New(closed)
			st, out := request(t, h, "POST", "/v1/test-funds/claims", payload, "")
			if st != 200 || out["claimId"] != first["claimId"] || out["transactionHash"] != first["transactionHash"] || out["status"] != "unknown" {
				t.Fatalf("closed pool lost existing idempotent result=%d %v", st, out)
			}
			st, out = request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x2222222222222222222222222222222222222222", "closed_new_000001"), "")
			if st != 503 || errorCode(out) != "FAUCET_UNAVAILABLE" {
				t.Fatalf("closed pool issued new claim=%d %v", st, out)
			}
		})
	}
}

func TestTestFundsUnresolvedRawRetainsLimitsAcrossUTCAnd24Hours(t *testing.T) {
	for _, tc := range []struct{ name, address, code string }{
		{"sameaddress", "0x1111111111111111111111111111111111111111", "FAUCET_COOLDOWN"},
		{"globalpool", "0x2222222222222222222222222222222222222222", "FAUCET_BUDGET_EXCEEDED"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Date(2026, 11, 11, 23, 30, 0, 0, time.UTC)
			c := faucetConfig()
			c.FaucetDailyBudgetWei = "1000000000000000"
			c.Clock = func() time.Time { return now }
			c.RPCURL = minedFaucetRPC(t, nil)
			h := wallet.New(c)
			_, first := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "carryover_first_001"), "")
			now = now.Add(25 * time.Hour)
			st, out := request(t, h, "POST", "/v1/test-funds/claims", faucetBody(tc.address, "carryover_second_002"), "")
			if st != 429 || errorCode(out) != tc.code {
				t.Fatalf("unresolved signed transaction released limits=%d %v want%s", st, out, tc.code)
			}
			st, out = request(t, h, "GET", "/v1/test-funds/claims/"+first["claimId"].(string), "", "")
			if st != 200 || out["status"] != "confirmed" {
				t.Fatalf("resolve previous claim=%d %v", st, out)
			}
			st, out = request(t, h, "POST", "/v1/test-funds/claims", faucetBody(tc.address, "carryover_second_002"), "")
			if st != 429 || errorCode(out) != tc.code {
				t.Fatalf("late confirmation immediately released today's limits=%d %v want%s", st, out, tc.code)
			}
			now = now.Add(24 * time.Hour)
			st, out = request(t, h, "POST", "/v1/test-funds/claims", faucetBody(tc.address, "carryover_second_002"), "")
			if st != 202 || out["status"] != "submitted" {
				t.Fatalf("settled limits never expired=%d %v", st, out)
			}
		})
	}
}

func TestTestFundsPostgresBroadcastResultSaveFailureDoesNotResignAfterRestart(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set: real PostgreSQL not executed")
	}
	namespace := "faucet-result-failure-" + time.Now().Format("150405.000000000")
	stateKey := []byte(strings.Repeat("k", 32))
	store, e := wallet.OpenPostgres(context.Background(), url, stateKey, namespace)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(store.Close)
	c := faucetConfig()
	c.Store = store
	c.FaucetDailyBudgetWei = "1000000000000000"
	var mu sync.Mutex
	accepted := false
	raws := map[string]struct{}{}
	c.RPCURL = faucetRPC(t, func(method string, params []any) (any, bool) {
		mu.Lock()
		defer mu.Unlock()
		if method == "eth_getTransactionCount" && accepted {
			return "0x8", true
		}
		if method != "eth_sendRawTransaction" {
			return nil, false
		}
		raw := params[0].(string)
		raws[raw] = struct{}{}
		encoded, _ := hex.DecodeString(strings.TrimPrefix(raw, "0x"))
		tx := new(types.Transaction)
		_ = tx.UnmarshalBinary(encoded)
		if !accepted {
			accepted = true
			store.Close()
		}
		return tx.Hash().Hex(), true
	})
	payload := faucetBody("0x1111111111111111111111111111111111111111", "save_failed_claim_001")
	st, out := request(t, wallet.New(c), "POST", "/v1/test-funds/claims", payload, "")
	if st != 503 || errorCode(out) != "SERVICE_UNAVAILABLE" {
		t.Fatalf("unsaved broadcast result was acknowledged=%d %v", st, out)
	}
	reopened, e := wallet.OpenPostgres(context.Background(), url, stateKey, namespace)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(reopened.Close)
	c.Store = reopened
	restarted := wallet.New(c)
	st, out = request(t, restarted, "POST", "/v1/test-funds/claims", payload, "")
	if st != 200 || out["status"] != "submitted" {
		t.Fatalf("lost raw/idempotency before broadcast commit=%d %v", st, out)
	}
	mu.Lock()
	if len(raws) != 1 {
		t.Errorf("restart after accepted broadcast signed %d transactions want1", len(raws))
	}
	for raw := range raws {
		encoded, _ := hex.DecodeString(strings.TrimPrefix(raw, "0x"))
		tx := new(types.Transaction)
		_ = tx.UnmarshalBinary(encoded)
		if tx.Nonce() != 7 || out["transactionHash"] != strings.ToLower(tx.Hash().Hex()) {
			t.Errorf("restart changed nonce/hash %v", out)
		}
	}
	mu.Unlock()
	st, out = request(t, restarted, "POST", "/v1/test-funds/claims", faucetBody("0x2222222222222222222222222222222222222222", "save_failed_new_002"), "")
	if st != 429 || errorCode(out) != "FAUCET_BUDGET_EXCEEDED" {
		t.Fatalf("broadcast save failure released budget=%d %v", st, out)
	}
}

func TestTestFundsNewTransferDoublesSampledGasPrice(t *testing.T) {
	c := faucetConfig()
	var mu sync.Mutex
	var transferred *types.Transaction
	c.RPCURL = faucetRPC(t, func(method string, params []any) (any, bool) {
		if method == "eth_gasPrice" {
			return "0xa", true
		}
		if method != "eth_sendRawTransaction" {
			return nil, false
		}
		raw, _ := hex.DecodeString(strings.TrimPrefix(params[0].(string), "0x"))
		tx := new(types.Transaction)
		if e := tx.UnmarshalBinary(raw); e != nil {
			t.Error(e)
		}
		mu.Lock()
		transferred = tx
		mu.Unlock()
		return tx.Hash().Hex(), true
	})
	st, out := request(t, wallet.New(c), "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "fee_buffer_000001"), "")
	mu.Lock()
	defer mu.Unlock()
	if st != 202 || out["status"] != "submitted" || transferred == nil || transferred.GasPrice().String() != "20" {
		t.Fatalf("gas price must buffer fixed sample10 to20=%d %v tx=%v", st, out, transferred)
	}
}

type faucetFeeRPC struct {
	onSend                 func(*types.Transaction)
	mu                     sync.Mutex
	sample, balance, mined string
	accept                 bool
	transactions           []*types.Transaction
}

func (f *faucetFeeRPC) url(t *testing.T) string {
	return faucetRPC(t, func(method string, params []any) (any, bool) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch method {
		case "eth_gasPrice":
			if f.sample != "" {
				return f.sample, true
			}
			return "0xa", true
		case "eth_getBalance":
			if f.balance != "" {
				return f.balance, true
			}
			return nil, false
		case "eth_sendRawTransaction":
			raw, _ := hex.DecodeString(strings.TrimPrefix(params[0].(string), "0x"))
			tx := new(types.Transaction)
			if e := tx.UnmarshalBinary(raw); e != nil {
				t.Error(e)
			}
			found := false
			for _, old := range f.transactions {
				if old.Hash() == tx.Hash() {
					found = true
				}
			}
			if !found {
				f.transactions = append(f.transactions, tx)
			}
			if f.onSend != nil {
				f.onSend(tx)
			}
			if f.accept {
				return tx.Hash().Hex(), true
			}
			return "0x" + strings.Repeat("0", 64), true
		case "eth_getTransactionReceipt", "eth_getTransactionByHash":
			if f.mined == "" || params[0] != f.mined {
				return nil, true
			}
			if method == "eth_getTransactionReceipt" {
				return map[string]any{"transactionHash": f.mined, "status": "0x1", "blockNumber": "0x64", "blockHash": "0x" + strings.Repeat("a", 64), "from": "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf", "to": "0x1111111111111111111111111111111111111111"}, true
			}
			return map[string]any{"hash": f.mined, "from": "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf", "to": "0x1111111111111111111111111111111111111111", "value": "0x38d7ea4c68000", "chainId": "0x66eee", "nonce": "0x7", "input": "0x", "blockNumber": "0x64", "blockHash": "0x" + strings.Repeat("a", 64)}, true
		case "eth_getBlockByNumber":
			return map[string]any{"number": "0x64", "hash": "0x" + strings.Repeat("a", 64)}, true
		}
		return nil, false
	})
}
func TestTestFundsUnknownLowFeeCanReplaceOnlySameNonceTransfer(t *testing.T) {
	fixture := &faucetFeeRPC{}
	c := faucetConfig()
	c.RPCURL = fixture.url(t)
	h := wallet.New(c)
	_, first := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "replacement_basic_001"), "")
	if first["status"] != "unknown" {
		t.Fatalf("first=%v", first)
	}
	fixture.mu.Lock()
	fixture.sample = "0x14"
	fixture.accept = true
	fixture.mu.Unlock()
	st, out := request(t, h, "GET", "/v1/test-funds/claims/"+first["claimId"].(string), "", "")
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if st != 200 || out["claimId"] != first["claimId"] || out["status"] != "submitted" || out["transactionHash"] == first["transactionHash"] || len(fixture.transactions) != 2 {
		t.Fatalf("low-fee recovery=%d %v attempts=%d want2 distinct same-nonce raws", st, out, len(fixture.transactions))
	}
	for i, tx := range fixture.transactions {
		price := "20"
		if i == 1 {
			price = "40"
		}
		from, e := types.Sender(types.LatestSignerForChainID(big.NewInt(421614)), tx)
		if e != nil || strings.ToLower(from.Hex()) != "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf" || tx.Nonce() != 7 || tx.ChainId().String() != "421614" || tx.To() == nil || *tx.To() != common.HexToAddress("0x1111111111111111111111111111111111111111") || tx.Value().String() != "1000000000000000" || len(tx.Data()) != 0 || tx.Gas() != 21000 || tx.GasPrice().String() != price {
			t.Fatalf("replacement changed immutable transfer: index%d tx%v", i, tx)
		}
	}
	for _, secret := range []string{"raw", "attempts", "privateKey"} {
		if _, ok := out[secret]; ok {
			t.Fatalf("private recovery material leaked %s", secret)
		}
	}
}

func TestTestFundsQueriesEveryPersistedAttemptAndReturnsActuallyMinedHash(t *testing.T) {
	for _, winner := range []string{"original", "replacement"} {
		t.Run(winner, func(t *testing.T) {
			c := postgresConfig(t)
			c.FaucetPrivateKey = faucetConfig().FaucetPrivateKey
			fixture := &faucetFeeRPC{}
			c.RPCURL = fixture.url(t)
			h := wallet.New(c)
			_, first := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "attempt_winner_001"), "")
			fixture.mu.Lock()
			fixture.sample = "0x14"
			fixture.mu.Unlock()
			_, replacement := request(t, h, "GET", "/v1/test-funds/claims/"+first["claimId"].(string), "", "")
			mined := first["transactionHash"].(string)
			if winner == "replacement" {
				mined = replacement["transactionHash"].(string)
			}
			fixture.mu.Lock()
			fixture.mined = mined
			fixture.mu.Unlock()
			c.FaucetPrivateKey = ""
			restartedClosed := wallet.New(c)
			for i := 0; i < 2; i++ {
				st, out := request(t, restartedClosed, "GET", "/v1/test-funds/claims/"+first["claimId"].(string), "", "")
				if st != 200 || out["status"] != "confirmed" || out["claimId"] != first["claimId"] || out["transactionHash"] != mined || out["amountWei"] != "1000000000000000" {
					t.Fatalf("mined %s attempt lost after restart/closure query%d=%d %v", winner, i, st, out)
				}
			}
		})
	}
}

func TestTestFundsCapsSameNonceReplacementsAndStillFindsOriginalReceipt(t *testing.T) {
	fixture := &faucetFeeRPC{}
	c := faucetConfig()
	c.RPCURL = fixture.url(t)
	h := wallet.New(c)
	_, first := request(t, h, "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "replacement_limit_001"), "")
	id := first["claimId"].(string)
	latest := ""
	for _, sample := range []string{"0x14", "0x28", "0x50", "0xa0", "0x140"} {
		fixture.mu.Lock()
		fixture.sample = sample
		fixture.mu.Unlock()
		st, out := request(t, h, "GET", "/v1/test-funds/claims/"+id, "", "")
		if st != 200 || out["status"] != "unknown" || out["claimId"] != id {
			t.Fatalf("bounded unknown recovery=%d %v", st, out)
		}
		latest = out["transactionHash"].(string)
	}
	fixture.mu.Lock()
	count := len(fixture.transactions)
	lastPrice := fixture.transactions[len(fixture.transactions)-1].GasPrice().String()
	fixture.mined = first["transactionHash"].(string)
	fixture.mu.Unlock()
	if count != 4 || lastPrice != "160" {
		t.Fatalf("replacement cap exceeded: unique raws%d lastGasPrice%s want4/160", count, lastPrice)
	}
	if latest == first["transactionHash"] {
		t.Fatalf("never replaced original")
	}
	st, out := request(t, h, "GET", "/v1/test-funds/claims/"+id, "", "")
	if st != 200 || out["status"] != "confirmed" || out["transactionHash"] != first["transactionHash"] {
		t.Fatalf("at-limit original receipt not recoverable=%d %v", st, out)
	}
}

func TestTestFundsPostgresLateOlderAttemptAckCannotOverwriteNewerUnknown(t *testing.T) {
	c := postgresConfig(t)
	c.FaucetPrivateKey = faucetConfig().FaucetPrivateKey
	var mu sync.Mutex
	sample := "0xa"
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseOld := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(releaseOld)
	defer releaseOld()
	c.RPCURL = faucetRPC(t, func(method string, params []any) (any, bool) {
		if method == "eth_gasPrice" {
			mu.Lock()
			defer mu.Unlock()
			return sample, true
		}
		if method != "eth_sendRawTransaction" {
			return nil, false
		}
		raw, _ := hex.DecodeString(strings.TrimPrefix(params[0].(string), "0x"))
		tx := new(types.Transaction)
		_ = tx.UnmarshalBinary(raw)
		if tx.GasPrice().String() == "40" {
			close(started)
			<-release
			return tx.Hash().Hex(), true
		}
		return "0x" + strings.Repeat("0", 64), true
	})
	payload := faucetBody("0x1111111111111111111111111111111111111111", "late_attempt_ack_001")
	_, first := request(t, wallet.New(c), "POST", "/v1/test-funds/claims", payload, "")
	mu.Lock()
	sample = "0x14"
	mu.Unlock()
	result := make(chan struct {
		status int
		out    map[string]any
	}, 1)
	go func() {
		st, out := request(t, wallet.New(c), "POST", "/v1/test-funds/claims", payload, "")
		result <- struct {
			status int
			out    map[string]any
		}{st, out}
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("fixture did not observe first persisted replacement")
	}
	mu.Lock()
	sample = "0x28"
	mu.Unlock()
	st, newer := request(t, wallet.New(c), "POST", "/v1/test-funds/claims", payload, "")
	if st != 200 || newer["status"] != "unknown" || newer["transactionHash"] == first["transactionHash"] {
		releaseOld()
		t.Fatalf("newer attempt=%d %v", st, newer)
	}
	releaseOld()
	older := <-result
	if older.status != 200 || older.out["status"] != "unknown" || older.out["transactionHash"] != newer["transactionHash"] {
		t.Fatalf("late older ack overwrote newer unknown=%d %v latest=%v", older.status, older.out, newer)
	}
}

func TestTestFundsReplacementSafetyBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, sample, balance, key, price string
		attempts                          int
	}{
		{name: "unchanged", sample: "0xa", price: "20", attempts: 1},
		{name: "lower", sample: "0x5", price: "20", attempts: 1},
		{name: "smallincreasewithminimumbump", sample: "0xb", price: "23", attempts: 2},
		{name: "gascap", sample: "0xe8d4a51000", price: "20", attempts: 1},
		{name: "overflow", sample: "0x" + strings.Repeat("f", 64), price: "20", attempts: 1},
		{name: "insufficientbalance", sample: "0x14", balance: "0x38d7ea4c68000", price: "20", attempts: 1},
		{name: "exactmaximumreserve", sample: "0x14", balance: "0x38d7ea4d35140", price: "40", attempts: 2},
		{name: "rotatedkey", sample: "0x14", key: "0000000000000000000000000000000000000000000000000000000000000002", price: "20", attempts: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := postgresConfig(t)
			c.FaucetPrivateKey = faucetConfig().FaucetPrivateKey
			fixture := &faucetFeeRPC{}
			c.RPCURL = fixture.url(t)
			_, first := request(t, wallet.New(c), "POST", "/v1/test-funds/claims", faucetBody("0x1111111111111111111111111111111111111111", "replacement_boundary_001"), "")
			fixture.mu.Lock()
			fixture.sample = tc.sample
			fixture.balance = tc.balance
			fixture.mu.Unlock()
			if tc.key != "" {
				c.FaucetPrivateKey = tc.key
			}
			st, out := request(t, wallet.New(c), "GET", "/v1/test-funds/claims/"+first["claimId"].(string), "", "")
			fixture.mu.Lock()
			defer fixture.mu.Unlock()
			if st != 200 || out["status"] != "unknown" || out["claimId"] != first["claimId"] || out["failureCode"] != nil || len(fixture.transactions) != tc.attempts || fixture.transactions[len(fixture.transactions)-1].GasPrice().String() != tc.price {
				t.Fatalf("replacement safety boundary=%d %v attempts%d want%d gas%s", st, out, len(fixture.transactions), tc.attempts, tc.price)
			}
			for _, tx := range fixture.transactions {
				sender, e := types.Sender(types.LatestSignerForChainID(big.NewInt(421614)), tx)
				if e != nil || strings.ToLower(sender.Hex()) != "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf" || tx.Nonce() != 7 {
					t.Fatalf("safety retry changed sender/nonce")
				}
			}
		})
	}
}

func TestTestFundsPostgresReplacementAttemptsSurviveBroadcastResultSaveFailure(t *testing.T) {
	for _, winner := range []string{"original", "replacement"} {
		t.Run(winner, func(t *testing.T) {
			url := os.Getenv("TEST_DATABASE_URL")
			if url == "" {
				t.Skip("TEST_DATABASE_URL not set: real PostgreSQL not executed")
			}
			namespace := "faucet-replacement-failure-" + time.Now().Format("150405.000000000")
			stateKey := []byte(strings.Repeat("k", 32))
			store, e := wallet.OpenPostgres(context.Background(), url, stateKey, namespace)
			if e != nil {
				t.Fatal(e)
			}
			t.Cleanup(store.Close)
			c := faucetConfig()
			c.Store = store
			c.FaucetDailyBudgetWei = "1000000000000000"
			fixture := &faucetFeeRPC{}
			c.RPCURL = fixture.url(t)
			payload := faucetBody("0x1111111111111111111111111111111111111111", "replacement_save_001")
			h := wallet.New(c)
			_, first := request(t, h, "POST", "/v1/test-funds/claims", payload, "")
			fixture.mu.Lock()
			fixture.sample = "0x14"
			fixture.accept = true
			closed := false
			fixture.onSend = func(tx *types.Transaction) {
				if tx.GasPrice().String() == "40" && !closed {
					closed = true
					store.Close()
				}
			}
			fixture.mu.Unlock()
			st, out := request(t, h, "POST", "/v1/test-funds/claims", payload, "")
			if st != 503 || errorCode(out) != "SERVICE_UNAVAILABLE" {
				t.Fatalf("unsaved replacement acknowledgement=%d %v", st, out)
			}
			reopened, e := wallet.OpenPostgres(context.Background(), url, stateKey, namespace)
			if e != nil {
				t.Fatal(e)
			}
			t.Cleanup(reopened.Close)
			c.Store = reopened
			fixture.mu.Lock()
			if len(fixture.transactions) != 2 {
				fixture.mu.Unlock()
				t.Fatalf("replacement not durably prepared before send")
			}
			mined := fixture.transactions[0].Hash().Hex()
			if winner == "replacement" {
				mined = fixture.transactions[1].Hash().Hex()
			}
			fixture.mined = strings.ToLower(mined)
			fixture.onSend = nil
			fixture.mu.Unlock()
			restarted := wallet.New(c)
			st, out = request(t, restarted, "GET", "/v1/test-funds/claims/"+first["claimId"].(string), "", "")
			if st != 200 || out["status"] != "confirmed" || out["transactionHash"] != strings.ToLower(mined) || out["claimId"] != first["claimId"] {
				t.Fatalf("persisted %s attempt missing after result-save failure=%d %v", winner, st, out)
			}
			fixture.mu.Lock()
			count := len(fixture.transactions)
			for _, tx := range fixture.transactions {
				if tx.Nonce() != 7 {
					t.Errorf("recovery allocated new nonce%d", tx.Nonce())
				}
			}
			fixture.mu.Unlock()
			if count != 2 {
				t.Fatalf("recovery signed %d transactions want original+one replacement", count)
			}
			st, out = request(t, restarted, "POST", "/v1/test-funds/claims", faucetBody("0x2222222222222222222222222222222222222222", "after_replacement_002"), "")
			if st != 429 || errorCode(out) != "FAUCET_BUDGET_EXCEEDED" {
				t.Fatalf("replacement failure lost pool reservation=%d %v", st, out)
			}
		})
	}
}
