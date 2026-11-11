package sponsorship

import (
	"context"
	"encoding/hex"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/holiman/uint256"
)

func fromHex(s string) *big.Int {
	n := new(big.Int)
	n.SetString(strings.TrimPrefix(s, "0x"), 16)
	return n
}
func (s *server) prepareRelay(ctx context.Context, b J) (int, J) {
	if b["manifestVersion"] != s.c.Manifest["manifestVersion"] {
		return 409, failure("MANIFEST_CHANGED")
	}
	key := b["account"].(string) + ":" + b["chainId"].(string) + ":" + b["idempotencyKey"].(string)
	fp := fingerprint("relayDelegation", s.c.ProjectID, b["account"].(string), b["chainId"].(string), b)
	if old, ok := s.relayIdempotency[key]; ok {
		if old["fingerprint"] != fp {
			return 409, failure("IDEMPOTENCY_CONFLICT")
		}
		return 200, s.relays[old["relayId"].(string)]
	}
	allowed := false
	for _, a := range s.c.RelayAllowedAccounts {
		allowed = allowed || a == b["account"]
	}
	private, e := crypto.HexToECDSA(strings.TrimPrefix(s.c.RelayPrivateKey, "0x"))
	if !allowed || e != nil {
		return 403, failure("RELAY_DENIED")
	}
	relayer := strings.ToLower(crypto.PubkeyToAddress(private.PublicKey).Hex())
	if relayer == b["account"] {
		return 403, failure("RELAY_DENIED")
	}
	auth := b["authorization"].(map[string]any)
	context := J{"chainId": b["chainId"], "address": b["expectedDelegate"], "nonce": auth["nonce"]}
	if b["chainId"] != s.c.Manifest["chainId"] || !validAuthorization(auth, context, b["account"].(string)) {
		return 422, failure("INVALID_AUTHORIZATION")
	}
	tuple := authTuple(auth)
	digest := tuple.SigHash().Hex()
	dedup := b["chainId"].(string) + ":" + b["account"].(string) + ":" + digest
	if id := s.relayAuthorizationIDs[dedup]; id != "" {
		s.relayIdempotency[key] = J{"fingerprint": fp, "relayId": id}
		return 200, s.relays[id]
	}
	conflict := b["chainId"].(string) + ":" + b["account"].(string) + ":" + auth["nonce"].(string)
	if old := s.relayConflicts[conflict]; old != "" && old != digest {
		return 409, failure("DELEGATION_CONFLICT")
	}
	if b["action"] == "revoke" {
		if b["expectedDelegate"] != "0x"+strings.Repeat("0", 40) {
			return 422, failure("INVALID_AUTHORIZATION")
		}
	} else {
		dep, ok := s.c.Manifest["delegate"].(map[string]any)
		if !ok || dep["address"] != b["expectedDelegate"] {
			return 422, failure("DEPLOYMENT_MISMATCH")
		}
		code, e := rpc(ctx, s.c.RPCURL, "eth_getCode", []any{b["expectedDelegate"], "latest"})
		raw, _ := hex.DecodeString(strings.TrimPrefix(code, "0x"))
		if e != nil || len(raw) == 0 || crypto.Keccak256Hash(raw).Hex() != dep["runtimeCodeHash"] {
			return 422, failure("DEPLOYMENT_MISMATCH")
		}
	}
	chain, e := rpc(ctx, s.c.RPCURL, "eth_chainId", []any{})
	if e != nil {
		return 503, failure("UPSTREAM_UNAVAILABLE")
	}
	if fromHex(chain).String() != b["chainId"] {
		return 422, failure("DEPLOYMENT_MISMATCH")
	}
	nonce, e := rpc(ctx, s.c.RPCURL, "eth_getTransactionCount", []any{b["account"], "pending"})
	if e != nil {
		return 503, failure("UPSTREAM_UNAVAILABLE")
	}
	if fromHex(nonce).Cmp(integer(auth["nonce"])) != 0 {
		return 409, failure("NONCE_CHANGED")
	}
	safe := "0x" + strings.Repeat("0", 40)
	code, e := rpc(ctx, s.c.RPCURL, "eth_getCode", []any{safe, "latest"})
	if e != nil {
		return 503, failure("UPSTREAM_UNAVAILABLE")
	}
	if code != "0x" {
		return 403, failure("RELAY_DENIED")
	}
	nonce, e = rpc(ctx, s.c.RPCURL, "eth_getTransactionCount", []any{relayer, "pending"})
	if e != nil {
		return 503, failure("UPSTREAM_UNAVAILABLE")
	}
	next := fromHex(nonce)
	if next.Cmp(integer(s.relayNextNonce)) < 0 {
		next = integer(s.relayNextNonce)
	}
	if next.BitLen() > 64 || next.Uint64() == ^uint64(0) {
		return 409, failure("NONCE_CHANGED")
	}
	price, e := rpc(ctx, s.c.RPCURL, "eth_gasPrice", []any{})
	if e != nil {
		return 503, failure("UPSTREAM_UNAVAILABLE")
	}
	txArgs := J{"from": relayer, "to": safe, "value": "0x0", "data": "0x", "type": "0x4", "authorizationList": []types.SetCodeAuthorization{tuple}}
	gas, e := rpc(ctx, s.c.RPCURL, "eth_estimateGas", []any{txArgs})
	if e != nil {
		return 503, failure("UPSTREAM_UNAVAILABLE")
	}
	gasN, fee := fromHex(gas), fromHex(price)
	if gasN.Sign() <= 0 || gasN.BitLen() > 64 || fee.Sign() <= 0 || fee.BitLen() > 256 {
		return 422, failure("COST_CAP_EXCEEDED")
	}
	cost := new(big.Int).Mul(gasN, fee)
	if cost.Cmp(integer(b["maxRelayCostNative"])) > 0 || cost.Cmp(integer(s.c.MaxRelayCostWei)) > 0 {
		return 422, failure("COST_CAP_EXCEEDED")
	}
	accountKey := "relay:" + b["account"].(string)
	for k, total := range map[string]string{accountKey: s.c.RelayUserBudgetWei, "relay:chain": s.c.RelayChainBudgetWei} {
		used := s.risk[k]
		if used == nil {
			used = new(big.Int)
		}
		if new(big.Int).Add(used, cost).Cmp(integer(total)) > 0 {
			return 409, failure("BUDGET_EXCEEDED")
		}
	}
	for _, k := range []string{accountKey, "relay:chain"} {
		if s.risk[k] == nil {
			s.risk[k] = new(big.Int)
		}
		s.risk[k].Add(s.risk[k], cost)
	}
	s.relayNextNonce = new(big.Int).Add(next, big.NewInt(1)).String()
	id := identifier()
	now := strconv.FormatInt(s.c.Clock().Unix(), 10)
	record := J{"relayId": id, "chainId": b["chainId"], "account": b["account"], "action": b["action"], "expectedDelegate": b["expectedDelegate"], "authorizationDigest": digest, "authorizationNonce": auth["nonce"], "relayerAddress": relayer, "relayerNonce": next.String(), "broadcastState": "queued", "authorizationState": "unknown", "confirmationState": "unknown", "transactionHashes": []any{}, "observedDelegate": nil, "observedAccountNonce": nil, "cost": J{"reservedNative": cost.String(), "actualNative": nil, "maxRelayCostNative": b["maxRelayCostNative"], "currency": J{"symbol": "ETH", "decimals": "18"}, "confirmationState": "unknown"}, "chainObservation": nil, "evidence": []any{}, "createdAt": now, "updatedAt": now}
	s.relays[id] = record
	s.relayPending[id] = J{"authorization": auth, "gas": gasN.String(), "fee": fee.String(), "raw": nil}
	s.relayAuthorizationIDs[dedup] = id
	s.relayConflicts[conflict] = digest
	s.relayIdempotency[key] = J{"fingerprint": fp, "relayId": id}
	return 202, record
}
func (s *server) relayChange(ctx context.Context, fn func() error) error {
	if s.c.Store == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		return fn()
	}
	return s.c.Store.update(ctx, func(state *snapshot) error {
		s.restore(state)
		e := fn()
		if e != nil {
			return e
		}
		*state = *s.snapshot()
		return nil
	})
}
func (s *server) broadcastRelay(ctx context.Context, id string) (J, error) {
	var record, pending J
	if e := s.relayChange(ctx, func() error { record = clone(s.relays[id]); pending = clone(s.relayPending[id]); return nil }); e != nil {
		return nil, e
	}
	if record["broadcastState"] == "broadcast" {
		return record, nil
	}
	raw, ok := pending["raw"].(string)
	if !ok {
		key, e := crypto.HexToECDSA(strings.TrimPrefix(s.c.RelayPrivateKey, "0x"))
		if e != nil {
			return nil, e
		}
		auth := authTuple(pending["authorization"].(map[string]any))
		tx := types.NewTx(&types.SetCodeTx{ChainID: uint256.MustFromBig(integer(record["chainId"])), Nonce: integer(record["relayerNonce"]).Uint64(), GasTipCap: uint256.MustFromBig(integer(pending["fee"])), GasFeeCap: uint256.MustFromBig(integer(pending["fee"])), Gas: integer(pending["gas"]).Uint64(), To: common.Address{}, Value: new(uint256.Int), Data: []byte{}, AuthList: []types.SetCodeAuthorization{auth}})
		signed, e := types.SignTx(tx, types.LatestSignerForChainID(integer(record["chainId"])), key)
		if e != nil {
			return nil, e
		}
		encoded, e := signed.MarshalBinary()
		if e != nil {
			return nil, e
		}
		raw = "0x" + hex.EncodeToString(encoded)
		if e = s.relayChange(ctx, func() error {
			s.relayPending[id]["raw"] = raw
			s.relays[id]["broadcastState"] = "signed"
			s.relays[id]["transactionHashes"] = []any{strings.ToLower(signed.Hash().Hex())}
			return nil
		}); e != nil {
			return nil, e
		}
		record["transactionHashes"] = []any{strings.ToLower(signed.Hash().Hex())}
	}
	expectedHash := record["transactionHashes"].([]any)[0].(string)
	sent, e := rpc(ctx, s.c.RPCURL, "eth_sendRawTransaction", []any{raw})
	state := "broadcast"
	if e != nil || !strings.EqualFold(sent, expectedHash) {
		state = "unknown"
	}
	var out J
	saveErr := s.relayChange(ctx, func() error {
		s.relays[id]["broadcastState"] = state
		s.relays[id]["updatedAt"] = strconv.FormatInt(s.c.Clock().Unix(), 10)
		out = clone(s.relays[id])
		return nil
	})
	if saveErr != nil {
		return nil, fmt.Errorf("broadcast result not persisted")
	}
	return out, nil
}
