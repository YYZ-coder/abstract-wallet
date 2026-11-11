package sponsorship

import (
	"context"
	"math/big"
	"strconv"
	"strings"
)

func faucetText(record J, key string) string { v, _ := record[key].(string); return v }
func faucetQuantityEqual(value string, expected string) bool {
	if !faucetQuantityPattern.MatchString(value) {
		return false
	}
	n, ok := new(big.Int).SetString(value[2:], 16)
	return ok && n.String() == expected
}
func (s *server) observeFaucet(ctx context.Context, id string) (J, error) {
	var claim J
	if e := s.relayChange(ctx, func() error { claim = clone(s.faucetClaims[id]); return nil }); e != nil {
		return nil, e
	}
	if claim["raw"] == nil || claim["status"] == "failed" {
		return faucetView(claim), nil
	}
	status, code, actualHash := s.faucetEvidence(ctx, claim)
	if status == "" {
		if claim["status"] == "unknown" || claim["status"] == "pending" {
			return s.broadcastFaucetChecked(ctx, id, true)
		}
		return faucetView(claim), nil
	}
	return s.saveFaucetObservation(ctx, id, status, code, actualHash)
}
func (s *server) saveFaucetObservation(ctx context.Context, id, status, code, actualHash string) (J, error) {
	var out J
	e := s.relayChange(ctx, func() error {
		record := s.faucetClaims[id]
		record["status"] = status
		if actualHash != "" {
			record["transactionHash"] = actualHash
		}
		if status == "confirmed" {
			if record["confirmedObservedAt"] == nil {
				record["confirmedObservedAt"] = strconv.FormatInt(s.c.Clock().Unix(), 10)
			}
		} else {
			delete(record, "confirmedObservedAt")
		}
		if code != "" {
			record["failureCode"] = code
		} else {
			delete(record, "failureCode")
		}
		out = faucetView(record)
		return nil
	})
	return out, e
}
func (s *server) faucetEvidence(ctx context.Context, claim J) (string, string, string) {
	chain, e := s.faucetNumber(ctx, "eth_chainId", []any{})
	if e != nil || chain.String() != "421614" {
		return "unknown", "UPSTREAM_UNAVAILABLE", ""
	}
	failedCode, failedHash := "", ""
	uncertain := false
	for _, attempt := range faucetAttempts(claim) {
		hash := faucetText(attempt, "transactionHash")
		status, code := s.faucetAttemptEvidence(ctx, claim, hash)
		if status == "confirmed" {
			return status, "", hash
		}
		if status == "failed" {
			failedCode, failedHash = code, hash
		}
		if status == "unknown" {
			uncertain = true
		}
	}
	if failedCode != "" {
		return "failed", failedCode, failedHash
	}
	if uncertain || claim["status"] == "confirmed" {
		return "unknown", "UPSTREAM_UNAVAILABLE", ""
	}
	return "", "", ""
}
func (s *server) faucetAttemptEvidence(ctx context.Context, claim J, hash string) (string, string) {
	var e error
	var receipt J
	if e = rpcJSON(ctx, s.c.RPCURL, "eth_getTransactionReceipt", []any{hash}, &receipt); e != nil {
		return "unknown", "UPSTREAM_UNAVAILABLE"
	}
	if receipt == nil {
		return "", ""
	}
	if !strings.EqualFold(faucetText(receipt, "transactionHash"), hash) {
		return "failed", "FAUCET_TRANSACTION_MISMATCH"
	}
	status := faucetText(receipt, "status")
	if status != "0x1" && status != "0x0" {
		return "unknown", "UPSTREAM_UNAVAILABLE"
	}
	var transaction J
	if e = rpcJSON(ctx, s.c.RPCURL, "eth_getTransactionByHash", []any{hash}, &transaction); e != nil || transaction == nil {
		return "unknown", "UPSTREAM_UNAVAILABLE"
	}
	for key, expected := range map[string]string{"hash": hash, "from": faucetText(claim, "senderAddress"), "to": faucetText(claim, "address"), "input": "0x"} {
		if !strings.EqualFold(faucetText(transaction, key), expected) {
			return "failed", "FAUCET_TRANSACTION_MISMATCH"
		}
	}
	for key, expected := range map[string]string{"value": "1000000000000000", "chainId": "421614", "nonce": faucetText(claim, "senderNonce")} {
		if !faucetQuantityEqual(faucetText(transaction, key), expected) {
			return "failed", "FAUCET_TRANSACTION_MISMATCH"
		}
	}
	for key, expected := range map[string]string{"from": faucetText(claim, "senderAddress"), "to": faucetText(claim, "address")} {
		if !strings.EqualFold(faucetText(receipt, key), expected) {
			return "failed", "FAUCET_TRANSACTION_MISMATCH"
		}
	}
	blockHash, blockNumber := faucetText(receipt, "blockHash"), faucetText(receipt, "blockNumber")
	if _, valid := eventBytes(blockHash, 32); !valid || !faucetQuantityPattern.MatchString(blockNumber) || !strings.EqualFold(faucetText(transaction, "blockHash"), blockHash) || faucetText(transaction, "blockNumber") != blockNumber {
		return "unknown", "UPSTREAM_UNAVAILABLE"
	}
	var block J
	if e = rpcJSON(ctx, s.c.RPCURL, "eth_getBlockByNumber", []any{blockNumber, false}, &block); e != nil || block == nil || !strings.EqualFold(faucetText(block, "hash"), blockHash) || faucetText(block, "number") != blockNumber {
		return "unknown", "UPSTREAM_UNAVAILABLE"
	}
	if status == "0x0" {
		return "failed", "FAUCET_TRANSFER_FAILED"
	}
	return "confirmed", ""
}
