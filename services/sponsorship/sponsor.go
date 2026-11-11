package sponsorship

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

const batchABI = `[{"type":"function","name":"executeBatch","inputs":[{"name":"calls","type":"tuple[]","components":[{"name":"target","type":"address"},{"name":"value","type":"uint256"},{"name":"data","type":"bytes"}]}]}]`

var batchContract, _ = abi.JSON(strings.NewReader(batchABI))

type call struct {
	Target common.Address
	Value  *big.Int
	Data   []byte
}

func (s *server) session(r *http.Request) (J, string) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	ses := s.sessions[tokenHash(token)]
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || ses == nil {
		return nil, "AUTH_REQUIRED"
	}
	if ses["projectId"] != s.c.ProjectID || ses["chainId"] != s.c.Manifest["chainId"] || ses["_audience"] != s.sessionAudience() {
		return nil, "AUTH_REQUIRED"
	}
	if s.c.Clock().Unix() >= integer(ses["expiresAt"]).Int64() {
		return nil, "SESSION_EXPIRED"
	}
	return ses, ""
}
func rpc(ctx context.Context, url, method string, params any) (string, error) {
	raw, _ := json.Marshal(J{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	req, e := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(raw))
	if e != nil {
		return "", e
	}
	req.Header.Set("Content-Type", "application/json")
	res, e := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if e != nil {
		return "", e
	}
	defer res.Body.Close()
	var out struct {
		Result string `json:"result"`
		Error  any    `json:"error"`
	}
	if e = json.NewDecoder(res.Body).Decode(&out); e != nil || out.Error != nil || res.StatusCode != 200 {
		return "", fmt.Errorf("RPC unavailable")
	}
	return out.Result, nil
}
func (s *server) validateSponsor(ctx context.Context, b J) (string, error) {
	if s.c.SponsorAccountPolicy != "" && s.c.SponsorAccountPolicy != "allowlist" && s.c.SponsorAccountPolicy != "authenticated" {
		return "SPONSORSHIP_DENIED", nil
	}
	if (len(s.c.SponsorAllowedAccounts) == 0 && s.c.SponsorAccountPolicy != "authenticated") || s.c.SponsorPrivateKey == "" {
		return "SPONSORSHIP_DENIED", nil
	}
	allowed := s.c.SponsorAccountPolicy == "authenticated"
	for _, a := range s.c.SponsorAllowedAccounts {
		allowed = allowed || a == b["account"]
	}
	if !allowed {
		return "SPONSORSHIP_DENIED", nil
	}
	for _, budget := range []string{s.c.PerUserBudgetWei, s.c.ChainBudgetWei, s.c.MaxSponsorCostWei} {
		n, ok := new(big.Int).SetString(budget, 10)
		if !ok || n.Sign() <= 0 || n.BitLen() > 256 {
			return "SPONSORSHIP_DENIED", nil
		}
	}
	if b["manifestVersion"] != s.c.Manifest["manifestVersion"] {
		return "MANIFEST_CHANGED", nil
	}
	if b["chainId"] != s.c.Manifest["chainId"] {
		return "UNSUPPORTED_CHAIN", nil
	}
	op := b["unsignedUserOperation"].(map[string]any)
	if op["sender"] != b["account"] {
		return "AUTH_SCOPE_MISMATCH", nil
	}
	for k, want := range map[string]any{"entryPoint": b["entryPoint"], "delegate": b["expectedDelegate"], "paymaster": op["paymaster"]} {
		deployment, ok := s.c.Manifest[k].(map[string]any)
		if !ok || deployment["address"] != want || deployment["runtimeCodeHash"] == nil {
			return "DEPLOYMENT_MISMATCH", nil
		}
	}
	window := b["accountWindow"].(map[string]any)
	if integer(window["validAfter"]).Cmp(integer(window["validUntil"])) >= 0 || integer(window["validUntil"]).Int64() <= s.c.Clock().Unix() {
		return "INVALID_TIME_WINDOW", nil
	}
	if integer(op["maxPriorityFeePerGas"]).Cmp(integer(op["maxFeePerGas"])) > 0 || integer(op["nonce"]).BitLen() > 64 {
		return "INVALID_OPERATION", nil
	}
	data, _ := hex.DecodeString(strings.TrimPrefix(op["callData"].(string), "0x"))
	if len(data) < 4 || !bytes.Equal(data[:4], batchContract.Methods["executeBatch"].ID) {
		return "INVALID_OPERATION", nil
	}
	args, e := batchContract.Methods["executeBatch"].Inputs.Unpack(data[4:])
	if e != nil {
		return "INVALID_OPERATION", nil
	}
	calls := *abi.ConvertType(args[0], new([]call)).(*[]call)
	if len(calls) == 0 || len(calls) > 16 {
		return "INVALID_OPERATION", nil
	}
	size := 0
	for _, c := range calls {
		size += len(c.Data)
	}
	if size > 32768 {
		return "INVALID_OPERATION", nil
	}
	canonical, e := batchContract.Pack("executeBatch", calls)
	if e != nil || !bytes.Equal(canonical, data) {
		return "INVALID_OPERATION", nil
	}
	gas := new(big.Int)
	for _, field := range []string{"callGasLimit", "verificationGasLimit", "preVerificationGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"} {
		gas.Add(gas, integer(op[field]))
	}
	cost := new(big.Int).Mul(gas, integer(op["maxFeePerGas"]))
	if integer(b["maxCost"]).Sign() <= 0 || cost.Cmp(integer(b["maxCost"])) > 0 || integer(b["maxCost"]).Cmp(integer(s.c.MaxSponsorCostWei)) > 0 {
		return "COST_CAP_EXCEEDED", nil
	}
	chain, e := rpc(ctx, s.c.RPCURL, "eth_chainId", []any{})
	if e != nil {
		return "UPSTREAM_UNAVAILABLE", e
	}
	chainN := new(big.Int)
	chainN.SetString(strings.TrimPrefix(chain, "0x"), 16)
	if chainN.String() != b["chainId"] {
		return "DEPLOYMENT_MISMATCH", nil
	}
	for _, k := range []string{"entryPoint", "delegate", "paymaster"} {
		dep := s.c.Manifest[k].(map[string]any)
		code, e := rpc(ctx, s.c.RPCURL, "eth_getCode", []any{dep["address"], "latest"})
		if e != nil {
			return "UPSTREAM_UNAVAILABLE", e
		}
		raw, e := hex.DecodeString(strings.TrimPrefix(code, "0x"))
		if e != nil || len(raw) == 0 || crypto.Keccak256Hash(raw).Hex() != dep["runtimeCodeHash"] {
			return "DEPLOYMENT_MISMATCH", nil
		}
	}
	code, e := rpc(ctx, s.c.RPCURL, "eth_getCode", []any{b["account"], "latest"})
	if e != nil {
		return "UPSTREAM_UNAVAILABLE", e
	}
	if code == "0x" {
		context, ok := b["authorizationContext"].(map[string]any)
		if !ok || context["chainId"] != b["chainId"] || context["address"] != b["expectedDelegate"] {
			return "INVALID_AUTHORIZATION", nil
		}
		nonce, e := rpc(ctx, s.c.RPCURL, "eth_getTransactionCount", []any{b["account"], "pending"})
		if e != nil {
			return "UPSTREAM_UNAVAILABLE", e
		}
		n := new(big.Int)
		n.SetString(strings.TrimPrefix(nonce, "0x"), 16)
		if n.Cmp(integer(context["nonce"])) != 0 {
			return "NONCE_CHANGED", nil
		}
		if signed, ok := context["eip7702Auth"].(map[string]any); ok {
			if !validAuthorization(signed, context, b["account"].(string)) {
				return "INVALID_AUTHORIZATION", nil
			}
		}
	} else {
		if code != "0xef0100"+strings.TrimPrefix(b["expectedDelegate"].(string), "0x") || b["authorizationContext"] != nil {
			return "DELEGATION_CONFLICT", nil
		}
	}
	return "", nil
}
func (s *server) budget(scope, account string) J {
	total := s.c.ChainBudgetWei
	var owner any = nil
	if scope == "account" {
		total = s.c.PerUserBudgetWei
		owner = account
	}
	settled, pending, risk := new(big.Int), new(big.Int), new(big.Int)
	for _, record := range s.records {
		if scope == "account" && record["account"] != account {
			continue
		}
		a := record["accounting"].(map[string]any)
		settled.Add(settled, integer(a["settledNative"]))
		pending.Add(pending, integer(a["pendingNative"]))
		risk.Add(risk, integer(a["reservedRiskNative"]))
	}
	available := new(big.Int).Sub(integer(total), settled)
	available.Sub(available, pending)
	available.Sub(available, risk)
	return J{"chainId": s.c.Manifest["chainId"], "scope": scope, "projectId": s.c.ProjectID, "account": owner, "period": s.c.Period, "currency": J{"symbol": "ETH", "decimals": "18"}, "totalNative": integer(total).String(), "settledNative": settled.String(), "pendingNative": pending.String(), "reservedRiskNative": risk.String(), "availableNative": available.String()}
}

func (s *server) budgets(account string) J {
	return J{"snapshotVersion": identifier(), "serverTime": strconv.FormatInt(s.c.Clock().Unix(), 10), "accountBudget": s.budget("account", account), "chainBudget": s.budget("project_chain", account)}
}
func quoteFingerprint(b J) string {
	v := clone(b)
	delete(v, "quoteId")
	delete(v, "idempotencyKey")
	if ctx, ok := v["authorizationContext"].(map[string]any); ok {
		ctx["eip7702Auth"] = nil
	}
	return fingerprint("quote", "", "", "", v)
}
func (s *server) sponsor(ctx context.Context, path string, b J) (int, J) {
	if s.blocked {
		return 503, failure("SERVICE_UNAVAILABLE")
	}
	opName := "prepareSponsorship"
	if path == "/v1/sponsorships" {
		opName = "createSponsorship"
	}
	key := opName + ":" + b["account"].(string) + ":" + b["chainId"].(string) + ":" + b["idempotencyKey"].(string)
	fp := fingerprint(opName, s.c.ProjectID, b["account"].(string), b["chainId"].(string), b)
	if old, ok := s.idempotency[key]; ok {
		if old.Fingerprint != fp {
			return 409, failure("IDEMPOTENCY_CONFLICT")
		}
		return 200, old.Response
	}
	if code, e := s.validateSponsor(ctx, b); code != "" {
		status := 422
		switch code {
		case "SPONSORSHIP_DENIED", "AUTH_SCOPE_MISMATCH":
			status = 403
		case "MANIFEST_CHANGED", "NONCE_CHANGED", "DELEGATION_CONFLICT":
			status = 409
		case "UPSTREAM_UNAVAILABLE":
			status = 503
		}
		_ = e
		return status, failure(code)
	}
	now := s.c.Clock().Unix()
	op := b["unsignedUserOperation"].(map[string]any)
	if path == "/v1/sponsorships/prepare" {
		id := identifier()
		response := J{"quoteId": id, "chainId": b["chainId"], "account": b["account"], "manifestVersion": b["manifestVersion"], "serverTime": strconv.FormatInt(now, 10), "quoteExpiresAt": strconv.FormatInt(now+60, 10), "maxCost": b["maxCost"], "reservationAmountNative": b["maxCost"], "costPolicyId": "entrypoint-actual-gascost-v1", "paymaster": op["paymaster"], "paymasterVerificationGasLimit": op["paymasterVerificationGasLimit"], "paymasterPostOpGasLimit": op["paymasterPostOpGasLimit"], "stubPaymasterData": stubPaymasterData(b, id), "stubIsExecutable": false}
		s.quotes[id] = J{"fingerprint": quoteFingerprint(b), "response": response}
		s.idempotency[key] = idem{fp, response, now + 60}
		return 201, response
	}
	quote := s.quotes[b["quoteId"].(string)]
	if quote == nil {
		return 404, failure("RESOURCE_NOT_FOUND")
	}
	q := quote["response"].(map[string]any)
	if now >= integer(q["quoteExpiresAt"]).Int64() {
		return 409, failure("QUOTE_EXPIRED")
	}
	if quote["fingerprint"] != quoteFingerprint(b) {
		return 409, failure("IDEMPOTENCY_CONFLICT")
	}
	amount := integer(b["maxCost"])
	for _, scope := range []string{"account", "project_chain"} {
		if integer(s.budget(scope, b["account"].(string))["availableNative"]).Cmp(amount) < 0 {
			return 409, failure("BUDGET_EXCEEDED")
		}
	}
	for _, k := range []string{b["account"].(string), "chain"} {
		if s.risk[k] == nil {
			s.risk[k] = new(big.Int)
		}
		s.risk[k].Add(s.risk[k], amount)
	}
	id, reservationID := identifier(), identifier()
	chainReservation := crypto.Keccak256Hash([]byte(reservationID)).Hex()
	response := J{"sponsorshipId": id, "reservationId": reservationID, "chainReservationId": chainReservation, "quoteId": b["quoteId"], "manifestVersion": b["manifestVersion"], "chainId": b["chainId"], "entryPoint": b["entryPoint"], "account": b["account"], "expectedDelegate": b["expectedDelegate"], "requestFingerprint": fp, "state": "signing", "quoteState": "active", "permitValidity": "unknown", "quoteExpiresAt": q["quoteExpiresAt"], "serverTime": strconv.FormatInt(now, 10), "accountWindow": b["accountWindow"], "permit": nil, "accounting": J{"state": "reserved", "reservationAmountNative": amount.String(), "settledNative": "0", "pendingNative": "0", "reservedRiskNative": amount.String(), "releasedNative": "0", "costPolicyId": "entrypoint-actual-gascost-v1"}, "chainObservation": nil, "evidence": []any{}}
	s.records[id] = response
	s.pending[id] = clone(b)
	s.idempotency[key] = idem{fp, response, 0}
	return 202, response
}
func clone(v J) J { raw, _ := json.Marshal(v); var out J; _ = json.Unmarshal(raw, &out); return out }
func args(types ...string) abi.Arguments {
	out := abi.Arguments{}
	for _, name := range types {
		t, e := abi.NewType(name, "", nil)
		if e != nil {
			panic(e)
		}
		out = append(out, abi.Argument{Type: t})
	}
	return out
}
func hashABI(types []string, values ...any) common.Hash {
	b, e := args(types...).Pack(values...)
	if e != nil {
		panic(e)
	}
	return crypto.Keccak256Hash(b)
}
func gasWord(hi, lo any) [32]byte {
	n := new(big.Int).Lsh(integer(hi), 128)
	n.Or(n, integer(lo))
	var out [32]byte
	n.FillBytes(out[:])
	return out
}
func (s *server) issue(id string) (J, error) {
	s.mu.Lock()
	b := clone(s.pending[id])
	record := clone(s.records[id])
	s.mu.Unlock()
	permit, e := s.makePermit(b, record)
	if e != nil {
		return nil, e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.records[id]["state"] = "issued"
	s.records[id]["permit"] = permit
	return clone(s.records[id]), nil
}
func (s *server) makePermit(b, record J) (J, error) {
	op := b["unsignedUserOperation"].(map[string]any)
	window := b["accountWindow"].(map[string]any)
	key, e := crypto.HexToECDSA(strings.TrimPrefix(s.c.SponsorPrivateKey, "0x"))
	if e != nil {
		return nil, e
	}
	domain := hashABI([]string{"bytes32", "bytes32", "bytes32", "uint256", "address"}, crypto.Keccak256Hash([]byte("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), crypto.Keccak256Hash([]byte("AbstractWalletPaymaster")), crypto.Keccak256Hash([]byte("1")), integer(b["chainId"]), common.HexToAddress(op["paymaster"].(string)))
	typeHash := crypto.Keccak256Hash([]byte("Permit(uint8 version,address expectedDelegate,address sender,address entryPoint,uint256 nonce,bytes32 initCodeHash,bytes32 callDataHash,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,uint128 paymasterVerificationGasLimit,uint128 paymasterPostOpGasLimit,uint48 validAfter,uint48 validUntil,uint256 maxCost,bytes32 reservationId)"))
	initCode := append([]byte{0x77, 0x02}, make([]byte, 18)...)
	callData, _ := hex.DecodeString(strings.TrimPrefix(op["callData"].(string), "0x"))
	chainID := common.HexToHash(record["chainReservationId"].(string))
	structHash := hashABI([]string{"bytes32", "uint8", "address", "address", "address", "uint256", "bytes32", "bytes32", "bytes32", "uint256", "bytes32", "uint128", "uint128", "uint48", "uint48", "uint256", "bytes32"}, typeHash, uint8(1), common.HexToAddress(b["expectedDelegate"].(string)), common.HexToAddress(b["account"].(string)), common.HexToAddress(b["entryPoint"].(string)), integer(op["nonce"]), crypto.Keccak256Hash(initCode), crypto.Keccak256Hash(callData), gasWord(op["verificationGasLimit"], op["callGasLimit"]), integer(op["preVerificationGas"]), gasWord(op["maxPriorityFeePerGas"], op["maxFeePerGas"]), integer(op["paymasterVerificationGasLimit"]), integer(op["paymasterPostOpGasLimit"]), integer(window["validAfter"]), integer(window["validUntil"]), integer(b["maxCost"]), chainID)
	digest := crypto.Keccak256Hash([]byte{0x19, 0x01}, domain[:], structHash[:])
	sig, e := crypto.Sign(digest[:], key)
	if e != nil {
		return nil, e
	}
	sig[64] += 27
	data, e := args("uint8", "address", "uint48", "uint48", "uint256", "bytes32", "bytes").Pack(uint8(1), common.HexToAddress(b["expectedDelegate"].(string)), integer(window["validAfter"]), integer(window["validUntil"]), integer(b["maxCost"]), chainID, sig)
	if e != nil {
		return nil, e
	}
	permit := J{"permitVersion": "1", "chainId": b["chainId"], "entryPoint": b["entryPoint"], "sender": b["account"], "expectedDelegate": b["expectedDelegate"], "nonce": op["nonce"], "accountWindow": window, "maxCost": b["maxCost"], "chainReservationId": chainID.Hex(), "paymaster": op["paymaster"], "paymasterVerificationGasLimit": op["paymasterVerificationGasLimit"], "paymasterPostOpGasLimit": op["paymasterPostOpGasLimit"], "paymasterData": "0x" + hex.EncodeToString(data), "permitDigest": digest.Hex(), "sponsorSignature": "0x" + hex.EncodeToString(sig)}
	return permit, nil
}

func stubPaymasterData(b J, id string) string {
	window := b["accountWindow"].(map[string]any)
	sig := make([]byte, 65)
	sig[64] = 27
	raw, e := args("uint8", "address", "uint48", "uint48", "uint256", "bytes32", "bytes").Pack(uint8(1), common.HexToAddress(b["expectedDelegate"].(string)), integer(window["validAfter"]), integer(window["validUntil"]), integer(b["maxCost"]), crypto.Keccak256Hash([]byte(id)), sig)
	if e != nil {
		panic(e)
	}
	return "0x" + hex.EncodeToString(raw)
}

func (s *server) deliveryView(value J) J {
	out := clone(value)
	if _, ok := out["serverTime"]; ok {
		now := s.c.Clock().Unix()
		out["serverTime"] = strconv.FormatInt(now, 10)
		if _, ok = out["quoteState"]; ok {
			out["quoteState"] = "active"
			if now >= integer(out["quoteExpiresAt"]).Int64() {
				out["quoteState"] = "expired"
			}
		}
	}
	return out
}
