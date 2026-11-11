package sponsorship

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
)

// SettlementEvent is accepted only from the trusted in-process chain adapter.
// This method is never mounted as an HTTP mutation endpoint.
type SettlementEvent struct{ ChainID, EntryPoint, SponsorshipID, EventID, BlockHash, TransactionHash, LogIndex, Phase, ActualCostNative string }
type Service struct{ core *server }

func NewService(c Config) *Service                                  { return &Service{New(c).(*server)} }
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.core.ServeHTTP(w, r) }
func (s *Service) ApplySettlement(ctx context.Context, event SettlementEvent) error {
	core := s.core
	core.requestMu.Lock()
	defer core.requestMu.Unlock()
	var applyErr error
	if core.c.Store != nil {
		e := core.c.Store.update(ctx, func(state *snapshot) error {
			core.restore(state)
			applyErr = core.applySettlement(event)
			*state = *core.snapshot()
			return nil
		})
		if e != nil {
			return e
		}
		return applyErr
	}
	core.mu.Lock()
	defer core.mu.Unlock()
	return core.applySettlement(event)
}
func (s *server) applySettlement(e SettlementEvent) error {
	r := s.records[e.SponsorshipID]
	if r == nil || e.ChainID != s.c.Manifest["chainId"] || r["chainId"] != e.ChainID || r["entryPoint"] != e.EntryPoint {
		return fmt.Errorf("settlement identity mismatch")
	}
	if e.Phase != "pending" && e.Phase != "finalized" && e.Phase != "removed" {
		return fmt.Errorf("unsupported settlement phase")
	}
	if len(e.BlockHash) != 66 || len(e.TransactionHash) != 66 || !strings.HasPrefix(e.BlockHash, "0x") || !strings.HasPrefix(e.TransactionHash, "0x") {
		return fmt.Errorf("missing chain evidence")
	}
	a := r["accounting"].(map[string]any)
	amount := integer(a["reservationAmountNative"])
	cost, ok := new(big.Int).SetString(e.ActualCostNative, 10)
	if !ok || cost.Sign() < 0 || cost.String() != e.ActualCostNative || cost.Cmp(amount) > 0 {
		r["state"] = "reconciliation_required"
		a["state"] = "reconciliation_required"
		s.blocked = true
		return fmt.Errorf("unknown or over-reservation actual cost")
	}
	identity := e.ChainID + ":" + e.BlockHash + ":" + e.TransactionHash + ":" + e.LogIndex
	raw, _ := json.Marshal(e)
	var value J
	_ = json.Unmarshal(raw, &value)
	if previous := s.settlementEvents[identity]; previous != nil {
		if previous["ActualCostNative"] != e.ActualCostNative || previous["SponsorshipID"] != e.SponsorshipID {
			return fmt.Errorf("conflicting settlement evidence")
		}
		if previous["Phase"] == e.Phase {
			return nil
		}
		if previous["Phase"] == "removed" && e.Phase != "removed" {
			return fmt.Errorf("removed event cannot become canonical without new evidence")
		}
	}
	if e.Phase == "removed" {
		if a["state"] == "settled" {
			s.blocked = true
			r["state"] = "reconciliation_required"
			a["state"] = "reconciliation_required"
		} else {
			r["state"] = "issued"
			a["state"] = "reserved"
		}
		a["settledNative"] = "0"
		a["pendingNative"] = "0"
		a["reservedRiskNative"] = amount.String()
		a["releasedNative"] = "0"
	} else if e.Phase == "pending" {
		if a["state"] == "settled" {
			return fmt.Errorf("cannot demote settled event without reorg evidence")
		}
		a["state"] = "pending"
		a["settledNative"] = "0"
		a["pendingNative"] = cost.String()
		a["reservedRiskNative"] = new(big.Int).Sub(amount, cost).String()
		a["releasedNative"] = "0"
	} else {
		r["state"] = "settled"
		a["state"] = "settled"
		a["settledNative"] = cost.String()
		a["pendingNative"] = "0"
		a["reservedRiskNative"] = "0"
		a["releasedNative"] = new(big.Int).Sub(amount, cost).String()
	}
	s.settlementEvents[identity] = value
	return nil
}
