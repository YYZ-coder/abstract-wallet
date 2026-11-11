package sponsorship_test

import (
	wallet "abstract-wallet/services/sponsorship"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/holiman/uint256"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestRelayAuthorizationUsesSafeType4AndIndependentAuthorizationDedup(t *testing.T) {
	c := config()
	c.RelayPrivateKey = "2123456789012345678901234567890123456789012345678901234567890123"
	c.MaxRelayCostWei = "100000"
	c.RelayUserBudgetWei = "200000"
	c.RelayChainBudgetWei = "200000"
	c.RelayAllowedAccounts = []string{accountA}
	var mu sync.Mutex
	transactions := map[string]*types.Transaction{}
	rpcServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var q map[string]any
		_ = json.NewDecoder(r.Body).Decode(&q)
		var result any = "0x"
		switch q["method"] {
		case "eth_chainId":
			result = "0x66eee"
		case "eth_getTransactionCount":
			result = "0x0"
		case "eth_gasPrice":
			result = "0x1"
		case "eth_estimateGas":
			result = "0x186a0"
		case "eth_sendRawTransaction":
			raw, _ := hex.DecodeString(strings.TrimPrefix(q["params"].([]any)[0].(string), "0x"))
			tx := new(types.Transaction)
			if e := tx.UnmarshalBinary(raw); e != nil {
				t.Error(e)
			}
			mu.Lock()
			transactions[tx.Hash().Hex()] = tx
			mu.Unlock()
			result = tx.Hash().Hex()
		case "eth_getTransactionReceipt", "eth_getTransactionByHash":
			result = nil
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": q["id"], "result": result})
	}))
	defer rpcServer.Close()
	c.RPCURL = rpcServer.URL
	h := wallet.New(c)
	token, _, _ := signIn(t, h, "00000001")
	root, _ := crypto.HexToECDSA("0123456789012345678901234567890123456789012345678901234567890123")
	a, _ := types.SignSetCode(root, types.SetCodeAuthorization{ChainID: *uint256.NewInt(421614), Address: common.Address{}, Nonce: 0})
	auth := map[string]any{"chainId": "421614", "address": strings.ToLower(a.Address.Hex()), "nonce": "0", "yParity": strconv.Itoa(int(a.V)), "r": "0x" + hex.EncodeToString(a.R.Bytes()), "s": "0x" + hex.EncodeToString(a.S.Bytes())}
	b := map[string]any{"schemaVersion": "1", "idempotencyKey": "relay_request_00001", "manifestVersion": "arb-sepolia-mvp-v1", "chainId": "421614", "account": accountA, "action": "revoke", "expectedDelegate": strings.ToLower(common.Address{}.Hex()), "authorization": auth, "maxRelayCostNative": "100000"}
	status, first := request(t, h, "POST", "/v1/delegations/relay", body(b), token)
	if status != 202 {
		t.Fatalf("relay=%d %v", status, first)
	}
	b["idempotencyKey"] = "relay_request_00002"
	status, second := request(t, h, "POST", "/v1/delegations/relay", body(b), token)
	if status != 200 || second["relayId"] != first["relayId"] || second["relayerNonce"] != "0" {
		t.Fatalf("duplicate spent another relay nonce: %d %v first=%v", status, second, first)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(transactions) != 1 {
		t.Fatalf("unique broadcast transactions=%d want1", len(transactions))
	}
	for _, tx := range transactions {
		if tx.Type() != 4 || tx.Value().Sign() != 0 || len(tx.Data()) != 0 || tx.To() == nil || *tx.To() != (common.Address{}) || len(tx.SetCodeAuthorizations()) != 1 {
			t.Fatalf("unsafe relay tx=%v", tx)
		}
	}
}

func TestRelayStatusGetNeverRebroadcastsTimedOutTransaction(t *testing.T) {
	c := postgresConfig(t)
	c.RelayPrivateKey = "2123456789012345678901234567890123456789012345678901234567890123"
	c.MaxRelayCostWei = "100000"
	c.RelayUserBudgetWei = "200000"
	c.RelayChainBudgetWei = "200000"
	c.RelayAllowedAccounts = []string{accountA}
	var sends atomic.Int32
	rpcServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var q map[string]any
		_ = json.NewDecoder(r.Body).Decode(&q)
		result := "0x"
		switch q["method"] {
		case "eth_chainId":
			result = "0x66eee"
		case "eth_getTransactionCount":
			result = "0x0"
		case "eth_gasPrice":
			result = "0x1"
		case "eth_estimateGas":
			result = "0x186a0"
		case "eth_sendRawTransaction":
			sends.Add(1)
			w.WriteHeader(503)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": q["id"], "result": result})
	}))
	defer rpcServer.Close()
	c.RPCURL = rpcServer.URL
	h := wallet.New(c)
	token, _, _ := signIn(t, h, "00000001")
	key, _ := crypto.HexToECDSA("0123456789012345678901234567890123456789012345678901234567890123")
	a, _ := types.SignSetCode(key, types.SetCodeAuthorization{ChainID: *uint256.NewInt(421614), Address: common.Address{}, Nonce: 0})
	auth := map[string]any{"chainId": "421614", "address": strings.ToLower(a.Address.Hex()), "nonce": "0", "yParity": strconv.Itoa(int(a.V)), "r": fmt.Sprintf("0x%064x", a.R.ToBig()), "s": fmt.Sprintf("0x%064x", a.S.ToBig())}
	b := map[string]any{"schemaVersion": "1", "idempotencyKey": "readonly_relay_0001", "manifestVersion": "arb-sepolia-mvp-v1", "chainId": "421614", "account": accountA, "action": "revoke", "expectedDelegate": strings.ToLower(common.Address{}.Hex()), "authorization": auth, "maxRelayCostNative": "100000"}
	status, relay := request(t, h, "POST", "/v1/delegations/relay", body(b), token)
	if status != 202 || relay["broadcastState"] != "unknown" {
		t.Fatalf("initial unknown=%d %v", status, relay)
	}
	before := sends.Load()
	status, out := request(t, h, "GET", "/v1/delegations/relay/"+relay["relayId"].(string), "", token)
	if status != 200 {
		t.Fatalf("get=%d %v", status, out)
	}
	if sends.Load() != before {
		t.Fatalf("read-only GET sent another raw transaction: before=%d after=%d", before, sends.Load())
	}
}
