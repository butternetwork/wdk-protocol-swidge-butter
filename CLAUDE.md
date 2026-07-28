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
  chains/tokens before use. A **cross-chain** request (`fromChainId !== toChainId`) requires the route
  to include `dstChain` matching the target chain/token — a missing `dstChain` is a same-chain path and
  is rejected (otherwise `mappers.ts` would quote the wrong source leg). Also indexes routes by hash so
  `swidge` can pin an approved quote via `options.routeHash` (`consumeRouteByHash`), and supports a
  Solana `senderFallback` for the receiver. Route TTL and re-fetch margin come from `constants.ts`.
- **`fees.ts`** — maps Butter's `bridgeFee`/`gasFee`/`swapFee` into WDK's `SwidgeFee[]`, and
  enforces `maxNetworkFeeBps`/`maxProtocolFeeBps` using exact rational (numerator/denominator
  bigint) comparisons — never floating point. **Source-denominated** fee ratios use the caller's
  `requestedAmountIn` (base units) as the denominator via `sourceDenominator(context)` — NOT the
  untrusted `route.srcChain.totalAmountIn`, which an inflated `/route` could use to understate the
  ratio and slip past a bps cap. Cross-denomination bridge/USD fees still use route-stage amounts
  (documented USD-metadata trust). Enforcement runs **only in `swidge`** (execution); `quoteSwidge`
  never throws on a cap so a quote stays a fully inspectable estimate. Note `mapRouteFees` documents an upstream WDK caveat: the base class's legacy
  `swap()`/`bridge()` sum `fees[].amount` across different denominations, so those scalar totals are
  only meaningful when all fees share a currency — consumers should read the itemised `fees[]`.
