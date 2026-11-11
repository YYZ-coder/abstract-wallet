package sponsorship

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
)

var operationEventTopic = crypto.Keccak256Hash([]byte("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")).Hex()

func (s *Service) SyncIndexer(ctx context.Context) error { return s.core.SyncIndexer(ctx) }
func (s *server) SyncIndexer(ctx context.Context) error {
	if !s.c.IndexerConfigured || s.c.RPCURL == "" {
		return nil
	}
	s.requestMu.Lock()
	defer s.requestMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var lastErr error
	work := func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		wanted := map[string]string{}
		for id, r := range s.records {
			if b := s.pending[id]; b != nil {
				if hash, ok := indexedPermitOperationHash(b, r); ok {
					if ep, ok := r["entryPoint"].(string); ok {
						wanted[hash] = ep
					}
				}
			}
		}
		for _, wrapper := range s.indexedOperations {
			if record, ok := wrapper["record"].(map[string]any); ok {
				hash, h := record["userOpHash"].(string)
				ep, e := record["entryPoint"].(string)
				if h && e {
					wanted[hash] = ep
				}
			}
		}
		for _, claim := range s.claims {
			hash, h := claim["userOpHash"].(string)
			ep, e := claim["entryPoint"].(string)
			if h && e && claim["chainId"] == s.c.Manifest["chainId"] {
				wanted[hash] = ep
			}
		}
		for hash, ep := range wanted {
			if ctx.Err() != nil {
				lastErr = ctx.Err()
				break
			}
			if _, err := s.syncOneLocked(ctx, hash, ep); err != nil {
				lastErr = err
			}
		}
	}
	if s.c.Store != nil {
		if err := s.c.Store.update(ctx, func(state *snapshot) error { s.restore(state); work(); *state = *s.snapshot(); return nil }); err != nil {
			return err
		}
	} else {
		work()
	}
	return lastErr
}

type indexedLog struct {
	Address         string   `json:"address"`
	Topics          []string `json:"topics"`
	Data            string   `json:"data"`
	BlockNumber     string   `json:"blockNumber"`
	BlockHash       string   `json:"blockHash"`
	TransactionHash string   `json:"transactionHash"`
	LogIndex        string   `json:"logIndex"`
	Removed         bool     `json:"removed"`
}
type indexedReceipt struct {
	TransactionHash   string       `json:"transactionHash"`
	BlockHash         string       `json:"blockHash"`
	BlockNumber       string       `json:"blockNumber"`
	Status            string       `json:"status"`
	GasUsed           string       `json:"gasUsed"`
	EffectiveGasPrice string       `json:"effectiveGasPrice"`
	Logs              []indexedLog `json:"logs"`
}
type indexedBlock struct {
	Number    string `json:"number"`
	Hash      string `json:"hash"`
	Timestamp string `json:"timestamp"`
}
type operationEvent struct {
	Hash, Sender, Paymaster string
	Nonce, Cost, Gas        *big.Int
	Success                 bool
	Log                     indexedLog
}

