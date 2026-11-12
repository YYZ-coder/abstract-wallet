package sponsorship_test

import (
	wallet "abstract-wallet/services/sponsorship"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/dlclark/regexp2"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type wirePattern regexp2.Regexp

func (r *wirePattern) MatchString(value string) bool {
	matched, err := (*regexp2.Regexp)(r).MatchString(value)
	return err == nil && matched
}
func (r *wirePattern) String() string { return (*regexp2.Regexp)(r).String() }

func TestIndexerPublicOperationResponseMatchesFrozenContract(t *testing.T) {
	c, _ := canonicalIndexFixture(t)
	status, operation := request(t, wallet.New(c), "GET", "/v1/operations/"+indexedHash+"?chainId=421614&entryPoint="+ep, "", "")
	if status != 200 {
		t.Fatalf("expected public operation response, got %d: %v", status, operation)
	}
	raw, err := os.ReadFile("../../protocol/openapi.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var api map[string]any
	if err = json.Unmarshal(raw, &api); err != nil {
		t.Fatal(err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	compiler.UseRegexpEngine(func(pattern string) (jsonschema.Regexp, error) {
		compiled, err := regexp2.Compile(pattern, regexp2.ECMAScript)
		if err != nil {
			return nil, err
		}
		compiled.MatchTimeout = 100 * time.Millisecond
		return (*wirePattern)(compiled), nil
	})
	if err = compiler.AddResource("https://wallet.invalid/public-contract.json", map[string]any{"$schema": "https://json-schema.org/draft/2020-12/schema", "components": api["components"]}); err != nil {
		t.Fatal(err)
	}
	schema, err := compiler.Compile("https://wallet.invalid/public-contract.json#/components/schemas/OperationRecord")
	if err != nil {
		t.Fatal(err)
	}
	if err = schema.Validate(operation); err != nil {
		t.Fatalf("public OperationRecord violates the frozen wire contract: %v", err)
	}
}
