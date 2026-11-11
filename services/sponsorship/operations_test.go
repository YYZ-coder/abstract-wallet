package sponsorship_test

import (
	wallet "abstract-wallet/services/sponsorship"
	"strings"
	"testing"
)

func TestClientOperationClaimsCannotCreateVerifiedExecution(t *testing.T) {
	h := wallet.New(sponsorConfig(t))
	token, _, _ := signIn(t, h, "00000001")
	hash := "0x" + strings.Repeat("55", 32)
	b := map[string]any{"schemaVersion": "1", "idempotencyKey": "register_op_000001", "manifestVersion": "arb-sepolia-mvp-v1", "chainId": "421614", "entryPoint": ep, "account": accountA, "userOpHash": hash, "nonce": "0", "expectedDelegate": delegate, "reportedTransactionHash": "0x" + strings.Repeat("66", 32), "attempts": []any{map[string]any{"attemptId": "attempt_0000000001", "bundlerId": "bundler_0000000001", "attemptedAt": "1800000000", "reportedResult": "accepted", "reportedTransactionHash": nil}}}
	status, registered := request(t, h, "POST", "/v1/operations", body(b), token)
	if status != 201 {
		t.Fatalf("register=%d %v", status, registered)
	}
	status, op := request(t, h, "GET", "/v1/operations/"+hash+"?chainId=421614&entryPoint="+ep, "", "")
	if status != 200 || op["submissionState"] != "unknown" || op["executionState"] != "unknown" || op["confirmationState"] != "unknown" {
		t.Fatalf("client claim became truth: %d %v", status, op)
	}
	for _, field := range []string{"sender", "nonce", "manifestVersion", "expectedDelegate", "observedDelegate", "observedAccountNonce", "delegationObservation"} {
		if op[field] != nil {
			t.Fatalf("untrusted claim populated %s=%v", field, op[field])
		}
	}
}
