package sponsorship

import (
	"net/http"
	"strconv"
	"strings"
)

func (s *server) unknownOperation(hash, chain, entryPoint string) J {
	return J{"chainId": chain, "entryPoint": entryPoint, "userOpHash": hash, "sender": nil, "nonce": nil, "submissionState": "unknown", "executionState": "unknown", "confirmationState": "unknown", "delegationState": "unknown", "transactionHashes": []any{}, "fee": nil, "chainObservation": nil, "indexedBlockNumber": nil, "evidence": []any{}, "updatedAt": strconv.FormatInt(s.c.Clock().Unix(), 10), "manifestVersion": nil, "expectedDelegate": nil, "observedDelegate": nil, "observedAccountNonce": nil, "delegationObservation": nil}
}
func (s *server) registerOperation(b J) (int, J) {
	key := "registerOperation:" + b["account"].(string) + ":" + b["chainId"].(string) + ":" + b["idempotencyKey"].(string)
	fp := fingerprint("registerOperation", s.c.ProjectID, b["account"].(string), b["chainId"].(string), b)
	if old, ok := s.idempotency[key]; ok {
		if old.Fingerprint != fp {
			return 409, failure("IDEMPOTENCY_CONFLICT")
		}
		return 200, old.Response
	}
	out := s.unknownOperation(b["userOpHash"].(string), b["chainId"].(string), b["entryPoint"].(string))
	s.claims[key] = clone(b)
	s.idempotency[key] = idem{fp, out, 0}
	return 201, out
}
func (s *server) getOperation(w http.ResponseWriter, r *http.Request) {
	hash := strings.TrimPrefix(r.URL.Path, "/v1/operations/")
	chain, ep := r.URL.Query().Get("chainId"), r.URL.Query().Get("entryPoint")
	if len(r.URL.Query()) != 2 || len(r.URL.Query()["chainId"]) != 1 || len(r.URL.Query()["entryPoint"]) != 1 || s.schemas["Bytes32"].Validate(hash) != nil || s.schemas["ChainIdString"].Validate(chain) != nil || s.schemas["NonzeroAddress"].Validate(ep) != nil {
		write(w, 400, failure("INVALID_REQUEST"))
		return
	}
	if chain != s.c.Manifest["chainId"] {
		write(w, 422, failure("UNSUPPORTED_CHAIN"))
		return
	}
	s.mu.Lock()
	out, err := s.syncOneLocked(r.Context(), hash, ep)
	s.mu.Unlock()
	if err != nil {
		write(w, 503, failure("UPSTREAM_UNAVAILABLE"))
		return
	}
	write(w, 200, out)
}
