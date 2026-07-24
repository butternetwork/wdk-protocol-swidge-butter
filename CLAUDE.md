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

`protocol.ts` (`ButterSwidgeProtocol`) is the WDK entry point and orchestrates the other modules.
`quoteSwidge` returns a `ButterSwidgeQuote` (a `SwidgeQuote` plus `routeHash`); passing that
`routeHash` back via `swidge`'s `ButterSwidgeOptions` pins the approved route (else expired/mismatched
pins throw `ButterActionRequiredError` instead of silently re-quoting). Everything else is a focused
collaborator it composes:

- **`route.ts`** (`RouteManager`) — builds `/route` requests, caches quotes keyed by request+amount
  (bounded/evicting cache), and re-validates that a cached/fresh route still matches the requested
  chains/tokens before use. Also indexes routes by hash so `swidge` can pin an approved quote via
  `options.routeHash` (`consumeRouteByHash`), and supports a Solana `senderFallback` for the
  receiver. Route TTL and re-fetch margin come from `constants.ts`.
- **`fees.ts`** — maps Butter's `bridgeFee`/`gasFee`/`swapFee` into WDK's `SwidgeFee[]`, and
  enforces `maxNetworkFeeBps`/`maxProtocolFeeBps` using exact rational (numerator/denominator
  bigint) comparisons — never floating point — against route or USD-denominated amounts. Enforcement
  runs **only in `swidge`** (execution); `quoteSwidge` never throws on a cap so a quote stays a fully
  inspectable estimate. Note `mapRouteFees` documents an upstream WDK caveat: the base class's legacy
  `swap()`/`bridge()` sum `fees[].amount` across different denominations, so those scalar totals are
  only meaningful when all fees share a currency — consumers should read the itemised `fees[]`.
- **`swap-data.ts`** — validates the `/swap` Router V3 calldata at a deliberate **middle tier** (see
  `AGENTS.md` / README "Safety Defaults"). Always enforced: router target is allowlisted (and matches
  the route `contract`); top-level intent (initiator, source token, source amount, empty permit);
  `feeData` matches the route's `feeConfig`; and `tx.value == input(if native) + routerFee + bridgeFee`
  (guards native-balance drain). Same-chain `swapAndCall` additionally checks destination token,
  receiver, leftover receiver, and minimum output. **Cross-chain destination routing** (the nested
  bridge payload: destination receiver, output token, minimum output) is intentionally **trusted to
  Butter** and not re-verified — only that the bridge targets the quoted destination chain. Source
  exposure stays bounded because `evm.ts` approves only the exact input amount to the router.
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
  `queryTokenList`), plus `/findToken` decimals lookups (cached, incl. confirmed misses) used as a
  fallback when `config.tokenDecimals` doesn't cover a token. `/findToken` matches by address only
  and ignores the `chainId` param, so results are filtered by `token.chainId` — never trust
  `data[0]`. Transport failures rethrow (not treated as "unknown token").
- **`status.ts`** — maps Butter's cross-state codes (`queryBridgeInfoBySourceHash` /
  `queryCrossInfoByOrderId`) to WDK's `SwidgeStatus`: authoritative codes are `0` crossing→`pending`,
  `1`→`completed`, `6` refund→`refunded` (there is no numeric `failed`). Unrecognized/intermediate
  codes map conservatively to `pending` (never a false terminal), since this is a polling method; a
  response with no info/state still throws (invalid id). Same-chain swaps (`getSwidgeStatus` called
  with `fromChain === toChain`) have no Butter cross record, so status is derived from the tx receipt
  via `evm.publicClient.getTransactionReceipt` or `account.getTransactionReceipt`.
- **`http.ts`** — thin fetch wrapper for Butter's three API surfaces (router/token/app base URLs),
  each with its own success-envelope shape (`errno === 0` vs `code === 200`).
- **`amounts.ts`** — bigint-only decimal<->base-unit conversion; rejects unsafe JS numbers and
  precision-losing conversions rather than silently rounding.
- **`errors.ts`** — a typed error hierarchy (`ButterApiError`, `ButterConfigurationError`,
  `ButterActionRequiredError`, `ButterFeeLimitExceededError`, `ButterFeeValuationError`,
  `ButterReadOnlyAccountError`, `ButterTransactionValidationError`, etc.) so callers can distinguish
  "your config is wrong" from "the route can't be valued" from "the user must act."

### Key invariants to preserve

- **Middle-tier trust boundary** (the definitive statement is in `AGENTS.md`): Butter responses are
  partially trusted. Always keep the router allowlist, top-level intent checks, the `feeData`↔
  `feeConfig` check, the `tx.value` cap (native-drain guard), same-chain destination checks, and the
  route-level fee caps — don't weaken these without security-focused tests. Cross-chain destination
  routing is intentionally trusted to Butter and not re-verified; don't silently re-tighten OR
  further loosen it without updating `AGENTS.md`, README, and tests together.
- **Account-first execution**: `evm.walletClient`/`evm.sendTransaction` are overrides, not
  requirements — a bare WDK account (`getAddress` + `sendTransaction` + optional
  `getTransactionReceipt`) must be able to execute end-to-end with zero viem configuration. A raw
  `evm.sendTransaction` with no address source is rejected up front (it can't determine the sender).
- **Exact-in only**: exact-out (`toTokenAmount`) is rejected before any network request
  (`ButterExactOutUnsupportedError`); this also governs the WDK base-class `swap()` delegation path.
- **Fail closed on unvaluable fees**: if a configured fee cap can't be evaluated (missing USD
  metadata, zero gas fee, etc.), throw `ButterFeeValuationError` rather than skipping the check.
- **Conservative status**: an unrecognized Butter state maps to `pending`, never a false terminal;
  a missing/absent state (invalid id) throws. Approval receipts fail closed on revert.
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
