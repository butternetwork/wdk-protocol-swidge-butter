# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@butternetwork/wdk-protocol-swidge-butter` is a WDK (`@tetherto/wdk-wallet`) Swidge provider that
adapts Butter Network's Smart Router (`/route`, `/swap`), token-discovery, and swap-status APIs to
the `SwidgeProtocol` interface WDK expects. It is a library (published to `dist/`), not an app.

## Commands

```sh
npm test                    # runs test/*.test.ts via node:test + tsx
npm run typecheck           # tsc --noEmit for src/ and examples/
npm run build               # compiles src/ -> dist/ (ESM + .d.ts + source maps)
npm run lint                # alias for typecheck
npm pack --dry-run          # verify published package contents
```

Run a single test file or case:

```sh
node --import tsx --test test/butter-swidge-protocol.test.ts
node --import tsx --test --test-name-pattern="ERC20 allowance" test/*.test.ts
```

Run examples against live Butter APIs (optional `examples/.env`, see `examples/README.md`):

```sh
npm run example:discover
npm run example:quote
npm run example:status
npm run example:swap   # sends a real transaction; requires EXECUTION_CONFIRMATION
```

Before submitting changes: `npm test`, `npm run typecheck`, `npm run build`, and commit the
regenerated `dist/` output (it is published and must stay in sync with `src/`).

## Architecture

`protocol.ts` (`ButterSwidgeProtocol`) is the WDK entry point and orchestrates the other modules;
everything else is a focused collaborator it composes:

- **`route.ts`** (`RouteManager`) — builds `/route` requests, caches quotes keyed by request+amount,
  and re-validates that a cached/fresh route still matches the requested chains/tokens before use.
  Route TTL and a re-fetch margin come from `constants.ts`.
- **`fees.ts`** — maps Butter's `bridgeFee`/`gasFee`/`swapFee` into WDK's `SwidgeFee[]`, and
  independently enforces `maxNetworkFeeBps`/`maxProtocolFeeBps` using exact rational (numerator/
  denominator bigint) comparisons — never floating point — against route or USD-denominated amounts.
  Enforcement happens once at quote time and again right before execution.
- **`swap-data.ts`** — the security-critical module. ABI-decodes the `/swap` response's Router V3
  calldata (`swapAndCall` / `swapAndBridge`) and cross-checks every field (initiator, source token,
  amount, destination token, receiver, minAmount, bridge native fee, router target) against the
  confirmed quote/intent. This is the primary defense against a compromised or buggy Butter API
  returning transaction data that doesn't match what the user agreed to.
- **`router-registry.ts`** — a pinned allowlist of known Router V3 contract addresses per chain
  (`constants.ts: DEFAULT_ROUTER_CONTRACTS`), overridable via `config.routerContracts`. `/swap`
  responses are only trusted if their target is in this registry — the API response alone can never
  authorize a new transaction target.
- **`evm.ts`** — executes validated transactions. Sending is account-first: the WDK account's own
  `sendTransaction` is used by default; `config.evm.sendTransaction`/`evm.walletClient` are explicit
  overrides. ERC20 approvals are skipped only if `config.evm.publicClient` is given and allowance is
  sufficient; without a `publicClient`, an approval is always sent and confirmed via the account's
  `getTransactionReceipt` (polled) instead of a viem public client.
- **`discovery.ts`** — chain/token listing (`/supportedChainInfo`, `queryChainList`,
  `queryTokenList`), plus `/findToken` decimals lookups (cached) used as a fallback when
  `config.tokenDecimals` doesn't cover a token.
- **`status.ts`** — maps Butter's numeric state codes (`queryBridgeInfoBySourceHash` /
  `queryCrossInfoByOrderId`) to WDK's `SwidgeStatus` enum. Unknown codes throw rather than being
  reported as `pending`, so real failures/refunds are never silently masked.
- **`http.ts`** — thin fetch wrapper for Butter's three API surfaces (router/token/app base URLs),
  each with its own success-envelope shape (`errno === 0` vs `code === 200`).
- **`amounts.ts`** — bigint-only decimal<->base-unit conversion; rejects unsafe JS numbers and
  precision-losing conversions rather than silently rounding.
- **`errors.ts`** — a typed error hierarchy (`ButterApiError`, `ButterConfigurationError`,
  `ButterActionRequiredError`, `ButterFeeLimitExceededError`, `ButterFeeValuationError`,
  `ButterReadOnlyAccountError`, `ButterTransactionValidationError`, etc.) so callers can distinguish
  "your config is wrong" from "the route can't be valued" from "the user must act."

### Key invariants to preserve

- **Trust boundary**: Butter API responses (`/route`, `/swap`, status, discovery) are untrusted
  remote input. Do not weaken router allowlists, ABI/calldata checks, amount/value validation, fee
  caps, recipient checks, or approval ordering without adding/updating security-focused tests.
- **Account-first execution**: `evm.walletClient`/`evm.sendTransaction` are overrides, not
  requirements — a bare WDK account (`getAddress` + `sendTransaction` + optional
  `getTransactionReceipt`) must be able to execute end-to-end with zero viem configuration.
- **Exact-in only**: exact-out (`toTokenAmount`) is rejected before any network request
  (`ButterExactOutUnsupportedError`); this also governs the WDK base-class `swap()` delegation path.
- **Fail closed on unvaluable fees**: if a configured fee cap can't be evaluated (missing USD
  metadata, zero gas fee, etc.), throw `ButterFeeValuationError` rather than skipping the check.
- **Fail closed on unknown status**: never map an unrecognized Butter state to `pending` or any
  other WDK status; throw instead.
- **Adapter path has a different trust boundary**: `transactionAdapters` (non-EVM / Tron / BTC /
  Solana / TON execution) bypasses the Router V3 calldata validation used on the built-in EVM path —
  only chain ID and required fields are checked. Keep this asymmetry documented, don't silently
  extend it or pretend it's equivalent to the EVM path's guarantees.

## Coding style

Strict TypeScript, two-space indentation, single quotes, no semicolons. `camelCase` for
variables/functions, `PascalCase` for classes/types, `UPPER_SNAKE_CASE` for constants. Preserve
explicit `.js` extensions in relative imports (NodeNext module resolution). Prefer named types and
small validation helpers at trust boundaries over inline checks.

## Testing

`node:test` + `node:assert/strict`, no external test framework. Name test cases by observable
behavior (e.g. `it('rejects a status response with no swidge info or state', ...)`). Mock Butter
HTTP responses and transaction adapters — unit tests must never require live credentials or
on-chain funds; `test/butter-swidge-protocol.test.ts` has reusable `makeFetch`/`quoteRoute`/
`sourceChainWithToken` helpers for building fixtures. Live-network checks belong in `examples/`,
gated behind env vars and (for `swap.ts`) an explicit `EXECUTION_CONFIRMATION` string.

## Commit style

Conventional Commits (`fix: ...`, `feat: ...`, `docs: ...`). Keep commits cohesive and include the
regenerated `dist/` output when `src/` changes. PRs should state behavior/security impact, list
verification commands run, and call out any public API or configuration changes.