// rpcJSON validates the RPC envelope as well as transport success. The result may be JSON null.
func rpcJSON(ctx context.Context, url, method string, params any, result any) error {
	raw, _ := json.Marshal(J{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var envelope struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Result  json.RawMessage `json:"result"`
		Error   json.RawMessage `json:"error"`
	}
	if response.StatusCode != 200 {
		return fmt.Errorf("RPC HTTP unavailable")
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(&envelope); err != nil {
		return err
	}
	if envelope.JSONRPC != "2.0" || string(envelope.ID) != "1" || len(envelope.Result) == 0 || (len(envelope.Error) > 0 && string(envelope.Error) != "null") {
		return fmt.Errorf("invalid RPC envelope")
	}
	return json.Unmarshal(envelope.Result, result)
}
func eventBytes(v string, size int) ([]byte, bool) {
	if !strings.HasPrefix(v, "0x") || len(v) != 2+size*2 {
		return nil, false
	}
	raw, err := hex.DecodeString(v[2:])
	return raw, err == nil
}
func decodeOperationEvent(log indexedLog, ep string) (operationEvent, bool) {
	if log.Removed || !strings.EqualFold(log.Address, ep) || len(log.Topics) != 4 || !strings.EqualFold(log.Topics[0], operationEventTopic) {
		return operationEvent{}, false
	}
	hash, ok := eventBytes(log.Topics[1], 32)
	if !ok {
		return operationEvent{}, false
	}
	sender, ok := eventBytes(log.Topics[2], 32)
	if !ok {
		return operationEvent{}, false
	}
	payer, ok := eventBytes(log.Topics[3], 32)
	if !ok {
		return operationEvent{}, false
	}
	if !bytes.Equal(sender[:12], make([]byte, 12)) || !bytes.Equal(payer[:12], make([]byte, 12)) || bytes.Equal(sender[12:], make([]byte, 20)) {
		return operationEvent{}, false
	}
	data, ok := eventBytes(log.Data, 128)
	if !ok {
		return operationEvent{}, false
	}
	flag := new(big.Int).SetBytes(data[32:64])
	if flag.Cmp(big.NewInt(1)) > 0 {
		return operationEvent{}, false
	}
	if _, ok = eventBytes(log.BlockHash, 32); !ok {
		return operationEvent{}, false
	}
	if _, ok = eventBytes(log.TransactionHash, 32); !ok {
		return operationEvent{}, false
	}
	if _, err := hexutil.DecodeUint64(log.BlockNumber); err != nil {
		return operationEvent{}, false
	}
	if _, err := hexutil.DecodeUint64(log.LogIndex); err != nil {
		return operationEvent{}, false
	}
	return operationEvent{Hash: "0x" + hex.EncodeToString(hash), Sender: "0x" + hex.EncodeToString(sender[12:]), Paymaster: "0x" + hex.EncodeToString(payer[12:]), Nonce: new(big.Int).SetBytes(data[:32]), Success: flag.Sign() != 0, Cost: new(big.Int).SetBytes(data[64:96]), Gas: new(big.Int).SetBytes(data[96:128]), Log: log}, true
}
func sameIndexedLog(a, b indexedLog) bool {
	if !strings.EqualFold(a.Address, b.Address) || !strings.EqualFold(a.Data, b.Data) || !strings.EqualFold(a.BlockHash, b.BlockHash) || !strings.EqualFold(a.TransactionHash, b.TransactionHash) || a.BlockNumber != b.BlockNumber || a.LogIndex != b.LogIndex || a.Removed || b.Removed || len(a.Topics) != len(b.Topics) {
		return false
	}
	for i := range a.Topics {
		if !strings.EqualFold(a.Topics[i], b.Topics[i]) {
			return false
		}
	}
	return true
}
func (s *server) indexContext(ctx context.Context, ep string) (*indexedBlock, error) {
	var chain string
	if err := rpcJSON(ctx, s.c.RPCURL, "eth_chainId", []any{}, &chain); err != nil {
		return nil, err
	}
	chainID, err := hexutil.DecodeBig(chain)
	if err != nil || chainID.String() != s.c.Manifest["chainId"] {
		return nil, fmt.Errorf("indexer chain mismatch")
	}
	deployment, ok := s.c.Manifest["entryPoint"].(map[string]any)
	if !ok || deployment["address"] != ep {
		return nil, fmt.Errorf("unconfigured EntryPoint")
	}
	expected, ok := deployment["runtimeCodeHash"].(string)
	if !ok {
		return nil, fmt.Errorf("missing EntryPoint hash")
	}
	var code string
	if err := rpcJSON(ctx, s.c.RPCURL, "eth_getCode", []any{ep, "latest"}, &code); err != nil {
		return nil, err
	}
	runtime, err := hexutil.Decode(code)
	if err != nil || len(runtime) == 0 || !strings.EqualFold(crypto.Keccak256Hash(runtime).Hex(), expected) {
		return nil, fmt.Errorf("EntryPoint code mismatch")
	}
	var head *indexedBlock
	if err := rpcJSON(ctx, s.c.RPCURL, "eth_getBlockByNumber", []any{"latest", false}, &head); err != nil || head == nil {
		return nil, fmt.Errorf("unknown chain head")
	}
	if _, err := hexutil.DecodeUint64(head.Number); err != nil {
		return nil, err
	}
	if _, err := hexutil.DecodeUint64(head.Timestamp); err != nil {
		return nil, err
	}
	if _, ok := eventBytes(head.Hash, 32); !ok {
		return nil, fmt.Errorf("invalid head hash")
	}
	return head, nil
}
func (s *server) verifyOperationEvent(ctx context.Context, event operationEvent) (*indexedReceipt, *indexedBlock, bool, error) {
	var receipt *indexedReceipt
	if err := rpcJSON(ctx, s.c.RPCURL, "eth_getTransactionReceipt", []any{event.Log.TransactionHash}, &receipt); err != nil {
		return nil, nil, false, err
	}
	if receipt == nil || receipt.Status != "0x1" || !strings.EqualFold(receipt.TransactionHash, event.Log.TransactionHash) || !strings.EqualFold(receipt.BlockHash, event.Log.BlockHash) || receipt.BlockNumber != event.Log.BlockNumber {
		return nil, nil, false, nil
	}
	found := false
	for _, log := range receipt.Logs {
		found = found || sameIndexedLog(event.Log, log)
	}
	if !found {
		return nil, nil, false, nil
	}
	var block *indexedBlock
	if err := rpcJSON(ctx, s.c.RPCURL, "eth_getBlockByNumber", []any{event.Log.BlockNumber, false}, &block); err != nil {
		return nil, nil, false, err
	}
	if block == nil || block.Number != event.Log.BlockNumber || !strings.EqualFold(block.Hash, event.Log.BlockHash) {
		return nil, nil, false, nil
	}
	if _, err := hexutil.DecodeUint64(block.Timestamp); err != nil {
		return nil, nil, false, nil
	}
	return receipt, block, true, nil
}
func (s *server) indexObservation(block *indexedBlock) J {
	number, _ := hexutil.DecodeUint64(block.Number)
	stamp, _ := hexutil.DecodeUint64(block.Timestamp)
	return J{"blockNumber": strconv.FormatUint(number, 10), "blockHash": strings.ToLower(block.Hash), "blockTimestamp": strconv.FormatUint(stamp, 10), "observedAt": strconv.FormatInt(s.c.Clock().Unix(), 10)}
}
func (s *server) indexEvidence(kind string, event operationEvent, block *indexedBlock) J {
	out := J{"kind": kind, "sourceId": "rpc_indexer", "verified": true, "blockNumber": s.indexObservation(block)["blockNumber"], "blockHash": strings.ToLower(block.Hash), "transactionHash": strings.ToLower(event.Log.TransactionHash), "logIndex": nil, "observedAt": strconv.FormatInt(s.c.Clock().Unix(), 10)}
	if kind == "user_operation_event" {
		n, _ := hexutil.DecodeUint64(event.Log.LogIndex)
		out["logIndex"] = strconv.FormatUint(n, 10)
	}
	return out
}
func (s *server) projectOperation(ctx context.Context, event operationEvent, receipt *indexedReceipt, block, head *indexedBlock) J {
	out := s.unknownOperation(event.Hash, s.c.Manifest["chainId"].(string), strings.ToLower(event.Log.Address))
	out["sender"] = event.Sender
	out["nonce"] = event.Nonce.String()
	out["executionState"] = "reverted"
	if event.Success {
		out["executionState"] = "succeeded"
	}
	confirmation := s.indexConfirmation(ctx, block, head)
	out["confirmationState"] = confirmation
	out["transactionHashes"] = []any{strings.ToLower(event.Log.TransactionHash)}
	out["chainObservation"] = s.indexObservation(block)
	out["indexedBlockNumber"] = s.indexObservation(head)["blockNumber"]
	payerType, payer := "paymaster", event.Paymaster
	if strings.EqualFold(payer, "0x"+strings.Repeat("0", 40)) {
		payerType = "account"
		payer = event.Sender
	}
	var outer any
	gas, e1 := hexutil.DecodeBig(receipt.GasUsed)
	price, e2 := hexutil.DecodeBig(receipt.EffectiveGasPrice)
	if e1 == nil && e2 == nil {
		outer = new(big.Int).Mul(gas, price).String()
	}
	currency := s.c.Manifest["nativeCurrency"]
	if currency == nil {
		currency = J{"symbol": "ETH", "decimals": "18"}
	}
	out["fee"] = J{"payerType": payerType, "payerAddress": payer, "currency": currency, "entryPointCostNative": event.Cost.String(), "outerTransactionCostNative": outer, "budgetCostNative": nil, "costPolicyId": nil, "transactionHash": strings.ToLower(event.Log.TransactionHash), "confirmationState": confirmation}
	out["evidence"] = []any{s.indexEvidence("user_operation_event", event, block), s.indexEvidence("outer_receipt", event, block)}
	_, historical := s.associatedSponsorship(event)
	if historical != nil {
		out["manifestVersion"] = historical["manifestVersion"]
		out["expectedDelegate"] = historical["expectedDelegate"]
	}
	var code, nonce string
	if rpcJSON(ctx, s.c.RPCURL, "eth_getCode", []any{event.Sender, head.Number}, &code) == nil && rpcJSON(ctx, s.c.RPCURL, "eth_getTransactionCount", []any{event.Sender, head.Number}, &nonce) == nil {
		n, err := hexutil.DecodeBig(nonce)
		raw, codeErr := hexutil.Decode(code)
		if err == nil && codeErr == nil {
			out["observedAccountNonce"] = n.String()
			out["delegationObservation"] = s.indexObservation(head)
			if len(raw) == 0 {
				out["observedDelegate"] = "0x" + strings.Repeat("0", 40)
				out["delegationState"] = "undelegated"
			} else if len(raw) == 23 && bytes.Equal(raw[:3], []byte{0xef, 1, 0}) {
				out["observedDelegate"] = "0x" + hex.EncodeToString(raw[3:])
				if expected, ok := out["expectedDelegate"].(string); ok {
					out["delegationState"] = "other_delegate"
					if expected == out["observedDelegate"] {
						out["delegationState"] = "expected_delegate"
					}
				}
			}
		}
	}
	return out
}

func (s *server) indexConfirmation(ctx context.Context, block, head *indexedBlock) string {
	policy, ok := s.c.Manifest["confirmationPolicy"].(map[string]any)
	if !ok || policy["status"] != "frozen" {
		return "pending"
	}
	id, ok := policy["policyId"].(string)
	if !ok || id == "" {
		return "pending"
	}
	required := integer(policy["requiredConfirmations"])
	if required.Sign() <= 0 || required.BitLen() > 64 {
		return "pending"
	}
	number, _ := hexutil.DecodeUint64(block.Number)
	latest, _ := hexutil.DecodeUint64(head.Number)
	state := "pending"
	if latest >= number && latest-number+1 >= required.Uint64() {
		state = "confirmed"
	}
	if state != "confirmed" {
		return state
	}
	var finalized *indexedBlock
	if rpcJSON(ctx, s.c.RPCURL, "eth_getBlockByNumber", []any{"finalized", false}, &finalized) != nil || finalized == nil {
		return state
	}
	finalNumber, err := hexutil.DecodeUint64(finalized.Number)
	if err != nil || finalNumber < number || finalNumber > latest {
		return state
	}
	var canonical *indexedBlock
	if rpcJSON(ctx, s.c.RPCURL, "eth_getBlockByNumber", []any{finalized.Number, false}, &canonical) != nil || canonical == nil || !strings.EqualFold(canonical.Hash, finalized.Hash) || canonical.Number != finalized.Number {
		return state
	}
	if _, ok := eventBytes(finalized.Hash, 32); !ok {
		return state
	}
	return "finalized"
}

// Only an issued service record and its complete original request can supply historical intent.
// Client registration fingerprints and the latest manifest are deliberately excluded.
func (s *server) associatedSponsorship(event operationEvent) (string, J) {
	var match string
	var record J
	for id, r := range s.records {
		if r["chainId"] != s.c.Manifest["chainId"] || r["entryPoint"] != strings.ToLower(event.Log.Address) || r["account"] != event.Sender {
			continue
		}
		b := s.pending[id]
		if b == nil {
			continue
		}
		p, ok := r["permit"].(map[string]any)
		if !ok || p["paymaster"] != event.Paymaster || p["nonce"] != event.Nonce.String() {
			continue
		}
		hash, valid := indexedPermitOperationHash(b, r)
		if !valid || hash != event.Hash {
			continue
		}
		if match != "" {
			return "", nil
		}
		match = id
		record = r
	}
	return match, record
}
func indexedPermitOperationHash(b, r J) (string, bool) {
	op, ok := b["unsignedUserOperation"].(map[string]any)
	if !ok {
		return "", false
	}
	permit, ok := r["permit"].(map[string]any)
	if !ok {
		return "", false
	}
	for _, key := range []string{"sender", "nonce", "factory", "factoryData", "callData", "verificationGasLimit", "callGasLimit", "preVerificationGas", "maxPriorityFeePerGas", "maxFeePerGas", "paymaster", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"} {
		if _, ok := op[key].(string); !ok {
			return "", false
		}
	}
	if op["factory"] != "0x7702" || op["factoryData"] != "0x" || op["sender"] != b["account"] || permit["sender"] != b["account"] || permit["nonce"] != op["nonce"] || permit["entryPoint"] != b["entryPoint"] || permit["expectedDelegate"] != b["expectedDelegate"] || permit["paymaster"] != op["paymaster"] || permit["paymasterVerificationGasLimit"] != op["paymasterVerificationGasLimit"] || permit["paymasterPostOpGasLimit"] != op["paymasterPostOpGasLimit"] {
		return "", false
	}
	dataText, ok := permit["paymasterData"].(string)
	if !ok {
		return "", false
	}
	data, ok := eventBytes(dataText, 352)
	if !ok {
		return "", false
	}
	calls, err := hexutil.Decode(op["callData"].(string))
	if err != nil {
		return "", false
	}
	d, ok := b["expectedDelegate"].(string)
	if !ok {
		return "", false
	}
	delegate, ok := eventBytes(d, 20)
	if !ok {
		return "", false
	}
	chain, ok := b["chainId"].(string)
	if !ok {
		return "", false
	}
	ep, ok := b["entryPoint"].(string)
	if !ok {
		return "", false
	}
	for _, key := range []string{"verificationGasLimit", "callGasLimit", "preVerificationGas", "maxPriorityFeePerGas", "maxFeePerGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"} {
		n, ok := new(big.Int).SetString(op[key].(string), 10)
		if !ok || n.Sign() < 0 || n.BitLen() > 120 {
			return "", false
		}
	}
	header := append([]byte{}, common.HexToAddress(op["paymaster"].(string)).Bytes()...)
	gas := make([]byte, 16)
	integer(op["paymasterVerificationGasLimit"]).FillBytes(gas)
	header = append(header, gas...)
	gas = make([]byte, 16)
	integer(op["paymasterPostOpGasLimit"]).FillBytes(gas)
	header = append(header, gas...)
	header = append(header, data...)
	typeHash := crypto.Keccak256Hash([]byte("PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData)"))
	hash := hashABI([]string{"bytes32", "address", "uint256", "bytes32", "bytes32", "bytes32", "uint256", "bytes32", "bytes32"}, typeHash, common.HexToAddress(op["sender"].(string)), integer(op["nonce"]), crypto.Keccak256Hash(delegate), crypto.Keccak256Hash(calls), gasWord(op["verificationGasLimit"], op["callGasLimit"]), integer(op["preVerificationGas"]), gasWord(op["maxPriorityFeePerGas"], op["maxFeePerGas"]), crypto.Keccak256Hash(header))
	domain := hashABI([]string{"bytes32", "bytes32", "bytes32", "uint256", "address"}, crypto.Keccak256Hash([]byte("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), crypto.Keccak256Hash([]byte("ERC4337")), crypto.Keccak256Hash([]byte("1")), integer(chain), common.HexToAddress(ep))
	return crypto.Keccak256Hash([]byte{0x19, 0x01}, domain[:], hash[:]).Hex(), true
}

func (s *server) withdrawOrphanedLocked(ctx context.Context, key string, head *indexedBlock) (J, error) {
	wrapper := s.indexedOperations[key]
	if wrapper == nil {
		return nil, nil
	}
	private, ok := wrapper["event"].(map[string]any)
	if !ok {
		return nil, nil
	}
	raw, _ := json.Marshal(private["log"])
	var old indexedLog
	if json.Unmarshal(raw, &old) != nil {
		return nil, nil
	}
	event, ok := decodeOperationEvent(old, old.Address)
	if !ok {
		return nil, nil
	}
	var canonical *indexedBlock
	if err := rpcJSON(ctx, s.c.RPCURL, "eth_getBlockByNumber", []any{old.BlockNumber, false}, &canonical); err != nil {
		return nil, err
	}
	if canonical == nil || canonical.Number != old.BlockNumber {
		return nil, nil
	}
	if _, ok := eventBytes(canonical.Hash, 32); !ok {
		return nil, nil
	}
	if strings.EqualFold(canonical.Hash, old.BlockHash) {
		return nil, nil
	}
	if id, ok := private["sponsorshipId"].(string); ok && id != "" {
		index, _ := hexutil.DecodeUint64(old.LogIndex)
		if err := s.applySettlement(SettlementEvent{ChainID: s.c.Manifest["chainId"].(string), EntryPoint: strings.ToLower(old.Address), SponsorshipID: id, EventID: event.Hash + ":" + old.LogIndex, BlockHash: strings.ToLower(old.BlockHash), TransactionHash: strings.ToLower(old.TransactionHash), LogIndex: strconv.FormatUint(index, 10), Phase: "removed", ActualCostNative: event.Cost.String()}); err != nil {
			return nil, err
		}
		if r := s.records[id]; r != nil {
			r["chainObservation"] = nil
			r["permitValidity"] = "unknown"
		}
	}
	previous, ok := wrapper["record"].(map[string]any)
	if !ok {
		return nil, nil
	}
	out := clone(previous)
	out["executionState"] = "unknown"
	out["confirmationState"] = "reorged"
	out["fee"] = nil
	out["chainObservation"] = nil
	out["observedDelegate"] = nil
	out["observedAccountNonce"] = nil
	out["delegationObservation"] = nil
	out["delegationState"] = "unknown"
	out["indexedBlockNumber"] = s.indexObservation(head)["blockNumber"]
	out["updatedAt"] = strconv.FormatInt(s.c.Clock().Unix(), 10)
	if evidence, ok := out["evidence"].([]any); ok {
		for _, v := range evidence {
			if e, ok := v.(map[string]any); ok {
				e["verified"] = false
			}
		}
	}
	wrapper["record"] = out
	wrapper["orphaned"] = true
	return out, nil
}

// syncOneLocked is called under the existing request/store transaction and the memory mutex.
func (s *server) syncOneLocked(ctx context.Context, hash, ep string) (J, error) {
	unknown := s.unknownOperation(hash, s.c.Manifest["chainId"].(string), ep)
	if !s.c.IndexerConfigured || s.c.RPCURL == "" {
		return unknown, nil
	}
	head, err := s.indexContext(ctx, ep)
	if err != nil {
		return nil, err
	}
	key := s.c.Manifest["chainId"].(string) + ":" + ep + ":" + hash
	orphaned, err := s.withdrawOrphanedLocked(ctx, key, head)
	if err != nil {
		return nil, err
	}
	var logs []indexedLog
	if err = rpcJSON(ctx, s.c.RPCURL, "eth_getLogs", []any{J{"address": ep, "fromBlock": hexutil.EncodeUint64(s.c.IndexerStartBlock), "toBlock": head.Number, "topics": []any{operationEventTopic, hash}}}, &logs); err != nil {
		return nil, err
	}
	for _, log := range logs {
		event, ok := decodeOperationEvent(log, ep)
		if !ok || event.Hash != hash {
			continue
		}
		receipt, block, valid, err := s.verifyOperationEvent(ctx, event)
		if err != nil {
			return nil, err
		}
		if !valid {
			continue
		}
		out := s.projectOperation(ctx, event, receipt, block, head)
		id, historical := s.associatedSponsorship(event)
		if historical != nil {
			accounting, _ := historical["accounting"].(map[string]any)
			if accounting["costPolicyId"] == "entrypoint-actual-gascost-v1" {
				index, _ := hexutil.DecodeUint64(log.LogIndex)
				phase := "pending"
				if out["confirmationState"] == "finalized" {
					phase = "finalized"
				}
				err := s.applySettlement(SettlementEvent{ChainID: s.c.Manifest["chainId"].(string), EntryPoint: ep, SponsorshipID: id, EventID: event.Hash + ":" + log.LogIndex, BlockHash: strings.ToLower(log.BlockHash), TransactionHash: strings.ToLower(log.TransactionHash), LogIndex: strconv.FormatUint(index, 10), Phase: phase, ActualCostNative: event.Cost.String()})
				if err != nil {
					return nil, err
				}
				fee := out["fee"].(map[string]any)
				fee["budgetCostNative"] = event.Cost.String()
				fee["costPolicyId"] = accounting["costPolicyId"]
				historical["chainObservation"] = s.indexObservation(head)
				historical["evidence"] = out["evidence"]
			}
		}
		s.indexedOperations[s.c.Manifest["chainId"].(string)+":"+ep+":"+hash] = J{"record": out, "event": J{"log": log, "cost": event.Cost.String(), "sponsorshipId": id}}
		return out, nil
	}
	if orphaned != nil {
		return orphaned, nil
	}
	return unknown, nil
}
