package sponsorship

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
	"unicode/utf8"

	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
	"github.com/dlclark/regexp2"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type J = map[string]any
type schemaRegexp regexp2.Regexp

func (r *schemaRegexp) MatchString(s string) bool {
	ok, e := (*regexp2.Regexp)(r).MatchString(s)
	return e == nil && ok
}
func (r *schemaRegexp) String() string { return (*regexp2.Regexp)(r).String() }
func loadSchemas(path string) (map[string]*jsonschema.Schema, error) {
	if path == "" {
		for _, p := range []string{"../../protocol/openapi.v1.json", "protocol/openapi.v1.json"} {
			if _, e := os.Stat(p); e == nil {
				path = p
				break
			}
		}
	}
	raw, e := os.ReadFile(filepath.Clean(path))
	if e != nil {
		return nil, e
	}
	var api J
	if e = json.Unmarshal(raw, &api); e != nil {
		return nil, e
	}
	doc := J{"$schema": "https://json-schema.org/draft/2020-12/schema", "components": api["components"]}
	c := jsonschema.NewCompiler()
	c.UseRegexpEngine(func(s string) (jsonschema.Regexp, error) {
		r, e := regexp2.Compile(s, regexp2.ECMAScript)
		if e != nil {
			return nil, e
		}
		r.MatchTimeout = time.Millisecond * 100
		return (*schemaRegexp)(r), nil
	})
	c.AssertFormat()
	if e = c.AddResource("https://wallet.invalid/schema.json", doc); e != nil {
		return nil, e
	}
	out := map[string]*jsonschema.Schema{}
	for _, n := range []string{"AuthChallengeRequest", "AuthSessionRequest", "SponsorshipPrepareRequest", "SponsorshipCreateRequest", "OperationRegisterRequest", "DelegationRelayRequest", "Bytes32", "ChainIdString", "NonzeroAddress"} {
		s, e := c.Compile("https://wallet.invalid/schema.json#/components/schemas/" + n)
		if e != nil {
			return nil, e
		}
		out[n] = s
	}
	return out, nil
}
func decodeBody(raw []byte) (J, error) {
	if !utf8.Valid(raw) {
		return nil, fmt.Errorf("invalid UTF-8")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if e := checkJSON(d); e != nil {
		return nil, e
	}
	if _, e := d.Token(); e == nil {
		return nil, fmt.Errorf("trailing JSON")
	}
	if _, e := jsoncanonicalizer.Transform(raw); e != nil {
		return nil, e
	}
	var v J
	d = json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if e := d.Decode(&v); e != nil {
		return nil, e
	}
	return v, nil
}
func checkJSON(d *json.Decoder) error {
	t, e := d.Token()
	if e != nil {
		return e
	}
	switch t {
	case json.Delim('{'):
		keys := map[string]bool{}
		for d.More() {
			k, e := d.Token()
			if e != nil {
				return e
			}
			s, ok := k.(string)
			if !ok || keys[s] {
				return fmt.Errorf("duplicate/invalid key")
			}
			keys[s] = true
			if e = checkJSON(d); e != nil {
				return e
			}
		}
		_, e = d.Token()
		return e
	case json.Delim('['):
		for d.More() {
			if e = checkJSON(d); e != nil {
				return e
			}
		}
		_, e = d.Token()
		return e
	}
	return nil
}
func fingerprint(op, project, account, chain string, b J) string {
	payload := J{}
	for k, v := range b {
		if k != "idempotencyKey" {
			payload[k] = v
		}
	}
	raw, _ := json.Marshal(J{"operationId": op, "projectId": project, "account": account, "chainId": chain, "payload": payload})
	canonical, e := jsoncanonicalizer.Transform(raw)
	if e != nil {
		return ""
	}
	return crypto.Keccak256Hash(canonical).Hex()
}
