package sponsorship

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"math/big"
	"net/http"
	"strconv"
	"strings"
)

// Reservation and raw signing commit before this handler is allowed to broadcast.
func (s *server) servePersistentTestFunds(w http.ResponseWriter, r *http.Request) {
	s.requestMu.Lock()
	defer s.requestMu.Unlock()
	b := &responseBuffer{header: http.Header{}}
	if s.c.Store == nil {
		s.serveMemory(b, r)
	} else if e := s.c.Store.update(r.Context(), func(state *snapshot) error { s.restore(state); s.serveMemory(b, r); *state = *s.snapshot(); return nil }); e != nil {
		write(w, 503, failure("SERVICE_UNAVAILABLE"))
		return
	}
	var out J
	_ = json.Unmarshal(b.body.Bytes(), &out)
	if id, ok := out["claimId"].(string); ok && r.Method == http.MethodPost && b.code < 300 {
		updated, e := s.broadcastFaucet(r.Context(), id)
		if e != nil {
			write(w, 503, failure("SERVICE_UNAVAILABLE"))
			return
		}
		write(w, b.code, updated)
		return
	}
	if id, ok := out["claimId"].(string); ok && r.Method == http.MethodGet && b.code == 200 {
		updated, e := s.observeFaucet(r.Context(), id)
		if e != nil {
			write(w, 503, failure("SERVICE_UNAVAILABLE"))
			return
		}
		write(w, 200, updated)
		return
	}
	for key, values := range b.header {
		w.Header()[key] = values
	}
	w.WriteHeader(b.code)
	_, _ = w.Write(b.body.Bytes())
}
func (s *server) signFaucetTransfer(ctx context.Context, claim J) string {
	key, _ := crypto.HexToECDSA(strings.TrimPrefix(s.c.FaucetPrivateKey, "0x"))
	sender := strings.ToLower(crypto.PubkeyToAddress(key.PublicKey).Hex())
	nonce, e := s.faucetNumber(ctx, "eth_getTransactionCount", []any{sender, "pending"})
	if e != nil || !nonce.IsUint64() {
		return "UPSTREAM_UNAVAILABLE"
	}
	for _, old := range s.faucetClaims {
		if old["senderAddress"] == sender {
			n, ok := new(big.Int).SetString(old["senderNonce"].(string), 10)
			if !ok {
				return "FAUCET_UNAVAILABLE"
			}
			n.Add(n, big.NewInt(1))
			if nonce.Cmp(n) < 0 {
				nonce = n
			}
		}
	}
	if !nonce.IsUint64() || nonce.Uint64() == ^uint64(0) {
		return "FAUCET_UNAVAILABLE"
	}
	price, e := s.faucetNumber(ctx, "eth_gasPrice", []any{})
	if e != nil || price.Sign() <= 0 {
		return "UPSTREAM_UNAVAILABLE"
	}
	price.Mul(price, big.NewInt(2))
	to := common.HexToAddress(claim["address"].(string))
	value := big.NewInt(1000000000000000)
	gas, e := s.faucetNumber(ctx, "eth_estimateGas", []any{J{"from": sender, "to": strings.ToLower(to.Hex()), "value": "0x38d7ea4c68000", "data": "0x"}})
	if e != nil || !gas.IsUint64() || gas.Sign() <= 0 {
		return "UPSTREAM_UNAVAILABLE"
	}
	gasCost := new(big.Int).Mul(gas, price)
	if gasCost.Cmp(big.NewInt(faucetGasCostCapWei)) > 0 {
		return "FAUCET_UNAVAILABLE"
	}
	cost := new(big.Int).Add(value, gasCost)
	balance, e := s.faucetNumber(ctx, "eth_getBalance", []any{sender, "pending"})
	if e != nil {
		return "UPSTREAM_UNAVAILABLE"
	}
	required := new(big.Int).Set(cost)
	for _, old := range s.faucetClaims {
		if old["senderAddress"] == sender && old["status"] != "confirmed" && old["status"] != "failed" {
			required.Add(required, integer(old["reservedNative"]))
		}
	}
	if balance.Cmp(required) < 0 {
		return "FAUCET_EMPTY"
	}
	signed, e := types.SignTx(types.NewTx(&types.LegacyTx{Nonce: nonce.Uint64(), GasPrice: price, Gas: gas.Uint64(), To: &to, Value: value}), types.LatestSignerForChainID(big.NewInt(421614)), key)
	if e != nil {
		return "FAUCET_UNAVAILABLE"
	}
	raw, e := signed.MarshalBinary()
	if e != nil {
		return "FAUCET_UNAVAILABLE"
	}
	claim["raw"] = "0x" + hex.EncodeToString(raw)
	claim["transactionHash"] = strings.ToLower(signed.Hash().Hex())
	claim["attempts"] = []any{J{"raw": claim["raw"], "transactionHash": claim["transactionHash"]}}
	claim["senderAddress"] = sender
	claim["senderNonce"] = nonce.String()
	claim["reservedNative"] = cost.String()
	return ""
}
func (s *server) broadcastFaucet(ctx context.Context, id string) (J, error) {
	return s.broadcastFaucetChecked(ctx, id, false)
}
func (s *server) broadcastFaucetChecked(ctx context.Context, id string, evidenceChecked bool) (J, error) {
	var claim J
	if e := s.relayChange(ctx, func() error { claim = clone(s.faucetClaims[id]); return nil }); e != nil {
		return nil, e
	}
	if !s.faucetEnabled() {
		return faucetView(claim), nil
	}
	raw, ok := claim["raw"].(string)
	if !ok || claim["status"] == "submitted" || claim["status"] == "confirmed" || claim["status"] == "failed" {
		return faucetView(claim), nil
	}
	if claim["status"] == "unknown" && !evidenceChecked {
		observed, reason, actual := s.faucetEvidence(ctx, claim)
		if observed != "" {
			return s.saveFaucetObservation(ctx, id, observed, reason, actual)
		}
	}
	status, code := "submitted", ""
	expectedHash := ""
	chain, e := s.faucetNumber(ctx, "eth_chainId", []any{})
	if e != nil || chain.String() != "421614" {
		status, code = "unknown", "UPSTREAM_UNAVAILABLE"
	} else {
		if claim["status"] == "unknown" {
			claim, e = s.bumpFaucetFee(ctx, id, raw)
			if e != nil {
				return nil, e
			}
			if claim["status"] == "confirmed" || claim["status"] == "failed" {
				return faucetView(claim), nil
			}
			raw = faucetText(claim, "raw")
		}
		encoded, decodeErr := hex.DecodeString(strings.TrimPrefix(raw, "0x"))
		if decodeErr != nil {
			return nil, decodeErr
		}
		transaction := new(types.Transaction)
		if decodeErr = transaction.UnmarshalBinary(encoded); decodeErr != nil {
			return nil, decodeErr
		}
		expectedHash = strings.ToLower(transaction.Hash().Hex())
		var hash string
		e = rpcJSON(ctx, s.c.RPCURL, "eth_sendRawTransaction", []any{raw}, &hash)
		if e != nil || !strings.EqualFold(hash, expectedHash) {
			status, code = "unknown", "UPSTREAM_UNAVAILABLE"
		}
	}
	var result J
	e = s.relayChange(ctx, func() error {
		record := s.faucetClaims[id]
		if record["status"] != "confirmed" && record["status"] != "failed" && record["raw"] == raw {
			record["status"] = status
			if expectedHash != "" {
				record["transactionHash"] = expectedHash
			}
			if code != "" {
				record["failureCode"] = code
			} else {
				delete(record, "failureCode")
			}
			record["updatedAt"] = strconv.FormatInt(s.c.Clock().Unix(), 10)
		}
		result = faucetView(record)
		return nil
	})
	return result, e
}