- **`swap-data.ts`** — validates the `/swap` Router V3 calldata at a deliberate **middle tier** (see
  `AGENTS.md` / README "Safety Defaults"). The built-in EVM path requires **exactly one** Router
  transaction (rejects multi-tx arrays that could multiply spend). Always enforced: router target is
  allowlisted (and matches the route `contract`); top-level intent (initiator, source token, source
  amount, empty permit); `feeData` matches the route's `feeConfig` as a full `(feeType, referrer,
  rateOrNativeFee)` tuple (a non-empty `feeData` requires the quoted tuple to be **complete** — fail
  closed on any missing field — and to match exactly; an **empty** `feeData` is rejected when the route
  quoted a non-zero integrator fee — so a quoted fee cannot be silently dropped nor an unchecked
  `feeType`/`referrer` injected by under-specifying the quote); and `tx.value == input(if native) + routerFee + bridgeFee`. The bridge messaging fee inside `tx.value` is trusted from `/swap`, so the
  actual native-drain guard is the **`maxNativeFee`** absolute cap on `routerFee + bridgeFee`
  (`context.maxNativeFee`); cross-chain execution **fails closed** when it is unset. Same-chain
  `swapAndCall` additionally checks destination token, receiver, leftover receiver, and minimum output.
  **Cross-chain destination routing** (the nested bridge payload: destination receiver, output token,
  minimum output) is intentionally **trusted to Butter** and not re-verified — only that the bridge
  targets the quoted destination chain. Source exposure stays bounded because `evm.ts` approves only
  the exact input amount to the router.
- **`router-registry.ts`** — a pinned allowlist of known Router V3 contract addresses per chain
  (`constants.ts: DEFAULT_ROUTER_CONTRACTS`), overridable via `config.routerContracts`. `/swap`
  responses are only trusted if their target is in this registry — the API response alone can never
  authorize a new transaction target.
- **`evm.ts`** — executes validated transactions. EVM execution requires **both** a full WDK account
  (WDK `swidge()` contract; enforced in `assertExecutionCapability`) **and** `evm.walletClient` (its
  `account.address` validated against the WDK account) to carry the swap/approval calldata; the WDK
  account's generic `sendTransaction` is NOT used here (its `Transaction` type is only `{ to, value }`,
  so `data` could be dropped). The account is still used for the sender address and approval receipts.
  Approval confirmation is **fail-closed** via the shared `status.ts: classifyReceiptStatus` (unknown
  status keeps polling until timeout); an approval with no receipt source is **refused** before sending.
  When **every** send returns `{ hash, fee }`, the measured gas is summed and folded into the result's
  `network` fee (`protocol.ts: withMeasuredNetworkFee`); if any send omits a fee (or a fee is negative →
  rejected), the route estimate stands. Approval is skipped only when the existing allowance **exactly
  equals** the input; any other value is set to exactly the input (`approve(0)` then `approve(amount)`
  when non-zero) so exposure never exceeds this swap. Also exports `toEvmWalletClient`/`toEvmPublicClient`
  adapters for viem clients. The `toEvmPublicClient` adapter maps **only** viem's `TransactionNotFoundError`/
  `TransactionReceiptNotFoundError` to `null` (genuine absence); every other fault (RPC timeout, auth,
  rate-limit) **rethrows** rather than masquerading as "not found". That match is **copy-independent**
  (`isViemErrorNamed`: viem's error `name` plus the `BaseError` `shortMessage` shape, with `instanceof`
  kept as a same-copy fast path) because the host builds the wrapped client with *its* copy of viem —
  `instanceof` alone would reject a genuine not-found, and a name-only check would let an RPC fault spoof
  one. Without a `publicClient`, an approval
  is always sent (overwrites to exact) and confirmed via the account's `getTransactionReceipt`.
  Every send is recorded the instant it returns (before the approval receipt wait), so a later failure
  surfaces the already-broadcast hashes on a `ButterPartialExecutionError` instead of discarding them.
- **`discovery.ts`** — chain/token listing (`/supportedChainInfo`, `queryChainList`,
  `queryTokenList`), plus `/findToken` decimals lookups (cached, incl. confirmed misses) used as a
  fallback when `config.tokenDecimals` doesn't cover a token. `/findToken` matches by address only
  and ignores the `chainId` param, so results are filtered by `token.chainId` — never trust
  `data[0]`. Transport failures rethrow (not treated as "unknown token").
- **`status.ts`** — maps Butter's cross-state codes (`queryBridgeInfoBySourceHash` /
  `queryCrossInfoByOrderId`) to WDK's `SwidgeStatus`: authoritative codes are `0` crossing→`pending`,
  `1`→`completed`, `6` refund→`refunded` (there is no numeric `failed`). Unrecognized/intermediate
  codes map conservatively to `pending` (never a false terminal), since this is a polling method; a
  response with no info/state still throws (invalid id). Receipt mapping (`mapReceiptStatus`) is
  **fail-closed**: only an explicit success is `completed`, only an explicit revert is `failed`, and an
  unknown/missing status is `pending`. Same-chain swaps have no Butter cross record, so status is
  derived from the tx receipt via `evm.publicClient.getTransactionReceipt` or
  `account.getTransactionReceipt`. Same-chain status is only derived from the
  receipt after the source tx is **attributed to a Butter Router**: recorded ids (this instance
  executed them) are trusted; otherwise `attributeSourceTransaction` fetches the tx via
  `evm.publicClient.getTransaction` and requires an **allowlisted Router target AND** a Router function
  (`swap-data.ts: routerFunctionName` — `swapAndCall`=same, `swapAndBridge`=cross). Explicit
  `fromChain/toChain` hints do NOT bypass attribution (an unrelated tx is never reported completed; an
  unverifiable same-chain id throws). Unresolved attribution defaults to the cross-chain API (never a
  false completion). A genuine not-found tx resolves to unattributable (→ cross API), but an
  **infrastructure error** from `getTransaction` (RPC timeout, auth, rate-limit) **propagates** rather
  than being swallowed as unattributable, so a node fault surfaces instead of a silent fallback. Works
  across restarts/new instances.
- **`http.ts`** — thin fetch wrapper for Butter's three API surfaces (router/token/app base URLs),
  each with its own success-envelope shape (`errno === 0` vs `code === 200`).
- **`amounts.ts`** — bigint-only decimal<->base-unit conversion; rejects unsafe JS numbers and
  precision-losing conversions rather than silently rounding.
- **`errors.ts`** — a typed error hierarchy (`ButterApiError`, `ButterConfigurationError`,
  `ButterActionRequiredError`, `ButterFeeLimitExceededError`, `ButterFeeValuationError`,
  `ButterPartialExecutionError`, `ButterReadOnlyAccountError`, `ButterTransactionValidationError`,
  etc.) so callers can distinguish "your config is wrong" from "the route can't be valued" from
  "the user must act" from "some of it already happened on-chain."

### Key invariants to preserve

- **Middle-tier trust boundary** (the definitive statement is in `AGENTS.md`): Butter responses are
  partially trusted. Always keep the router allowlist, the single-transaction EVM rule, top-level
  intent checks, the `feeData`↔`feeConfig` check, the `tx.value` check, the `maxNativeFee` cap
  (the real native-drain guard; cross-chain fails closed without it), same-chain destination checks,
  and the route-level fee caps — don't weaken these without security-focused tests. Cross-chain
  destination routing is intentionally trusted to Butter and not re-verified; don't silently
  re-tighten OR further loosen it without updating `AGENTS.md`, README, and tests together.
- **Full account + walletClient for calldata**: EVM Router execution requires BOTH a full
  (send-capable) WDK account (WDK `swidge()` contract — undefined/read-only accounts are rejected) AND
  `evm.walletClient` to carry the swap/approval calldata. A WDK account cannot submit calldata — the WDK
  `Transaction` type is only `{ to, value }` — so it is used only for the sender address and (optional)
  approval receipts. The `walletClient.account.address` is validated against the WDK account (no signer/
  initiator/allowance-owner split). There is no raw `evm.sendTransaction` and no `approvalAmount: 'max'`.
  The dual requirement merges only if WDK extends `Transaction` with `data`.
- **Exact-in only**: exact-out (`toTokenAmount`) is rejected before any network request
  (`ButterExactOutUnsupportedError`); this also governs the WDK base-class `swap()` delegation path.
- **Fail closed on unvaluable fees**: if a configured fee cap can't be evaluated (missing USD
  metadata, zero gas fee, etc.), throw `ButterFeeValuationError` rather than skipping the check.
- **Conservative status**: an unrecognized Butter state maps to `pending`, never a false terminal;
  a missing/absent state (invalid id) throws. Approval receipts fail closed on revert.
- **Adapter path has a different trust boundary**: `transactionAdapters` (non-EVM / Tron / BTC /
  Solana / TON execution) bypasses the Router V3 calldata validation used on the built-in EVM path —
  only chain ID and required fields are checked. Keep this asymmetry documented, don't silently
  extend it or pretend it's equivalent to the EVM path's guarantees. **But** adapter output is still
  fully normalized and classified **before any transaction is broadcast** (`protocol.ts:
  resolveAdapterTypes`): illegal types, an unclassified multi-tx result, or anything other than exactly
  one `source` throws with nothing sent — don't reorder this back to send-then-validate (a retry could
  otherwise double-execute an already-sent leg).
- **Partial execution is reported, not discarded**: a failure after one or more transactions are
  already broadcast throws `ButterPartialExecutionError` (from `protocol.ts: partialExecution`,
  fed by `evm.ts`'s per-send recording) carrying every broadcast hash and the original `cause`, and
  registers a broadcast `source` via `rememberOperationKind` first so `getSwidgeStatus` still resolves
  the in-flight swidge. This covers a later *send* failure **and** an approval that cannot be confirmed
  (revert, unknown receipt status, timeout) — that approval is already on the wire, so the caller needs
  its hash; the fail-closed guarantee is unchanged (the swap is still never sent). **Ordering is the
  invariant**: record a transaction the instant its send returns, *then* validate the gas fee it
  reported (`evm.ts: assertGasFee`, reused by `protocol.ts: feeOf`), and keep the fee total and result
  assembly inside the guarded region — validate-then-record would drop a send that succeeded on-chain
  with a bad fee. Fees are runtime-checked as non-negative bigints and hashes as non-empty strings
  (`evm.ts: assertTransactionHash`) because host-supplied senders make the declared types hints (a
  `number` fee passes `< 0n`, then throws a raw `TypeError` from the sum; a `number` hash throws from
  `rememberOperationKind`'s `toLowerCase()`). The **hash** is the one value validated *before*
  recording — the hash *is* the record, so an unidentifiable send has nothing to report and throws
  unwrapped. `partialExecution` treats status registration as best-effort and never lets it throw:
  it is the last-resort reporter, and the caller's hashes outrank it.
  A failure before anything is broadcast propagates **unwrapped** — keep that distinction so a wallet
  rejection is never mislabelled as partially applied. Never swallow, auto-retry, or continue past a
  failed leg.

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
