package sponsorship

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"math/big"
	"net/http"
	"strings"
)

// PostgresStore owns an isolated persistent service namespace.
type PostgresStore struct {
	pool      *pgxpool.Pool
	key       []byte
	namespace string
}

func OpenPostgres(ctx context.Context, url string, key []byte, namespace string) (*PostgresStore, error) {
	if len(key) != 32 || namespace == "" {
		return nil, fmt.Errorf("32-byte state encryption key and namespace required")
	}
	p, e := pgxpool.New(ctx, url)
	if e != nil {
		return nil, e
	}
	if e = p.Ping(ctx); e != nil {
		p.Close()
		return nil, e
	}
	if _, e = p.Exec(ctx, "CREATE TABLE IF NOT EXISTS wallet_service_state (namespace TEXT PRIMARY KEY,ciphertext BYTEA,revision BIGINT NOT NULL DEFAULT 0)"); e != nil {
		p.Close()
		return nil, e
	}
	return &PostgresStore{p, append([]byte(nil), key...), namespace}, nil
}
func (p *PostgresStore) Close() { p.pool.Close() }

type snapshot struct {
	Challenges                             map[string]J
	Sessions                               map[string]J
	Idempotency                            map[string]idem
	Consumed                               map[string]bool
	Quotes                                 map[string]J
	Records                                map[string]J
	Pending                                map[string]J
	Risk                                   map[string]*big.Int
	Claims                                 map[string]J
	SettlementEvents                       map[string]J
	Blocked                                bool
	Relays, RelayPending, RelayIdempotency map[string]J
	RelayAuthorizationIDs, RelayConflicts  map[string]string
	RelayNextNonce                         string
	IndexedOperations                      map[string]J
	FaucetClaims                           map[string]J
}

