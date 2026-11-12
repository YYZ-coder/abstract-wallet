package sponsorship_test

import (
	wallet "abstract-wallet/services/sponsorship"
	"context"
	"encoding/json"
	"fmt"
	"github.com/ethereum/go-ethereum/crypto"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
)

const indexedHash = "0x5555555555555555555555555555555555555555555555555555555555555555"
const indexedTx = "0x6666666666666666666666666666666666666666666666666666666666666666"
const indexedBlock = "0x1111111111111111111111111111111111111111111111111111111111111111"

type indexRPCFixture struct {
	event               map[string]any
	receipt             map[string]any
	nonce               string
	code                string
	canonicalHash       string
	blockResponses      map[string]any
	blockErrors         map[string]any
	beforeBlockResponse func(string)
}

func canonicalIndexFixture(t *testing.T) (wallet.Config, *indexRPCFixture) {
	t.Helper()
	c := sponsorConfig(t)
	c.IndexerConfigured = true
	c.IndexerStartBlock = 0
	c.Manifest["nativeCurrency"] = map[string]any{"symbol": "ETH", "decimals": "18"}
	c.Manifest["confirmationPolicy"] = map[string]any{"status": "draft", "policyId": nil, "requiredConfirmations": nil}
	event := map[string]any{"address": ep, "topics": []any{crypto.Keccak256Hash([]byte("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")).Hex(), indexedHash, "0x" + strings.Repeat("0", 24) + accountA[2:], "0x" + strings.Repeat("0", 64)}, "data": fmt.Sprintf("0x%064x%064x%064x%064x", 0, 1, 25, 20), "blockNumber": "0x64", "blockHash": indexedBlock, "transactionHash": indexedTx, "transactionIndex": "0x0", "logIndex": "0x0", "removed": false}
	f := &indexRPCFixture{event: event, receipt: map[string]any{"transactionHash": indexedTx, "blockHash": indexedBlock, "blockNumber": "0x64", "status": "0x1", "gasUsed": "0x5208", "effectiveGasPrice": "0x1", "logs": []any{event}}, nonce: "0x1", code: "0xef0100" + delegate[2:], canonicalHash: indexedBlock}
	rpcServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var q map[string]any
		_ = json.NewDecoder(r.Body).Decode(&q)
		var result any
		switch q["method"] {
		case "eth_chainId":
			result = "0x66eee"
		case "eth_getCode":
			if q["params"].([]any)[0] == accountA {
				result = f.code
			} else {
				result = "0x00"
			}
		case "eth_getTransactionCount":
			result = f.nonce
		case "eth_getLogs":
			result = []any{f.event}
		case "eth_getTransactionReceipt":
			result = f.receipt
		case "eth_getBlockByNumber":
			tag := q["params"].([]any)[0].(string)
			if f.beforeBlockResponse != nil {
				f.beforeBlockResponse(tag)
			}
			if response, configured := f.blockErrors[tag]; configured {
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": q["id"], "error": response})
				return
			}
			if response, configured := f.blockResponses[tag]; configured {
				result = response
			} else if tag == "latest" {
				result = map[string]any{"number": "0x65", "hash": "0x" + strings.Repeat("22", 32), "timestamp": "0x6b49d201"}
			} else {
				result = map[string]any{"number": "0x64", "hash": f.canonicalHash, "timestamp": "0x6b49d200"}
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": q["id"], "result": result})
	}))
	t.Cleanup(rpcServer.Close)
	c.RPCURL = rpcServer.URL
	return c, f
}

func TestIndexerArbitrumFinalityDoesNotFallBackToDepthWhenTagUnavailable(t *testing.T) {
	c, f := canonicalIndexFixture(t)
	c.Manifest["confirmationPolicy"] = map[string]any{"status": "frozen", "policyId": "arbitrum-sepolia-finalized-v1", "requiredConfirmations": "1"}
	f.blockResponses = map[string]any{"finalized": nil}
	h := wallet.New(c)
	status, op := request(t, h, "GET", "/v1/operations/"+indexedHash+"?chainId=421614&entryPoint="+ep, "", "")
	if status != 200 || op["executionState"] != "succeeded" || op["confirmationState"] != "pending" {
		t.Fatalf("unavailable finalized proof must retain canonical execution as pending, never confirm from L2 depth: status=%d operation=%v", status, op)
	}
}

