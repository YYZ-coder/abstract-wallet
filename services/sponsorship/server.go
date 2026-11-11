package sponsorship

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type Config struct {
	FaucetPrivateKey, FaucetAmountWei, FaucetDailyBudgetWei                                string
	Manifest                                                                               J
	Clock                                                                                  func() time.Time
	ProjectID, Domain, URI, SchemaPath                                                     string
	RPCURL, SponsorPrivateKey, PerUserBudgetWei, ChainBudgetWei, MaxSponsorCostWei, Period string
	SponsorAllowedAccounts                                                                 []string
	SponsorAccountPolicy                                                                   string
	Store                                                                                  *PostgresStore
	RelayPrivateKey, MaxRelayCostWei, RelayUserBudgetWei, RelayChainBudgetWei              string
	RelayAllowedAccounts                                                                   []string
	RequestsPerMinute                                                                      int
	IndexerStartBlock                                                                      uint64
	IndexerConfigured                                                                      bool
}
type idem struct {
	Fingerprint string
	Response    J
	Expires     int64
}
type server struct {
	faucetClaims                           map[string]J
	c                                      Config
	mu                                     sync.Mutex
	requestMu                              sync.Mutex
	schemas                                map[string]*jsonschema.Schema
	initErr                                error
	challenges                             map[string]J
	sessions                               map[string]J
	idempotency                            map[string]idem
	consumed                               map[string]bool
	quotes, records, pending               map[string]J
	risk                                   map[string]*big.Int
	claims                                 map[string]J
	settlementEvents                       map[string]J
	blocked                                bool
	relays, relayPending, relayIdempotency map[string]J
	relayAuthorizationIDs, relayConflicts  map[string]string
	relayNextNonce                         string
	rateMu                                 sync.Mutex
	rateBuckets                            map[string]rateBucket
	indexedOperations                      map[string]J
}