func emptySnapshot() *snapshot {
	return &snapshot{Challenges: map[string]J{}, Sessions: map[string]J{}, Idempotency: map[string]idem{}, Consumed: map[string]bool{}, Quotes: map[string]J{}, Records: map[string]J{}, Pending: map[string]J{}, Risk: map[string]*big.Int{}, Claims: map[string]J{}, SettlementEvents: map[string]J{}, Blocked: false, Relays: map[string]J{}, RelayPending: map[string]J{}, RelayIdempotency: map[string]J{}, RelayAuthorizationIDs: map[string]string{}, RelayConflicts: map[string]string{}, RelayNextNonce: "", IndexedOperations: map[string]J{}, FaucetClaims: map[string]J{}}
}
func (s *server) snapshot() *snapshot {
	return &snapshot{Challenges: s.challenges, Sessions: s.sessions, Idempotency: s.idempotency, Consumed: s.consumed, Quotes: s.quotes, Records: s.records, Pending: s.pending, Risk: s.risk, Claims: s.claims, SettlementEvents: s.settlementEvents, Blocked: s.blocked, Relays: s.relays, RelayPending: s.relayPending, RelayIdempotency: s.relayIdempotency, RelayAuthorizationIDs: s.relayAuthorizationIDs, RelayConflicts: s.relayConflicts, RelayNextNonce: s.relayNextNonce, IndexedOperations: s.indexedOperations, FaucetClaims: s.faucetClaims}
}
func (s *server) restore(p *snapshot) {
	s.challenges = p.Challenges
	s.sessions = p.Sessions
	s.idempotency = p.Idempotency
	s.consumed = p.Consumed
	s.quotes = p.Quotes
	s.records = p.Records
	s.pending = p.Pending
	s.risk = p.Risk
	if p.Claims == nil {
		p.Claims = map[string]J{}
	}
	s.claims = p.Claims
	if p.SettlementEvents == nil {
		p.SettlementEvents = map[string]J{}
	}
	s.settlementEvents = p.SettlementEvents
	s.blocked = p.Blocked
	if p.Relays == nil {
		p.Relays = map[string]J{}
	}
	if p.RelayPending == nil {
		p.RelayPending = map[string]J{}
	}
	if p.RelayIdempotency == nil {
		p.RelayIdempotency = map[string]J{}
	}
	if p.RelayAuthorizationIDs == nil {
		p.RelayAuthorizationIDs = map[string]string{}
	}
	if p.RelayConflicts == nil {
		p.RelayConflicts = map[string]string{}
	}
	s.relays = p.Relays
	s.relayPending = p.RelayPending
	s.relayIdempotency = p.RelayIdempotency
	s.relayAuthorizationIDs = p.RelayAuthorizationIDs
	s.relayConflicts = p.RelayConflicts
	s.relayNextNonce = p.RelayNextNonce
	if p.IndexedOperations == nil {
		p.IndexedOperations = map[string]J{}
	}
	s.indexedOperations = p.IndexedOperations
	if p.FaucetClaims == nil {
		p.FaucetClaims = map[string]J{}
	}
	s.faucetClaims = p.FaucetClaims
}
func (p *PostgresStore) update(ctx context.Context, fn func(*snapshot) error) error {
	tx, e := p.pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(context.Background())
	if _, e = tx.Exec(ctx, "INSERT INTO wallet_service_state(namespace,ciphertext) VALUES($1,NULL) ON CONFLICT DO NOTHING", p.namespace); e != nil {
		return e
	}
	var encrypted []byte
	if e = tx.QueryRow(ctx, "SELECT ciphertext FROM wallet_service_state WHERE namespace=$1 FOR UPDATE", p.namespace).Scan(&encrypted); e != nil {
		return e
	}
	block, _ := aes.NewCipher(p.key)
	gcm, _ := cipher.NewGCM(block)
	state := emptySnapshot()
	if len(encrypted) > 0 {
		if len(encrypted) < gcm.NonceSize() {
			return fmt.Errorf("invalid persistent state")
		}
		raw, e := gcm.Open(nil, encrypted[:gcm.NonceSize()], encrypted[gcm.NonceSize():], []byte(p.namespace))
		if e != nil {
			return e
		}
		if e = json.Unmarshal(raw, state); e != nil {
			return e
		}
	}
	if e = fn(state); e != nil {
		return e
	}
	raw, e := json.Marshal(state)
	if e != nil {
		return e
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, e = rand.Read(nonce); e != nil {
		return e
	}
	encrypted = gcm.Seal(nonce, nonce, raw, []byte(p.namespace))
	if _, e = tx.Exec(ctx, "UPDATE wallet_service_state SET ciphertext=$2,revision=revision+1 WHERE namespace=$1", p.namespace, encrypted); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

type responseBuffer struct {
	header http.Header
	code   int
	body   bytes.Buffer
}

func (b *responseBuffer) Header() http.Header { return b.header }
func (b *responseBuffer) WriteHeader(n int)   { b.code = n }
func (b *responseBuffer) Write(v []byte) (int, error) {
	if b.code == 0 {
		b.code = 200
	}
	return b.body.Write(v)
}
func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.allowRequest(r.RemoteAddr) {
		w.Header().Set("Retry-After", "60")
		write(w, 429, failure("RATE_LIMITED"))
		return
	}
	if r.URL.Path == "/v1/test-funds/claims" || strings.HasPrefix(r.URL.Path, "/v1/test-funds/claims/") {
		s.servePersistentTestFunds(w, r)
		return
	}
	if s.c.Store == nil {
		s.serveMemory(w, r)
		return
	}
	s.requestMu.Lock()
	defer s.requestMu.Unlock()
	b := &responseBuffer{header: http.Header{}}
	e := s.c.Store.update(r.Context(), func(state *snapshot) error { s.restore(state); s.serveMemory(b, r); *state = *s.snapshot(); return nil })
	if e != nil {
		write(w, 503, failure("SERVICE_UNAVAILABLE"))
		return
	}
	var out J
	_ = json.Unmarshal(b.body.Bytes(), &out)
	if (b.code == 200 || b.code == 202) && out["state"] == "signing" {
		id := out["sponsorshipId"].(string)
		if issued, e := s.issuePersistent(r.Context(), id); e == nil {
			status := b.code
			if status == 202 {
				status = 201
			}
			write(w, status, issued)
			return
		}
	}
	if r.Method == http.MethodPost && out["relayId"] != nil && (b.code == 200 || b.code == 202) {
		if sent, e := s.broadcastRelay(r.Context(), out["relayId"].(string)); e == nil {
			write(w, b.code, sent)
			return
		}
	}
	for k, v := range b.header {
		w.Header()[k] = v
	}
	w.WriteHeader(b.code)
	_, _ = w.Write(b.body.Bytes())
}
func (s *server) issuePersistent(ctx context.Context, id string) (J, error) {
	var pending, record J
	e := s.c.Store.update(ctx, func(state *snapshot) error {
		pending = clone(state.Pending[id])
		record = clone(state.Records[id])
		return nil
	})
	if e != nil {
		return nil, e
	}
	permit, e := s.makePermit(pending, record)
	if e != nil {
		return nil, e
	}
	var result J
	e = s.c.Store.update(ctx, func(state *snapshot) error {
		r := state.Records[id]
		if r["state"] == "signing" {
			r["state"] = "issued"
			r["permit"] = permit
			for key, v := range state.Idempotency {
				if v.Response["sponsorshipId"] == id {
					v.Response = r
					state.Idempotency[key] = v
				}
			}
		}
		result = clone(r)
		return nil
	})
	return result, e
}