func TestIndexerArbitrumFinalityRejectsCheckpointThatConflictsWithReceiptAtSameHeight(t *testing.T) {
	c, f := canonicalIndexFixture(t)
	c.Manifest["confirmationPolicy"] = map[string]any{"status": "frozen", "policyId": "arbitrum-sepolia-finalized-v1", "requiredConfirmations": "1"}
	otherHash := "0x" + strings.Repeat("99", 32)
	f.blockResponses = map[string]any{"finalized": map[string]any{"number": "0x64", "hash": otherHash, "timestamp": "0x6b49d200"}}
	// Simulate a fork between receipt verification and checkpoint verification. The
	// new canonical block cannot finalize a receipt proven against the old hash.
	f.beforeBlockResponse = func(tag string) {
		if tag == "finalized" {
			f.canonicalHash = otherHash
		}
	}
	h := wallet.New(c)
	status, op := request(t, h, "GET", "/v1/operations/"+indexedHash+"?chainId=421614&entryPoint="+ep, "", "")
	if status != 200 || op["confirmationState"] != "reorged" || op["executionState"] != "unknown" {
		t.Fatalf("same-height finalized checkpoint must identify the receipt block exactly: status=%d operation=%v", status, op)
	}
}

func TestIndexerArbitrumFinalityRevalidatesReceiptAfterNewerCheckpoint(t *testing.T) {
	c, f := canonicalIndexFixture(t)
	c.Manifest["confirmationPolicy"] = map[string]any{"status": "frozen", "policyId": "arbitrum-sepolia-finalized-v1", "requiredConfirmations": "1"}
	checkpoint := map[string]any{"number": "0x65", "hash": "0x" + strings.Repeat("22", 32), "timestamp": "0x6b49d201"}
	f.blockResponses = map[string]any{"finalized": checkpoint, "0x65": checkpoint}
	// A newer checkpoint on the replacement branch does not prove a receipt
	// verified on the former branch before the checkpoint was requested.
	f.beforeBlockResponse = func(tag string) {
		if tag == "finalized" {
			f.canonicalHash = "0x" + strings.Repeat("99", 32)
		}
	}
	h := wallet.New(c)
	status, op := request(t, h, "GET", "/v1/operations/"+indexedHash+"?chainId=421614&entryPoint="+ep, "", "")
	if status != 200 || op["confirmationState"] != "reorged" || op["executionState"] != "unknown" {
		t.Fatalf("newer finalized checkpoint must not finalize an orphaned receipt: status=%d operation=%v", status, op)
	}
}

