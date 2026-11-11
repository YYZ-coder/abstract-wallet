package sponsorship_test

import (
	wallet "abstract-wallet/services/sponsorship"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
)

func TestIssuedPermitMatchesIndependentViemReference(t *testing.T) {
	c := sponsorConfig(t)
	c.SponsorPrivateKey = strings.Repeat("0", 63) + "1"
	h := wallet.New(c)
	token, _, _ := signIn(t, h, "00000001")
	b := sponsorBody(t, "reference_prepare_001")
	status, q := request(t, h, "POST", "/v1/sponsorships/prepare", body(b), token)
	if status != 201 {
		t.Fatalf("prepare=%d %v", status, q)
	}
	b["quoteId"] = q["quoteId"]
	b["idempotencyKey"] = "reference_reserve_001"
	status, result := request(t, h, "POST", "/v1/sponsorships", body(b), token)
	if status != 201 {
		t.Fatalf("issue=%d %v", status, result)
	}
	p := result["permit"].(map[string]any)
	cmd := exec.Command("node", "testdata/check_permit.mjs")
	cmd.Stdin = strings.NewReader(body(map[string]any{"request": b, "permit": p}))
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("independent viem reference unavailable: %v %s", e, out)
	}
	var reference map[string]any
	if e = json.Unmarshal(out, &reference); e != nil {
		t.Fatal(e)
	}
	if reference["digest"] != p["permitDigest"] || reference["data"] != p["paymasterData"] || reference["signer"] != "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf" {
		t.Fatalf("independent reference mismatch: reference=%v permit=%v", reference, p)
	}
}
