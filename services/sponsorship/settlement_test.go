package sponsorship_test

import (
	wallet "abstract-wallet/services/sponsorship"
	"context"
	"strings"
	"testing"
)

func TestSettlementAndReorgMoveDisjointBudgetAmountsExactlyOnce(t *testing.T) {
	c := postgresConfig(t)
	svc := wallet.NewService(c)
	token, _, _ := signIn(t, svc, "00000001")
	status, record := reserve(t, svc, token, "settlement_00001")
	if status != 201 {
		t.Fatalf("reserve=%d %v", status, record)
	}
	ev := wallet.SettlementEvent{ChainID: "421614", EntryPoint: ep, SponsorshipID: record["sponsorshipId"].(string), EventID: "fixture_event_00001", BlockHash: "0x" + strings.Repeat("11", 32), TransactionHash: "0x" + strings.Repeat("22", 32), LogIndex: "0", Phase: "pending", ActualCostNative: "25"}
	check := func(s, p, r, a string) {
		t.Helper()
		_, result := request(t, svc, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
		b := result["accountBudget"].(map[string]any)
		for k, want := range map[string]string{"settledNative": s, "pendingNative": p, "reservedRiskNative": r, "availableNative": a} {
			if b[k] != want {
				t.Fatalf("%s=%v want%s budget=%v", k, b[k], want, b)
			}
		}
	}
	if e := svc.ApplySettlement(context.Background(), ev); e != nil {
		t.Fatal(e)
	}
	check("0", "25", "15", "60")
	ev.Phase = "removed"
	if e := svc.ApplySettlement(context.Background(), ev); e != nil {
		t.Fatal(e)
	}
	check("0", "0", "40", "60")
	ev.EventID = "fixture_event_00002"
	ev.BlockHash = "0x" + strings.Repeat("33", 32)
	ev.Phase = "finalized"
	if e := svc.ApplySettlement(context.Background(), ev); e != nil {
		t.Fatal(e)
	}
	check("25", "0", "0", "75")
	if e := svc.ApplySettlement(context.Background(), ev); e != nil {
		t.Fatal(e)
	}
	check("25", "0", "0", "75")
}