func TestIndexerArbitrumLateReorgInvalidatesExecutionEvidenceAndRestoresRisk(t *testing.T) {
	c, f := canonicalIndexFixture(t)
	c.Manifest["confirmationPolicy"] = map[string]any{"status": "frozen", "policyId": "arbitrum-sepolia-finalized-v1", "requiredConfirmations": "1"}
	f.blockResponses = map[string]any{"finalized": map[string]any{"number": "0x63", "hash": "0x" + strings.Repeat("33", 32)}}
	h := wallet.New(c)
	token, _, hash := issueIndexedPermit(t, h, f)
	path := "/v1/operations/" + hash + "?chainId=421614&entryPoint=" + ep
	status, op := request(t, h, "GET", path, "", "")
	if status != 200 || op["confirmationState"] != "pending" {
		t.Fatalf("initial canonical inclusion missing: %d %v", status, op)
	}
	checkpoint := map[string]any{"number": "0x65", "hash": "0x" + strings.Repeat("22", 32), "timestamp": "0x6b49d201"}
	f.blockResponses["finalized"] = checkpoint
	f.blockResponses["0x65"] = checkpoint
	f.beforeBlockResponse = func(tag string) {
		if tag == "finalized" {
			f.canonicalHash = "0x" + strings.Repeat("99", 32)
		}
	}
	status, op = request(t, h, "GET", path, "", "")
	if status != 200 || op["confirmationState"] != "reorged" || op["executionState"] != "unknown" || op["fee"] != nil || op["chainObservation"] != nil {
		t.Fatalf("explicit late canonical mismatch must invalidate execution and cost immediately: %d %v", status, op)
	}
	for _, value := range op["evidence"].([]any) {
		if value.(map[string]any)["verified"] == true {
			t.Fatalf("orphaned execution evidence cannot remain verified: %v", op)
		}
	}
	_, budget := request(t, h, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
	b := budget["accountBudget"].(map[string]any)
	if b["pendingNative"] != "0" || b["settledNative"] != "0" || b["reservedRiskNative"] != "40" || b["availableNative"] != "60" {
		t.Fatalf("late reorg must restore the entire outstanding reservation: %v", b)
	}
}

func TestIndexerArbitrumUnavailableLateReceiptCheckDoesNotInventReorg(t *testing.T) {
	cases := []struct {
		name  string
		block any
		err   any
	}{
		{name: "missing"},
		{name: "malformed_hash", block: map[string]any{"number": "0x64", "hash": "0x12"}},
		{name: "rpc_error", err: map[string]any{"code": -32000, "message": "temporarily unavailable"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, f := canonicalIndexFixture(t)
			c.Manifest["confirmationPolicy"] = map[string]any{"status": "frozen", "policyId": "arbitrum-sepolia-finalized-v1", "requiredConfirmations": "1"}
			checkpoint := map[string]any{"number": "0x65", "hash": "0x" + strings.Repeat("22", 32), "timestamp": "0x6b49d201"}
			f.blockResponses = map[string]any{"finalized": checkpoint, "0x65": checkpoint}
			f.beforeBlockResponse = func(tag string) {
				if tag == "finalized" {
					f.blockResponses["0x64"] = tc.block
					if tc.err != nil {
						f.blockErrors = map[string]any{"0x64": tc.err}
					}
				}
			}
			status, op := request(t, wallet.New(c), "GET", "/v1/operations/"+indexedHash+"?chainId=421614&entryPoint="+ep, "", "")
			if status != 200 || op["executionState"] != "succeeded" || op["confirmationState"] != "pending" || op["fee"] == nil {
				t.Fatalf("unavailable late proof is neither finality nor explicit reorg evidence: %d %v", status, op)
			}
		})
	}
}

func TestIndexerArbitrumFinalityKeepsInvalidCheckpointProofsPending(t *testing.T) {
	checkpointHash := "0x" + strings.Repeat("22", 32)
	cases := []struct {
		name      string
		finalized any
		canonical any
		rpcError  any
	}{
		{name: "unsupported", rpcError: map[string]any{"code": -32602, "message": "unsupported finalized block tag"}},
		{name: "malformed_result", finalized: "not a block"},
		{name: "malformed_number", finalized: map[string]any{"number": "101", "hash": checkpointHash}},
		{name: "malformed_hash", finalized: map[string]any{"number": "0x65", "hash": "0x12"}, canonical: map[string]any{"number": "0x65", "hash": "0x12"}},
		{name: "lagging", finalized: map[string]any{"number": "0x63", "hash": checkpointHash}},
		{name: "future", finalized: map[string]any{"number": "0x66", "hash": checkpointHash}},
		{name: "noncanonical", finalized: map[string]any{"number": "0x65", "hash": "0x" + strings.Repeat("33", 32)}, canonical: map[string]any{"number": "0x65", "hash": checkpointHash}},
		{name: "canonical_number_mismatch", finalized: map[string]any{"number": "0x65", "hash": checkpointHash}, canonical: map[string]any{"number": "0x64", "hash": checkpointHash}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, f := canonicalIndexFixture(t)
			c.Manifest["confirmationPolicy"] = map[string]any{"status": "frozen", "policyId": "arbitrum-sepolia-finalized-v1", "requiredConfirmations": "1"}
			f.blockResponses = map[string]any{"finalized": tc.finalized, "0x65": tc.canonical}
			if tc.rpcError != nil {
				f.blockErrors = map[string]any{"finalized": tc.rpcError}
			}
			h := wallet.New(c)
			status, op := request(t, h, "GET", "/v1/operations/"+indexedHash+"?chainId=421614&entryPoint="+ep, "", "")
			if status != 200 || op["executionState"] != "succeeded" || op["confirmationState"] != "pending" {
				t.Fatalf("invalid finality proof cannot promote canonical execution to confirmed/finalized: status=%d operation=%v", status, op)
			}
		})
	}
}

