package sponsorship

import (
	"context"
	"encoding/hex"
	"fmt"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"math/big"
	"strings"
)

const faucetGasCostCapWei int64 = 100000000000000
const faucetMaxAttempts = 4

func faucetAttempts(claim J) []J {
	if values, ok := claim["attempts"].([]any); ok {
		out := make([]J, 0, len(values))
		for _, value := range values {
			if record, ok := value.(map[string]any); ok {
				out = append(out, record)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	if claim["raw"] != nil {
		return []J{{"raw": claim["raw"], "transactionHash": claim["transactionHash"]}}
	}
	return nil
}
func faucetDecodeAttempt(attempt J) (*types.Transaction, error) {
	raw, e := hex.DecodeString(strings.TrimPrefix(faucetText(attempt, "raw"), "0x"))
	if e != nil {
		return nil, e
	}
	tx := new(types.Transaction)
	if e = tx.UnmarshalBinary(raw); e != nil {
		return nil, e
	}
	if !strings.EqualFold(tx.Hash().Hex(), faucetText(attempt, "transactionHash")) {
		return nil, fmt.Errorf("attempt hash mismatch")
	}
	return tx, nil
}

// The row lock covers the current highest attempt, nonce, reservation and append.
// Signing is offline; its bytes commit before any broadcast is permitted.
func (s *server) bumpFaucetFee(ctx context.Context, id string, expectedRaw string) (J, error) {
	var result J
	e := s.relayChange(ctx, func() error {
		record := s.faucetClaims[id]
		result = clone(record)
		if record["status"] != "unknown" || !s.faucetEnabled() || record["raw"] != expectedRaw {
			return nil
		}
		attempts := faucetAttempts(record)
		if len(attempts) >= faucetMaxAttempts {
			return nil
		}
		var highest *types.Transaction
		for _, attempt := range attempts {
			tx, e := faucetDecodeAttempt(attempt)
			if e != nil {
				return e
			}
			if highest == nil || tx.GasPrice().Cmp(highest.GasPrice()) > 0 {
				highest = tx
			}
		}
		if highest == nil {
			return nil
		}
		key, e := crypto.HexToECDSA(strings.TrimPrefix(s.c.FaucetPrivateKey, "0x"))
		if e != nil {
			return nil
		}
		sender := crypto.PubkeyToAddress(key.PublicKey)
		actual, e := types.Sender(types.LatestSignerForChainID(big.NewInt(421614)), highest)
		if e != nil || actual != sender || !strings.EqualFold(sender.Hex(), faucetText(record, "senderAddress")) || highest.Type() != types.LegacyTxType || highest.ChainId().String() != "421614" || highest.Nonce() != integer(record["senderNonce"]).Uint64() || highest.To() == nil || *highest.To() != common.HexToAddress(faucetText(record, "address")) || highest.Value().String() != "1000000000000000" || len(highest.Data()) != 0 {
			return nil
		}
		sample, e := s.faucetNumber(ctx, "eth_gasPrice", []any{})
		if e != nil || sample.Sign() <= 0 {
			return nil
		}
		target := new(big.Int).Mul(sample, big.NewInt(2))
		if highest.GasPrice().Cmp(target) >= 0 {
			return nil
		}
		minimum := new(big.Int).Mul(highest.GasPrice(), big.NewInt(9))
		minimum.Add(minimum, big.NewInt(7)).Div(minimum, big.NewInt(8))
		if target.Cmp(minimum) < 0 {
			target = minimum
		}
		gasCost := new(big.Int).Mul(new(big.Int).SetUint64(highest.Gas()), target)
		if target.BitLen() > 256 || gasCost.Cmp(big.NewInt(faucetGasCostCapWei)) > 0 {
			return nil
		}
		cost := new(big.Int).Add(big.NewInt(1000000000000000), gasCost)
		required := new(big.Int).Set(cost)
		for otherID, other := range s.faucetClaims {
			if otherID != id && other["senderAddress"] == record["senderAddress"] && other["status"] != "confirmed" && other["status"] != "failed" {
				required.Add(required, integer(other["reservedNative"]))
			}
		}
		balance, e := s.faucetNumber(ctx, "eth_getBalance", []any{strings.ToLower(sender.Hex()), "pending"})
		if e != nil || balance.Cmp(required) < 0 {
			return nil
		}
		replacement, e := types.SignTx(types.NewTx(&types.LegacyTx{Nonce: highest.Nonce(), GasPrice: target, Gas: highest.Gas(), To: highest.To(), Value: highest.Value(), Data: highest.Data()}), types.LatestSignerForChainID(big.NewInt(421614)), key)
		if e != nil {
			return e
		}
		raw, e := replacement.MarshalBinary()
		if e != nil {
			return e
		}
		encoded := "0x" + hex.EncodeToString(raw)
		hash := strings.ToLower(replacement.Hash().Hex())
		stored := make([]any, 0, len(attempts)+1)
		for _, attempt := range attempts {
			stored = append(stored, attempt)
		}
		stored = append(stored, J{"raw": encoded, "transactionHash": hash})
		record["attempts"] = stored
		record["raw"] = encoded
		record["transactionHash"] = hash
		record["reservedNative"] = cost.String()
		result = clone(record)
		return nil
	})
	return result, e
}
