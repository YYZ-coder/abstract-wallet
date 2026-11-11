package sponsorship

import (
	"context"
	"fmt"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"io"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var faucetClaimPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
var faucetKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)

func (s *server) serveTestFunds(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/test-funds/claims/") {
		id := strings.TrimPrefix(r.URL.Path, "/v1/test-funds/claims/")
		if !faucetClaimPattern.MatchString(id) {
			write(w, 400, failure("INVALID_REQUEST"))
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		claim := s.faucetClaims[id]
		if claim == nil {
			write(w, 404, failure("RESOURCE_NOT_FOUND"))
			return
		}
		write(w, 200, faucetView(claim))
		return
	}
	if r.Method != http.MethodPost || r.URL.Path != "/v1/test-funds/claims" {
		http.NotFound(w, r)
		return
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 8193))
	if e != nil || len(raw) > 8192 || r.Header.Get("Content-Type") != "application/json" {
		write(w, 400, failure("INVALID_REQUEST"))
		return
	}
	b, e := decodeBody(raw)
	if e != nil || len(b) != 4 || b["schemaVersion"] != "1" {
		write(w, 400, failure("INVALID_REQUEST"))
		return
	}
	chain, ok := b["chainId"].(string)
	address, aok := b["address"].(string)
	key, kok := b["idempotencyKey"].(string)
	if !ok || !aok || !kok || !faucetKeyPattern.MatchString(key) || len(address) != 42 || !strings.HasPrefix(address, "0x") || !common.IsHexAddress(address) || common.HexToAddress(address) == (common.Address{}) {
		write(w, 400, failure("INVALID_REQUEST"))
		return
	}
	if chain != "421614" {
		write(w, 422, failure("UNSUPPORTED_CHAIN"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	address = strings.ToLower(address)
	for _, claim := range s.faucetClaims {
		if claim["idempotencyKey"] == key {
			if claim["address"] != address || claim["chainId"] != chain {
				write(w, 409, failure("IDEMPOTENCY_CONFLICT"))
				return
			}
			write(w, 200, faucetView(claim))
			return
		}
	}
	if !s.faucetEnabled() {
		write(w, 503, failure("FAUCET_UNAVAILABLE"))
		return
	}
	now := s.c.Clock()
	dailyUsed := new(big.Int)
	for _, claim := range s.faucetClaims {
		created, _ := strconv.ParseInt(claim["createdAt"].(string), 10, 64)
		at := time.Unix(created, 0)
		settled := time.Time{}
		if raw, ok := claim["confirmedObservedAt"].(string); ok {
			stamp, _ := strconv.ParseInt(raw, 10, 64)
			settled = time.Unix(stamp, 0)
		}
		cooldownAt := at
		if settled.After(cooldownAt) {
			cooldownAt = settled
		}
		unresolved := claim["raw"] != nil && claim["status"] != "confirmed" && claim["status"] != "failed"
		if claim["address"] == address && (unresolved || now.Before(cooldownAt.Add(24*time.Hour))) {
			write(w, 429, failure("FAUCET_COOLDOWN"))
			return
		}
		if unresolved || at.UTC().Format("2006-01-02") == now.UTC().Format("2006-01-02") || (!settled.IsZero() && settled.UTC().Format("2006-01-02") == now.UTC().Format("2006-01-02")) {
			dailyUsed.Add(dailyUsed, integer(claim["amountWei"]))
		}
	}
	if new(big.Int).Add(dailyUsed, big.NewInt(1000000000000000)).Cmp(s.faucetBudget()) > 0 {
		write(w, 429, failure("FAUCET_BUDGET_EXCEEDED"))
		return
	}
	if s.c.RPCURL != "" {
		if code := s.faucetPreflight(r.Context()); code != "" {
			write(w, 503, failure(code))
			return
		}
	}
	amount := s.c.FaucetAmountWei
	if amount == "" {
		amount = "1000000000000000"
	}
	claim := J{"claimId": identifier(), "chainId": chain, "address": address, "amountWei": amount, "status": "pending", "idempotencyKey": key, "createdAt": strconv.FormatInt(now.Unix(), 10)}
	if s.c.RPCURL != "" {
		if code := s.signFaucetTransfer(r.Context(), claim); code != "" {
			write(w, 503, failure(code))
			return
		}
	}
	s.faucetClaims[claim["claimId"].(string)] = claim
	write(w, 202, faucetView(claim))
}

func faucetView(claim J) J {
	out := J{}
	for _, key := range []string{"claimId", "chainId", "address", "amountWei", "status", "transactionHash", "failureCode"} {
		if key == "failureCode" && claim["status"] != "failed" {
			continue
		}
		if value, ok := claim[key]; ok {
			out[key] = value
		}
	}
	return out
}

func (s *server) faucetBudget() *big.Int {
	raw := s.c.FaucetDailyBudgetWei
	if raw == "" {
		raw = "10000000000000000"
	}
	n, ok := new(big.Int).SetString(raw, 10)
	if !ok || n.Sign() <= 0 || n.Cmp(big.NewInt(10000000000000000)) > 0 {
		return nil
	}
	return n
}
func (s *server) faucetEnabled() bool {
	key, e := crypto.HexToECDSA(strings.TrimPrefix(s.c.FaucetPrivateKey, "0x"))
	if e != nil {
		return false
	}
	address := crypto.PubkeyToAddress(key.PublicKey)
	for _, raw := range []string{s.c.SponsorPrivateKey, s.c.RelayPrivateKey} {
		if other, e := crypto.HexToECDSA(strings.TrimPrefix(raw, "0x")); e == nil && crypto.PubkeyToAddress(other.PublicKey) == address {
			return false
		}
	}
	return (s.c.FaucetAmountWei == "" || s.c.FaucetAmountWei == "1000000000000000") && s.faucetBudget() != nil
}

var faucetQuantityPattern = regexp.MustCompile(`^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$`)

func (s *server) faucetNumber(ctx context.Context, method string, params []any) (*big.Int, error) {
	var value string
	if e := rpcJSON(ctx, s.c.RPCURL, method, params, &value); e != nil {
		return nil, e
	}
	if !faucetQuantityPattern.MatchString(value) {
		return nil, fmt.Errorf("invalid quantity")
	}
	n, ok := new(big.Int).SetString(value[2:], 16)
	if !ok || n.BitLen() > 256 {
		return nil, fmt.Errorf("invalid quantity")
	}
	return n, nil
}
func (s *server) faucetPreflight(ctx context.Context) string {
	chain, e := s.faucetNumber(ctx, "eth_chainId", []any{})
	if e != nil {
		return "UPSTREAM_UNAVAILABLE"
	}
	if chain.String() != "421614" || s.c.Manifest["chainId"] != "421614" {
		return "FAUCET_UNAVAILABLE"
	}
	key, _ := crypto.HexToECDSA(strings.TrimPrefix(s.c.FaucetPrivateKey, "0x"))
	sender := strings.ToLower(crypto.PubkeyToAddress(key.PublicKey).Hex())
	var code string
	if e = rpcJSON(ctx, s.c.RPCURL, "eth_getCode", []any{sender, "latest"}, &code); e != nil {
		return "UPSTREAM_UNAVAILABLE"
	}
	if code != "0x" {
		return "FAUCET_UNAVAILABLE"
	}
	balance, e := s.faucetNumber(ctx, "eth_getBalance", []any{sender, "pending"})
	if e != nil {
		return "UPSTREAM_UNAVAILABLE"
	}
	if balance.Cmp(big.NewInt(1000000000000000)) < 0 {
		return "FAUCET_EMPTY"
	}
	return ""
}