func TestIndexerArbitrumFinalityPromotesOnlyAfterCanonicalCheckpointCoversReceipt(t *testing.T) {
	c, f := canonicalIndexFixture(t)
	c.Manifest["confirmationPolicy"] = map[string]any{"status": "frozen", "policyId": "arbitrum-sepolia-finalized-v1", "requiredConfirmations": "1"}
	f.blockResponses = map[string]any{"finalized": map[string]any{"number": "0x63", "hash": "0x" + strings.Repeat("33", 32)}}
	h := wallet.New(c)
	token, _, hash := issueIndexedPermit(t, h, f)
	path := "/v1/operations/" + hash + "?chainId=421614&entryPoint=" + ep
	status, op := request(t, h, "GET", path, "", "")
	if status != 200 || op["executionState"] != "succeeded" || op["confirmationState"] != "pending" {
		t.Fatalf("canonical receipt ahead of finalized checkpoint must remain pending: %d %v", status, op)
	}
	_, budget := request(t, h, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
	b := budget["accountBudget"].(map[string]any)
	if b["settledNative"] != "0" || b["pendingNative"] != "25" || b["reservedRiskNative"] != "15" || b["availableNative"] != "60" {
		t.Fatalf("risk must remain reserved before finality: %v", b)
	}
	checkpoint := map[string]any{"number": "0x65", "hash": "0x" + strings.Repeat("22", 32), "timestamp": "0x6b49d201"}
	f.blockResponses["finalized"] = checkpoint
	f.blockResponses["0x65"] = checkpoint
	status, op = request(t, h, "GET", path, "", "")
	if status != 200 || op["confirmationState"] != "finalized" || op["fee"].(map[string]any)["confirmationState"] != "finalized" {
		t.Fatalf("canonical finalized checkpoint covering receipt must promote operation and fee: %d %v", status, op)
	}
	_, budget = request(t, h, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
	b = budget["accountBudget"].(map[string]any)
	if b["settledNative"] != "25" || b["pendingNative"] != "0" || b["reservedRiskNative"] != "0" || b["availableNative"] != "75" {
		t.Fatalf("only independently proven finality may release unused reserved risk: %v", b)
	}
}

func permitOperationHashReference(t *testing.T, permit map[string]any) string {
	t.Helper()
	input := map[string]any{"sender": accountA, "entryPoint": ep, "delegate": delegate, "paymaster": pm, "callData": operation(t)["callData"], "paymasterData": permit["paymasterData"]}
	cmd := exec.Command("node", "testdata/indexed-hash-reference.mjs")
	cmd.Stdin = strings.NewReader(body(input))
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("independent viem reference unavailable: %v %s", err, output)
	}
	return strings.TrimSpace(string(output))
}
func issueIndexedPermit(t *testing.T, h http.Handler, f *indexRPCFixture) (string, map[string]any, string) {
	t.Helper()
	f.nonce = "0x0"
	f.code = "0x"
	token, _, _ := signIn(t, h, "indexer_00000001")
	status, record := reserve(t, h, token, "indexer_00000001")
	if status != 201 {
		t.Fatalf("reserve=%d %v", status, record)
	}
	hash := permitOperationHashReference(t, record["permit"].(map[string]any))
	f.nonce = "0x1"
	f.code = "0xef0100" + delegate[2:]
	f.event["topics"].([]any)[1] = hash
	f.event["topics"].([]any)[3] = "0x" + strings.Repeat("0", 24) + pm[2:]
	return token, record, hash
}
func TestIndexerAssociatesHistoricalDelegateOnlyThroughFullSignedPermitHash(t *testing.T) {
	c, f := canonicalIndexFixture(t)
	h := wallet.New(c)
	_, _, hash := issueIndexedPermit(t, h, f)
	// The current manifest is not allowed to overwrite the operation's historical preparation.
	c.Manifest["manifestVersion"] = "arb-current-v2"
	c.Manifest["delegate"].(map[string]any)["address"] = "0x7777777777777777777777777777777777777777"
	status, op := request(t, h, "GET", "/v1/operations/"+hash+"?chainId=421614&entryPoint="+ep, "", "")
	if status != 200 || op["manifestVersion"] != "arb-sepolia-mvp-v1" || op["expectedDelegate"] != delegate || op["delegationState"] != "expected_delegate" {
		t.Fatalf("historical association missing or guessed from latest manifest: %d %v", status, op)
	}
}

func TestIndexerSettlesCanonicalCostsIntoDisjointPendingBudgetOnce(t *testing.T) {
	c, f := canonicalIndexFixture(t)
	h := wallet.New(c)
	token, record, hash := issueIndexedPermit(t, h, f)
	for i := 0; i < 2; i++ {
		status, op := request(t, h, "GET", "/v1/operations/"+hash+"?chainId=421614&entryPoint="+ep, "", "")
		if status != 200 {
			t.Fatalf("operation=%d %v", status, op)
		}
		_, budget := request(t, h, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
		b := budget["accountBudget"].(map[string]any)
		if b["pendingNative"] != "25" || b["reservedRiskNative"] != "15" || b["availableNative"] != "60" || b["settledNative"] != "0" {
			t.Fatalf("receipt did not reconcile exactly once: %v", b)
		}
	}
	_, updated := request(t, h, "GET", "/v1/sponsorships/"+record["sponsorshipId"].(string), "", token)
	if updated["accounting"].(map[string]any)["state"] != "pending" {
		t.Fatalf("public permit accounting missing: %v", updated)
	}
}

func TestIndexerFinalizedHeadReleasesOnlyUnusedReservedRisk(t *testing.T) {
	c, f := canonicalIndexFixture(t)
	c.Manifest["confirmationPolicy"] = map[string]any{"status": "frozen", "policyId": "fixture-finalized-v1", "requiredConfirmations": "1"}
	h := wallet.New(c)
	token, _, hash := issueIndexedPermit(t, h, f)
	status, op := request(t, h, "GET", "/v1/operations/"+hash+"?chainId=421614&entryPoint="+ep, "", "")
	if status != 200 || op["confirmationState"] != "finalized" {
		t.Fatalf("finalized chain evidence not classified: %d %v", status, op)
	}
	_, budget := request(t, h, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
	b := budget["accountBudget"].(map[string]any)
	if b["settledNative"] != "25" || b["pendingNative"] != "0" || b["reservedRiskNative"] != "0" || b["availableNative"] != "75" {
		t.Fatalf("unused risk not released by finality: %v", b)
	}
}

func TestIndexerBackgroundHookReconcilesWithoutUserStatusQuery(t *testing.T) {
	c, f := canonicalIndexFixture(t)
	svc := wallet.NewService(c)
	token, _, _ := issueIndexedPermit(t, svc, f)
	if err := svc.SyncIndexer(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, budget := request(t, svc, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
	b := budget["accountBudget"].(map[string]any)
	if b["pendingNative"] != "25" || b["reservedRiskNative"] != "15" {
		t.Fatalf("background sync did not reconcile without UI GET: %v", b)
	}
}

func TestIndexerReorgWithdrawsExecutionAndRestoresRisk(t *testing.T) {
	c, f := canonicalIndexFixture(t)
	h := wallet.New(c)
	token, _, hash := issueIndexedPermit(t, h, f)
	status, _ := request(t, h, "GET", "/v1/operations/"+hash+"?chainId=421614&entryPoint="+ep, "", "")
	if status != 200 {
		t.Fatalf("initial=%d", status)
	}
	f.canonicalHash = "0x" + strings.Repeat("99", 32)
	status, op := request(t, h, "GET", "/v1/operations/"+hash+"?chainId=421614&entryPoint="+ep, "", "")
	if status != 200 || op["executionState"] != "unknown" || op["confirmationState"] != "reorged" || op["fee"] != nil {
		t.Fatalf("orphan execution retained as truth: %d %v", status, op)
	}
	_, budget := request(t, h, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
	b := budget["accountBudget"].(map[string]any)
	if b["pendingNative"] != "0" || b["settledNative"] != "0" || b["reservedRiskNative"] != "40" || b["availableNative"] != "60" {
		t.Fatalf("reorg did not restore still-executable risk: %v", b)
	}
}

func TestIndexerFinalityStillRequiresConfiguredConfirmationDepth(t *testing.T) {
	c, f := canonicalIndexFixture(t)
	c.Manifest["confirmationPolicy"] = map[string]any{"status": "frozen", "policyId": "fixture-depth-v1", "requiredConfirmations": "100"}
	h := wallet.New(c)
	token, _, hash := issueIndexedPermit(t, h, f)
	status, op := request(t, h, "GET", "/v1/operations/"+hash+"?chainId=421614&entryPoint="+ep, "", "")
	if status != 200 || op["confirmationState"] != "pending" {
		t.Fatalf("configured depth bypassed: %d %v", status, op)
	}
	_, budget := request(t, h, "GET", "/v1/budgets?chainId=421614&period=test-period", "", token)
	if budget["accountBudget"].(map[string]any)["reservedRiskNative"] != "15" {
		t.Fatalf("risk released before configured conditions: %v", budget)
	}
}
func TestIndexerExposesOnlyCanonicalEntryPointExecution(t *testing.T) {
	c, _ := canonicalIndexFixture(t)
	h := wallet.New(c)
	status, op := request(t, h, "GET", "/v1/operations/"+indexedHash+"?chainId=421614&entryPoint="+ep, "", "")
	if status != 200 || op["executionState"] != "succeeded" || op["sender"] != accountA || op["nonce"] != "0" {
		t.Fatalf("canonical event was not indexed: status=%d operation=%v", status, op)
	}
	if op["submissionState"] != "unknown" || op["confirmationState"] != "pending" {
		t.Fatalf("chain execution must not invent Bundler/finality evidence: %v", op)
	}
	fee := op["fee"].(map[string]any)
	if fee["payerType"] != "account" || fee["entryPointCostNative"] != "25" || fee["outerTransactionCostNative"] != "21000" {
		t.Fatalf("independent fee values missing: %v", fee)
	}
	if op["expectedDelegate"] != nil || op["manifestVersion"] != nil {
		t.Fatalf("current manifest is not historical operation association: %v", op)
	}
}