func identifier() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func write(w http.ResponseWriter, status int, v J) {
	out := J{}
	for k, x := range v {
		out[k] = x
	}
	if _, bad := out["error"]; !bad {
		out["schemaVersion"] = "1"
		out["requestId"] = identifier()
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(out)
}
func failure(code string) J {
	action := map[string]string{
		"INVALID_REQUEST": "FIX_REQUEST", "AUTH_REQUIRED": "AUTHENTICATE", "SESSION_EXPIRED": "AUTHENTICATE", "INVALID_SIGNATURE": "RESIGN", "AUTH_SCOPE_MISMATCH": "AUTHENTICATE", "SPONSORSHIP_DENIED": "CHOOSE_SELF_PAY", "RELAY_DENIED": "CHOOSE_SELF_PAY", "RESOURCE_NOT_FOUND": "CHECK_IDENTIFIERS", "CHALLENGE_REPLAY": "NEW_CHALLENGE", "CHALLENGE_EXPIRED": "NEW_CHALLENGE", "IDEMPOTENCY_CONFLICT": "NEW_IDEMPOTENCY_KEY_AFTER_REVIEW", "IDEMPOTENCY_RESULT_EXPIRED": "QUERY_THEN_REPREPARE", "NONCE_CHANGED": "REPREPARE", "MANIFEST_CHANGED": "REFRESH_CONFIGURATION", "DELEGATION_CONFLICT": "REVIEW_DELEGATION", "QUOTE_EXPIRED": "REPREPARE", "BUDGET_EXCEEDED": "CHOOSE_SELF_PAY", "UNSUPPORTED_CHAIN": "CHANGE_NETWORK", "DEPLOYMENT_MISMATCH": "REFRESH_CONFIGURATION", "INVALID_AUTHORIZATION": "FIX_REQUEST", "INVALID_OPERATION": "FIX_REQUEST", "INVALID_TIME_WINDOW": "FIX_REQUEST", "COST_CAP_EXCEEDED": "REPREPARE", "RATE_LIMITED": "WAIT_AND_RETRY_SAME_REQUEST", "UPSTREAM_UNAVAILABLE": "QUERY_THEN_RETRY_SAME_REQUEST", "SERVICE_UNAVAILABLE": "QUERY_THEN_RETRY_SAME_REQUEST", "INTERNAL_ERROR": "QUERY_THEN_RETRY_SAME_REQUEST",
	}[code]
	if action == "" {
		action = "QUERY_THEN_RETRY_SAME_REQUEST"
	}
	return J{"error": J{"code": code, "message": strings.ReplaceAll(strings.ToLower(code), "_", " "), "retryable": code == "SERVICE_UNAVAILABLE" || code == "UPSTREAM_UNAVAILABLE" || code == "RATE_LIMITED" || code == "INTERNAL_ERROR", "requiredAction": action, "requestId": identifier(), "details": J{}}}
}
func New(c Config) http.Handler {
	if c.Clock == nil {
		c.Clock = time.Now
	}
	if c.RequestsPerMinute <= 0 {
		c.RequestsPerMinute = 60
	}
	if c.Period == "" {
		c.Period = "mvp-testnet"
	}
	if c.ProjectID == "" {
		c.ProjectID = "abstract_wallet_mvp"
	}
	if c.Domain == "" {
		c.Domain = "wallet.local"
	}
	if c.URI == "" {
		c.URI = "https://wallet.local"
	}
	schemas, e := loadSchemas(c.SchemaPath)
	s := &server{faucetClaims: map[string]J{}, c: c, schemas: schemas, initErr: e, challenges: map[string]J{}, sessions: map[string]J{}, idempotency: map[string]idem{}, consumed: map[string]bool{}, quotes: map[string]J{}, records: map[string]J{}, pending: map[string]J{}, risk: map[string]*big.Int{}, claims: map[string]J{}, settlementEvents: map[string]J{}, relays: map[string]J{}, relayPending: map[string]J{}, relayIdempotency: map[string]J{}, relayAuthorizationIDs: map[string]string{}, relayConflicts: map[string]string{}, rateBuckets: map[string]rateBucket{}, indexedOperations: map[string]J{}}
	return s
}
func (s *server) serveMemory(w http.ResponseWriter, r *http.Request) {
	if s.initErr != nil {
		write(w, 503, failure("SERVICE_UNAVAILABLE"))
		return
	}
	if r.URL.Path == "/v1/test-funds/claims" || strings.HasPrefix(r.URL.Path, "/v1/test-funds/claims/") {
		s.serveTestFunds(w, r)
		return
	}
	if r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/v1/operations/") {
		s.getOperation(w, r)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/v1/chains" {
		write(w, 200, J{"serverTime": strconv.FormatInt(s.c.Clock().Unix(), 10), "chains": []any{s.c.Manifest}})
		return
	}
	if r.Method == "GET" && (r.URL.Path == "/v1/budgets" || strings.HasPrefix(r.URL.Path, "/v1/sponsorships/") || strings.HasPrefix(r.URL.Path, "/v1/delegations/relay/")) {
		s.mu.Lock()
		ses, code := s.session(r)
		if code != "" {
			s.mu.Unlock()
			write(w, 401, failure(code))
			return
		}
		var out J
		status := 200
		if r.URL.Path == "/v1/budgets" {
			if r.URL.Query().Get("chainId") != ses["chainId"] || r.URL.Query().Get("period") != s.c.Period {
				status = 403
				out = failure("AUTH_SCOPE_MISMATCH")
			} else {
				out = s.budgets(ses["account"].(string))
			}
		} else {
			if strings.HasPrefix(r.URL.Path, "/v1/delegations/relay/") {
				out = s.relays[strings.TrimPrefix(r.URL.Path, "/v1/delegations/relay/")]
			} else {
				out = s.records[strings.TrimPrefix(r.URL.Path, "/v1/sponsorships/")]
			}
			if out == nil || out["account"] != ses["account"] || out["chainId"] != ses["chainId"] {
				status = 404
				out = failure("RESOURCE_NOT_FOUND")
			}
		}
		out = s.deliveryView(out)
		s.mu.Unlock()
		write(w, status, out)
		return
	}
	schema := ""
	switch r.URL.Path {
	case "/v1/auth/challenges":
		schema = "AuthChallengeRequest"
	case "/v1/auth/sessions":
		schema = "AuthSessionRequest"
	case "/v1/sponsorships/prepare":
		schema = "SponsorshipPrepareRequest"
	case "/v1/sponsorships":
		schema = "SponsorshipCreateRequest"
	case "/v1/operations":
		schema = "OperationRegisterRequest"
	case "/v1/delegations/relay":
		schema = "DelegationRelayRequest"
	}
	if schema == "" || r.Method != "POST" {
		http.NotFound(w, r)
		return
	}
	if r.Header.Get("Content-Type") != "application/json" {
		write(w, 400, failure("INVALID_REQUEST"))
		return
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 131073))
	if e != nil || len(raw) > 131072 {
		write(w, 400, failure("INVALID_REQUEST"))
		return
	}
	b, e := decodeBody(raw)
	if e != nil || s.schemas[schema].Validate(b) != nil {
		write(w, 400, failure("INVALID_REQUEST"))
		return
	}
	s.mu.Lock()
	var status int
	var out J
	if strings.HasPrefix(r.URL.Path, "/v1/auth/") {
		status, out = s.auth(r.URL.Path, b)
	} else {
		ses, code := s.session(r)
		if code != "" {
			status = 401
			out = failure(code)
		} else if ses["account"] != b["account"] || ses["chainId"] != b["chainId"] {
			status = 403
			out = failure("AUTH_SCOPE_MISMATCH")
		} else {
			if r.URL.Path == "/v1/operations" {
				status, out = s.registerOperation(b)
			} else if r.URL.Path == "/v1/delegations/relay" {
				status, out = s.prepareRelay(r.Context(), b)
			} else {
				status, out = s.sponsor(r.Context(), r.URL.Path, b)
			}
		}
	}
	out = s.deliveryView(out)
	s.mu.Unlock()
	if s.c.Store == nil && (status == 200 || status == 202) && out["state"] == "signing" {
		if issued, e := s.issue(out["sponsorshipId"].(string)); e == nil {
			if status == 202 {
				status = 201
			}
			out = issued
		}
	}
	if s.c.Store == nil && out["relayId"] != nil && (status == 200 || status == 202) {
		if sent, e := s.broadcastRelay(r.Context(), out["relayId"].(string)); e == nil {
			out = sent
		}
	}
	write(w, status, out)
}

