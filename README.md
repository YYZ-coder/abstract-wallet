# Abstract Wallet

A self-custody wallet prototype combining **EIP-7702 delegation** with **ERC-4337 UserOperations**, while preserving the user's existing EOA address.

The current implementation targets **Arbitrum Sepolia (chain ID 421614)** and a local Prague-enabled Anvil chain. Ethereum, Base, Arbitrum One and BNB Smart Chain remain future deployment targets; this release does not claim production or four-chain readiness.

## Implemented scope

- Original-address delegation, native transfers and atomic call batches through EntryPoint v0.9.0.
- Native-gas payment and signed, budget-limited sponsorship.
- Browser-wallet connection with explicit capability checks. Wallets unable to provide the required authorization are shown a limitation; the application does not substitute a new account address.
- A light retro handheld interface with interactive home, transfer preview, signing and result screens.
- Account/delegation inspection, automatic transaction progress, balance refresh, and read-only recovery of a recent operation after reload.
- Explicit L2 execution, safe and finalized stages under the Arbitrum Sepolia confirmation policy. Timeouts retain the last verified result and retry automatically.
- Optional project-funded test ETH distribution, with per-address and daily pool limits.

## Confirmation policy

The accepted Arbitrum Sepolia policy is `arbitrum-sepolia-finalized-v1`. A canonical `finalized` checkpoint must cover the exact canonical transaction receipt. The client pins checkpoint hashes to numeric blocks, checks head ordering, and rechecks the receipt block before confirmation. Bundler success flags, elapsed time and L2 block depth do not substitute for public-chain finality. Local Anvil uses its separate explicit depth policy.

The interface distinguishes L2 execution from safe and finalized confirmation. Normal read-only polling runs every three seconds; failures back off by 6, 12 and 30 seconds, with a 15-second observation deadline. Manual and automatic refreshes share an in-flight guard. Account, network and operation changes invalidate stale responses. Status reads do not sign or rebroadcast transactions.

Here, finalized means **RPC-reported parent-chain batch/data finality**. It does not mean assertion challenge completion or withdrawal readiness. The prototype trusts its configured Arbitrum RPC rather than verifying a parent-chain inclusion proof itself.

## Repository layout

| Directory | Purpose |
|---|---|
| `contracts/` | Solidity delegate and signature paymaster, with Foundry tests |
| `packages/sdk/` | TypeScript signing, preparation, encoding and submission |
| `apps/wallet/` | React wallet interface |
| `services/sponsorship/` | Go API, PostgreSQL budgets, indexing and test-fund services |
| `services/bundler/` | Development bundler |
| `integration/` | Pinned EntryPoint imports and protocol fixtures |
| `protocol/` | Runtime OpenAPI schema and ABI JSON files |
| `scripts/` | Local setup, deployment and verification tools |

## Local development

Requirements: Node.js 22+, npm, Go 1.26, Python 3, Solidity 0.8.28, Foundry with Prague/EIP-7702 support, and PostgreSQL 16. The database example below uses Docker and disposable local credentials.

Install dependencies and fetch the content-pinned EntryPoint sources:

```sh
npm ci
python3 scripts/bootstrap-protocol.py
```

The EntryPoint archive and source hashes are pinned in `deployments/entrypoint-source-lock.json`. The API schema is packaged at `protocol/openapi.v1.json`, with shared ABIs under `protocol/abi/`.

Set `SOLC_PATH` to your Solidity 0.8.28 compiler binary, then compile both contract projects:

```sh
forge build --root contracts --use "$SOLC_PATH" --offline
forge build --root integration --use "$SOLC_PATH" --offline
```

Start the local chain in a separate terminal:

```sh
anvil --host 127.0.0.1 --port 9545 --chain-id 421614 --hardfork prague
```

Start PostgreSQL, then deploy and fund the local fixtures:

```sh
docker run --name abstract-wallet-mvp-postgres \
  -e POSTGRES_USER=wallet_test \
  -e POSTGRES_PASSWORD=wallet_test_only \
  -e POSTGRES_DB=wallet_mvp \
  -p 127.0.0.1:55432:5432 -d postgres:16-alpine
npx tsx scripts/prepare-local.ts
```

If that container already exists, start it instead of creating another. The preparation script verifies the local Anvil endpoint, deploys contracts, and generates local runtime configuration and protected files under `.secrets/`. These files are not included in the repository.

The wallet runtime manifest is generated at `apps/wallet/public/runtime-network.json`; this checkout does not ship another developer's live deployment settings.

Run the following in separate terminals:

```sh
BUNDLER_ENV_FILE="$PWD/.secrets/local-bundler.env" npm run dev:bundler
```

```sh
python3 scripts/run-api.py
```

```sh
npm run dev
```

Open [the local wallet](http://127.0.0.1:5173). The page identifies this as a local verification environment. The setup script funds a deterministic local signer fixture; newly generated accounts need their own local funding. The built-in development signer keeps its key in memory, so a reload does not restore signing access.

## Tests

Run individual suites:

```sh
npm test
forge test --root contracts --use "$SOLC_PATH" --offline
cd services/sponsorship
go test ./...
```

From the repository root, run the complete MVP checks, including Go race/vet, TypeScript checks and the wallet build:

```sh
export TEST_DATABASE_URL='postgres://wallet_test:wallet_test_only@127.0.0.1:55432/wallet_mvp?sslmode=disable'
npm run test:all
```

`SOLC_PATH` must remain set. PostgreSQL tests are explicitly skipped when `TEST_DATABASE_URL` is absent. Test logs and generated verification output remain local. With the local chain running and both contract projects built, `npx tsx scripts/local-integration.ts` exercises real type-4 authorization and EntryPoint execution against Anvil.

## Accepted verification

The 2026-11-12 accepted build passed **408 top-level tests**: 53 Solidity, 17 SDK, 260 wallet UI/service, 12 bundler and 66 Go tests. Go also reported 106 passing subtests. The full run included a real isolated PostgreSQL database, the Go race detector, `go vet`, TypeScript checks and production builds, with no failed or skipped tests. Behavior changes were developed in sequential Red/Green slices; release filtering is validated separately without claiming a new TDD cycle.

A real Arbitrum Sepolia transfer preserved the already-enabled EOA address, delivered exactly 0.0001 test ETH, and reconciled native balances, EntryPoint deposit changes, nonce and event fees. Independent official-RPC observations followed L2, safe and finalized stages. Both the active transaction view and a reloaded read-only view reached final confirmation automatically. A temporary local query-service interruption retained the verified result and recovered automatically without manual refresh or another signature.

Private design documents, local test evidence, funded-account records, credentials and generated live runtime manifests are intentionally excluded from this repository. Reproduce unit and local protocol checks using the commands above; public-testnet verification requires your own funded accounts and configuration.

## Public testnet operation

Public deployment requires your own funded Arbitrum Sepolia test accounts, protected role-specific configuration, and a matching RPC/API/bundler/runtime manifest. No existing deployment credentials or live account configuration are distributed here. The deployment and integration scripts are developer tools; inspect their required inputs before running them on the public testnet.

The development bundler is not a production bundler. A second independent bundler, universal wallet compatibility, production key storage, withdrawal/assertion finality and multi-chain acceptance remain outside this release's verified scope. EIP-7702 preserves the EOA root key's ultimate control; delegation does not revoke that key.
