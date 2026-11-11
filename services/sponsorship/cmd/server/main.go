package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	wallet "abstract-wallet/services/sponsorship"
)

func main() {
	manifest := wallet.J{"schemaVersion": "1", "manifestVersion": "arb-sepolia-mvp-v1", "chainId": "421614", "name": "Arbitrum Sepolia", "nativeCurrency": wallet.J{"symbol": "ETH", "decimals": "18"}, "capabilityStatus": "unverified", "entryPoint": deployment("v0.9.0"), "delegate": deployment("v1"), "paymaster": deployment("v1"), "rpcEndpoints": []any{}, "bundlerEndpoints": []any{}, "feeModel": wallet.J{"policyId": nil, "status": "draft", "nativeCostUnit": "wei", "components": []any{}}, "confirmationPolicy": wallet.J{"policyId": nil, "status": "draft", "description": "Unverified; no public testnet finality claim.", "requiredConfirmations": nil}, "relay": wallet.J{"mode": "not_frozen", "supported": false, "verified": false, "maxNativeCost": nil}}
	if path := os.Getenv("WALLET_MANIFEST_PATH"); path != "" {
		raw, e := os.ReadFile(path)
		if e != nil {
			log.Fatal("cannot read deployment manifest")
		}
		if e = json.Unmarshal(raw, &manifest); e != nil {
			log.Fatal("invalid deployment manifest")
		}
	}
	if manifest["chainId"] != "421614" {
		log.Fatal("this MVP server supports only Arbitrum Sepolia 421614")
	}
	c := wallet.Config{Manifest: manifest, ProjectID: env("WALLET_PROJECT_ID", "abstract_wallet_mvp"), Domain: env("WALLET_DOMAIN", "wallet.local"), URI: env("WALLET_URI", "https://wallet.local"), SchemaPath: os.Getenv("WALLET_SCHEMA_PATH"), RPCURL: os.Getenv("WALLET_RPC_URL"), SponsorPrivateKey: os.Getenv("SPONSOR_PRIVATE_KEY"), SponsorAllowedAccounts: list("SPONSOR_ALLOWED_ACCOUNTS"), PerUserBudgetWei: env("PER_USER_BUDGET_WEI", "0"), ChainBudgetWei: env("CHAIN_BUDGET_WEI", "0"), MaxSponsorCostWei: env("MAX_SPONSOR_COST_WEI", "0"), Period: env("BUDGET_PERIOD", "mvp-testnet")}
	c.FaucetPrivateKey = os.Getenv("TEST_FAUCET_PRIVATE_KEY")
	c.FaucetAmountWei = env("TEST_FAUCET_AMOUNT_WEI", "1000000000000000")
	c.FaucetDailyBudgetWei = env("TEST_FAUCET_DAILY_BUDGET_WEI", "10000000000000000")
	c.SponsorAccountPolicy = env("SPONSOR_ACCOUNT_POLICY", "allowlist")
	c.RelayPrivateKey = os.Getenv("RELAY_PRIVATE_KEY")
	c.RelayAllowedAccounts = list("RELAY_ALLOWED_ACCOUNTS")
	c.MaxRelayCostWei = env("MAX_RELAY_COST_WEI", "0")
	c.RelayUserBudgetWei = env("RELAY_USER_BUDGET_WEI", "0")
	c.RelayChainBudgetWei = env("RELAY_CHAIN_BUDGET_WEI", "0")
	if raw := os.Getenv("WALLET_INDEXER_START_BLOCK"); raw != "" {
		start, e := strconv.ParseUint(raw, 10, 64)
		if e != nil {
			log.Fatal("invalid WALLET_INDEXER_START_BLOCK")
		}
		c.IndexerStartBlock = start
		c.IndexerConfigured = true
	}
	if url := os.Getenv("SPONSORSHIP_DATABASE_URL"); url != "" {
		key, e := hex.DecodeString(strings.TrimPrefix(os.Getenv("SPONSORSHIP_STATE_KEY"), "0x"))
		if e != nil || len(key) != 32 {
			log.Fatal("SPONSORSHIP_STATE_KEY must be persistent 32-byte hex")
		}
		store, e := wallet.OpenPostgres(context.Background(), url, key, env("SPONSORSHIP_NAMESPACE", "arb-sepolia-mvp"))
		if e != nil {
			log.Fatal("cannot initialize isolated service database")
		}
		defer store.Close()
		c.Store = store
	} else if os.Getenv("WALLET_ALLOW_IN_MEMORY") != "true" {
		log.Fatal("SPONSORSHIP_DATABASE_URL required; test-only in-memory mode requires explicit WALLET_ALLOW_IN_MEMORY=true")
	}
	if c.FaucetPrivateKey != "" && c.Store == nil {
		log.Fatal("test faucet requires persistent PostgreSQL")
	}
	if c.FaucetPrivateKey != "" && c.RPCURL == "" {
		log.Fatal("test faucet requires WALLET_RPC_URL for chain 421614")
	}
	service := wallet.NewService(c)
	var handler http.Handler = service
	if c.IndexerConfigured && c.RPCURL != "" {
		if indexer, ok := any(service).(interface{ SyncIndexer(context.Context) error }); ok {
			go func() {
				ticker := time.NewTicker(5 * time.Second)
				defer ticker.Stop()
				for range ticker.C {
					ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
					err := indexer.SyncIndexer(ctx)
					cancel()
					if err != nil {
						log.Print("chain index synchronization incomplete; existing risk reservations retained")
					}
				}
			}()
		}
	}

	origin := os.Getenv("WALLET_ALLOWED_ORIGIN")
	cors := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin != "" && r.Header.Get("Origin") == origin {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		handler.ServeHTTP(w, r)
	})
	address := env("WALLET_API_LISTEN", "127.0.0.1:8787")
	host, _, e := net.SplitHostPort(address)
	if e != nil || (host != "localhost" && (net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback())) {
		log.Fatal("WALLET_API_LISTEN must be a loopback address")
	}
	log.Printf("wallet API listening on %s; chain=421614; production sponsorship defaults closed", address)
	server := &http.Server{Addr: address, Handler: cors, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	log.Fatal(server.ListenAndServe())
}
func deployment(v string) wallet.J {
	return wallet.J{"version": v, "address": nil, "runtimeCodeHash": nil, "verified": false}
}
func env(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
func list(k string) []string {
	v := os.Getenv(k)
	if v == "" {
		return nil
	}
	out := []string{}
	for _, x := range strings.Split(v, ",") {
		out = append(out, strings.ToLower(strings.TrimSpace(x)))
	}
	return out
}