func (s *server) auth(path string, b J) (int, J) {
	now := s.c.Clock().Unix()
	account, chain := "", ""
	op := "createAuthChallenge"
	var ch J
	if path == "/v1/auth/challenges" {
		account = b["account"].(string)
		chain = b["chainId"].(string)
		if chain != s.c.Manifest["chainId"] {
			return 422, failure("UNSUPPORTED_CHAIN")
		}
	} else {
		op = "createAuthSession"
		ch = s.challenges[b["challengeId"].(string)]
		if ch == nil {
			return 404, failure("RESOURCE_NOT_FOUND")
		}
		if !s.challengeInScope(ch) {
			return 403, failure("AUTH_SCOPE_MISMATCH")
		}
		account = ch["account"].(string)
		chain = ch["chainId"].(string)
	}
	key := op + ":" + s.c.ProjectID + ":" + account + ":" + chain + ":" + b["idempotencyKey"].(string)
	fp := fingerprint(op, s.c.ProjectID, account, chain, b)
	if old, ok := s.idempotency[key]; ok {
		if old.Fingerprint != fp {
			return 409, failure("IDEMPOTENCY_CONFLICT")
		}
		if op == "createAuthChallenge" && !s.challengeInScope(old.Response) {
			return 409, failure("IDEMPOTENCY_RESULT_EXPIRED")
		}
		if now >= old.Expires {
			return 409, failure("IDEMPOTENCY_RESULT_EXPIRED")
		}
		return 200, old.Response
	}
	var response J
	if path == "/v1/auth/challenges" {
		id, nonce := identifier(), identifier()
		issued := time.Unix(now, 0).UTC().Format(time.RFC3339)
		expires := time.Unix(now+300, 0).UTC().Format(time.RFC3339)
		message := s.c.Domain + " wants you to sign in with your Ethereum account:\n" + common.HexToAddress(account).Hex() + "\n\nSign in to Abstract Wallet.\n\nURI: " + s.c.URI + "\nVersion: 1\nChain ID: " + chain + "\nNonce: " + nonce + "\nIssued At: " + issued + "\nExpiration Time: " + expires
		response = J{"challengeId": id, "projectId": s.c.ProjectID, "chainId": chain, "account": account, "signatureScheme": "root-eip191-65", "domain": s.c.Domain, "uri": s.c.URI, "nonce": nonce, "issuedAt": strconv.FormatInt(now, 10), "expiresAt": strconv.FormatInt(now+300, 10), "message": message}
		s.challenges[id] = response
	} else {
		if now >= integer(ch["expiresAt"]).Int64() {
			return 409, failure("CHALLENGE_EXPIRED")
		}
		if s.consumed[b["challengeId"].(string)] {
			return 409, failure("CHALLENGE_REPLAY")
		}
		sig, _ := hex.DecodeString(strings.TrimPrefix(b["signature"].(string), "0x"))
		if !recoverRoot(accounts.TextHash([]byte(ch["message"].(string))), sig, account) {
			return 401, failure("INVALID_SIGNATURE")
		}
		token := identifier() + identifier()
		response = J{"sessionId": identifier(), "projectId": s.c.ProjectID, "chainId": chain, "account": account, "tokenType": "Bearer", "accessToken": token, "issuedAt": strconv.FormatInt(now, 10), "expiresAt": strconv.FormatInt(now+300, 10), "scopes": []string{"sponsorship", "delegation_relay", "operation_registration", "budget_read"}}
		privateSession := clone(response)
		privateSession["_audience"] = s.sessionAudience()
		s.sessions[tokenHash(token)] = privateSession
		s.consumed[b["challengeId"].(string)] = true
	}
	s.idempotency[key] = idem{fp, response, now + 300}
	return 201, response
}
func integer(v any) *big.Int {
	n := new(big.Int)
	if str, ok := v.(string); ok {
		n.SetString(str, 10)
	}
	return n
}
func tokenHash(v string) string { h := sha256.Sum256([]byte(v)); return hex.EncodeToString(h[:]) }
func recoverRoot(hash, sig []byte, account string) bool {
	if len(sig) != 65 || sig[64] < 27 || sig[64] > 28 {
		return false
	}
	b := append([]byte(nil), sig...)
	b[64] -= 27
	if !crypto.ValidateSignatureValues(b[64], new(big.Int).SetBytes(b[:32]), new(big.Int).SetBytes(b[32:64]), true) {
		return false
	}
	pub, e := crypto.SigToPub(hash, b)
	return e == nil && strings.ToLower(crypto.PubkeyToAddress(*pub).Hex()) == account
}

func (s *server) sessionAudience() string { return s.c.Domain + "\n" + s.c.URI }
func (s *server) challengeInScope(ch J) bool {
	return ch["domain"] == s.c.Domain && ch["uri"] == s.c.URI && ch["projectId"] == s.c.ProjectID && ch["chainId"] == s.c.Manifest["chainId"]
}
