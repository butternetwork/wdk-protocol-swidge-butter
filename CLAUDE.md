# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@butternetwork/wdk-protocol-swidge-butter` is a WDK (`@tetherto/wdk-wallet`) Swidge provider that
adapts Butter Network's Smart Router (`/route`, `/swap`), token-discovery, and swap-status APIs to
the `SwidgeProtocol` interface WDK expects. It is a library (published to `dist/`), not an app.

## Commands

```sh
npm test                    # runs tests/*.test.ts via node:test + tsx
npm run check:repo          # runs repository policy and harness checks
npm run typecheck           # tsc --noEmit for src/ and examples/
npm run build               # compiles src/ -> dist/ (ESM + .d.ts + source maps)
npm run lint                # alias for typecheck
npm pack --dry-run          # verify published package contents
```

Run a single test file or case:

```sh
node --import tsx --test tests/butter-swidge-protocol.test.ts
node --import tsx --test --test-name-pattern="ERC20 allowance" tests/*.test.ts
```

Run examples against live Butter APIs (optional `examples/.env`, see `examples/README.md`):

```sh
npm run example:discover
npm run example:quote
npm run example:status
npm run example:swap   # sends a real transaction; requires EXECUTION_CONFIRMATION
```

Before submitting changes: `npm test`, `npm run check:repo`, `npm run typecheck`, `npm run build`, and commit the
regenerated `dist/` output (it is published and must stay in sync with `src/`).

## Architecture

`protocol.ts` (`ButterSwidgeProtocol`) is the WDK entry point and orchestrates the other modules.
`quoteSwidge` returns a `ButterSwidgeQuote` (a `SwidgeQuote` plus `routeHash`); passing that
`routeHash` back via `swidge`'s `ButterSwidgeOptions` pins the approved route (else expired/mismatched
pins throw `ButterActionRequiredError` instead of silently re-quoting). `swidge` also requires an
explicit `options.recipient` whenever the destination chain's **address family** differs from the
source's (`constants.ts: addressFamilyForChain`) — WDK's "recipient defaults to the account address"
only holds within one family, and the default is first *used* at the `/swap` stage as the destination
receiver. That requirement is execution-only; `quoteSwidge` must stay usable without a recipient.
Everything else is a focused collaborator it composes:

- **`route.ts`** (`RouteManager`) — builds `/route` requests, caches quotes keyed by request+amount
  (bounded/evicting cache), and re-validates that a cached/fresh route still matches the requested
  chains/tokens before use. A **cross-chain** request (`fromChainId !== toChainId`) requires the route
  to include `dstChain` matching the target chain/token — a missing `dstChain` is a same-chain path and
  is rejected (otherwise `mappers.ts` would quote the wrong source leg). Also indexes routes by hash so
  `swidge` can pin an approved quote via `options.routeHash` (`consumeRouteByHash`), and supports a
  Solana `senderFallback` for the receiver. Forwards `config.affiliate`/`config.referrer` when set —
  spread **conditionally**, so an unconfigured integrator's request (and cache key) is byte-identical
  to what it was before; both enter the key through `stableRouteKey`'s spread of the whole request, so
  a changed affiliate can never hit a route cached under the previous one. A Solana **same-chain**
  route without `referrer` throws `ButterConfigurationError` (Butter documents it as mandatory there).
  Route TTL and both freshness margins come from
  `constants.ts`. The **execution** margin (`ROUTE_EXECUTION_MARGIN_SECONDS`, 45s, overridable via
  `config.routeExecutionMarginSeconds`) is deliberately much larger than the **quote** margin
  (`ROUTE_EXPIRY_MARGIN_SECONDS`, 15s): execution still owes a `/swap` round-trip, an optional
  approval (10s receipt wait by default), and the swap send, whereas a quote is non-binding. Don't
  re-invert these. Inside the margin `getRoute` re-quotes, but `consumeRouteByHash` **throws**
  (`ButterActionRequiredError`) — a pin is a price the caller approved, so it is never silently
  re-fetched at a different price.
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
  quoted a non-zero referrer fee — so a quoted fee cannot be silently dropped nor an unchecked
  `feeType`/`referrer` injected by under-specifying the quote); and the `tx.value` bounds — the
  native **input** half is a hard *lower* bound, while the remaining **fee** half is bounded only
  from *above* (by `maxNativeFee` and by the quoted `routerFee + bridgeFee` plus
  `NATIVE_FEE_DRIFT_BPS`). It is deliberately **not** an exact equality: `/route` formats the router
  fee as a decimal string and `/swap` returns `tx.value` as a hex integer, so a sub-wei round-trip
  artifact would otherwise reject a good transaction; paying *less* than the quoted fee is harmless
  (the router reverts if it is genuinely insufficient). The bridge messaging fee inside `tx.value` is
  trusted from `/swap`, so the actual native-drain guard is the **`maxNativeFee`** absolute cap on
  the fee half (`context.maxNativeFee`); cross-chain execution **fails closed** when it is unset —
  keyed on *destination chain ≠ source chain*, never on the calldata reporting a non-zero bridge fee
  (a route that under-reports it must not opt out of the cap). The cap is resolvable **per call**
  (`ButterSwidgeExecutionOptions.maxNativeFee`, which wins over the configured one in either
  direction and satisfies the cross-chain requirement itself) — a single construction-time absolute
  cannot fit both a small and a large trade. Same-chain
  `swapAndCall` additionally checks destination token, receiver, leftover receiver, and minimum output.
  **Cross-chain destination routing** (the nested bridge payload: destination receiver, output token,
  minimum output) is intentionally **trusted to Butter** and not re-verified — only that the bridge
  targets the quoted destination chain. Source exposure stays bounded because `evm.ts` approves only
  the exact input amount to the router. The **one exception** is an explicitly requested
  `options.refundAddress`: naming a refund destination asks for a guarantee, so
  `validateBridgeRefundAddress` decodes `BRIDGE_DATA_PARAM` — Butter's documented
  `(gasLimit, refundAddress, swapData)` — and compares it (raw 20 bytes for an EVM address, UTF-8
  text otherwise), **failing closed** with `ButterUnsupportedError` on an empty or
  differently-shaped payload rather than letting an unverifiable guarantee pass as held. Omitting
  `refundAddress` is the documented way back to Butter's default, and it must keep the nested payload
  **undecoded** — that asymmetry is what leaves the default path's trust boundary unchanged.
  Same-chain has no bridge payload, so `swapAndCall`'s `leftReceiver` plays that role and is compared
  against `refundAddress ?? sender`. `refundAddress` is deliberately **not** required to equal the
  sender (the old `protocol.ts` gate asserted that without ever checking the calldata, and it is
  meaningless across address families).
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
  `queryTokenList`), plus `/findToken` decimals lookups. Both listings are **fail-closed on
  missing required metadata**: a token without usable decimals and a chain without an `id`,
  `type`, or `nativeToken` symbol are dropped rather than surfaced with a placeholder
  (`mappers.ts` emits `''`, never `'unknown'`, so the caller decides). Strict-slippage chain
  detection runs **before** the chain filter — dropping a chain from the listing must never
  relax its slippage floor, which is looked up by chain id whether or not the chain was listed.
  `/findToken` supplies decimals when `config.tokenDecimals` doesn't cover a token. An entry is
  trusted only when **both its chain and its address match the request** (`sameIdentifier`, so a
  Base58 mint is case-sensitive) — never `data[0]`, and never chain alone. Butter matching by address
  and ignoring the `chainId` param describes its behaviour, not a guarantee about the response: an
  earlier revision filtered on chain only, reasoning the address "must" already be right, and a
  same-chain entry for a different token could then supply the decimals. Those decimals become
  `FeeContext.sourceTokenDecimals`, so a wrong value reopens the fee-cap bypass
  `trustedSourceDecimals` exists to close. Matching decimals must be an integer from 0 through 255,
  and both decimals aliases and duplicate matching entries must agree; malformed/conflicting metadata
  throws a typed error and is never cached. An affirmative not-found is cached for 300 seconds, while a response that simply
  lacks the requested token is inconclusive and uncached. Successful lookups and short-lived misses
  share a 256-entry LRU. Transport failures rethrow (not "unknown token").
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

- **Case-insensitivity is a property of EVM hex, not of identifiers — and normalization is per format
  space**: `identifiers.ts` has two domains that are not interchangeable. `normalizeIdentifier` /
  `sameIdentifier` (token identifiers) lowercase **only** confirmed `0x`-hex.
  `normalizeTransactionHash` / `sameTransactionHash` also accept bare 64-hex, since BTC and Tron
  txids have no `0x` prefix; length 64 keeps Base58 out (Solana signatures are 87–88 chars,
  addresses 32–44). One rule for both is wrong in both directions — the token rule rejected a BTC
  txid differing only in case. `normalizeTokenKey` exists so building and querying the `tokenDecimals`
  map share one function; normalizing only the query made a checksummed config key unreachable from a
  lowercase request, masked by `/findToken`. Conflicting entries throw at construction. `tokenDecimals`
  never applies to native tokens — `decimalsFor` answers those from `NATIVE_TOKEN_ADDRESSES` and
  `config.nativeTokenDecimals` first. Solana mints and signatures and Tron addresses are Base58, where a
  character's case is part of the value. A blanket `toLowerCase()` simultaneously let a fee in a
  different mint pose as the source token (taking the caller's input as its denominator and passing a
  cap), let a route satisfy the token-intent check with a differently cased token, merged two mints in
  discovery into one entry sharing a decimals cache slot, and treated two Solana signatures as one
  operation. Symbols, chain ids, chain type/name and status strings are human-readable and stay
  plainly case-insensitive; `swap-data.ts`, `router-registry.ts` and the router/signer address checks
  are EVM-only by construction and stay as they are.

- **Middle-tier trust boundary** (the definitive statement is in `AGENTS.md`): Butter responses are
  partially trusted. Always keep the router allowlist, the single-transaction EVM rule, top-level
  intent checks, the `feeData`↔`feeConfig` check, the `tx.value` bounds, the `maxNativeFee` cap
  (the real native-drain guard; cross-chain fails closed without it, keyed on the destination chain
  rather than on a Butter-reported bridge fee), same-chain destination checks,
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
  (`ButterExactOutUnsupportedError`), including via the WDK base-class `swap()`/`quoteSwap()`
  delegation path. Butter documents `type: exactOut`, but the default production endpoint answers
  `errno 2000` ("Parameter error") while the same request succeeds as `exactIn`, and `/route` defines
  `amount` only as "amount of source token" with no exactOut variant — so the denomination to send is
  unspecified too. `npm run example:probe-exact-out` re-checks both against the live API. Re-enabling
  exact-out requires a fresh input-bound design and security review; the exact-in calldata and fee
  validators intentionally contain no dormant exact-out branch.
- **Source-denominated fee caps fix both the denominator and the scale**: the numerator must be
  parsed with `FeeContext.sourceTokenDecimals` — resolved by this package when building the `/route`
  request and carried on `CachedRoute.sourceDecimals` — never with `route.srcChain.tokenIn.decimals`.
  `route.ts` checks the source token's address but not its decimals, so a response claiming
  `decimals: 0` shrinks a 10 USDC fee to `10n` and 1000 bps reads as 0.001. Declared decimals that
  disagree with the resolved value are refused (`trustedSourceDecimals`). Recognizing a
  source-token component (`isSourceTokenComponent`) follows one rule: **a symbol can only ever
  confirm a symbolic identifier.** A declared address decides alone; the symbol is consulted only
  when the component has no address *and* `sourceToken` is itself symbolic
  (`SYMBOLIC_NATIVE_TOKEN_IDS`) — use that closed set, not a `0x` shape test, or a Solana mint counts
  as symbolic. This has failed in three directions across three reviews (too strict; symbol beating a
  declared address; an ungated fallback letting any component name the source address in its
  `symbol`), so the full matrix is pinned by a table-driven test in `tests/fees.test.ts` — **extend
  the table, don't add another one-off case**. A trusted denominator is not automatically a
  meaningful one.
  Matching a component to a route **leg** (`sameTokenAddress`) requires an address on both sides,
  because a symbol is not an identifier. Those two strictnesses are deliberately opposite; having
  them the wrong way round was itself a bypass. Applies to any
  source-denominated amount including a bridge component in the source token, and **in quoting as
  well as capping** (`componentDecimals`, `swapFee.tokenFee` in `mapRouteFees`) — a quote needs no
  cap configured for a caller to read an understated number and act on it. A cross-denominated
  component keeps its own decimals, where numerator and denominator are both route-reported in the
  same token and the scale cancels. The actual Butter swap fee is authoritative from `swapFee`;
  `feeConfig` is validation-only metadata for Router calldata and is never valued as a second fee.
  Non-empty `feeData` runs its quoted tuple through `parseFeeConfigForValidation`: non-negative
  bigint rate, integer `feeType` in {0,1}, complete referrer, and typed transaction-validation
  errors. Empty `feeData` is allowed when `rateOrNativeFee` is zero, because the other tuple fields
  are unused when no referrer fee is encoded. `enforceLimit` rejects negative numerators too.
- **Source-denominated fee caps never use a route-reported denominator**: this covers
  `fees.ts: bridgeFeeComponentRatio` too — a bridge fee component charged in the source token must use
  `sourceDenominator`, falling back to a route amount only for a genuinely cross-denominated component
  and only when matched **by token**; no same-token denominator means `ButterFeeValuationError`, never
  division by another currency. Cap enforcement also separates **absent** metadata from an explicit
  zero: a missing `gasFee.amount` (network cap) or no bridge fee at all on a cross-chain route
  (protocol cap) throws `ButterFeeValuationError`, since scoring an unreported fee as free lets any cap
  be passed by omission.
- **`bridgeFee` is priced per component, `swapFee` is the authoritative actual swap fee**:
  `bridgeFeeComponents` emits `in`, `out` and `affiliate` as separate entries with their own tokens
  and a `role` that picks the matching route leg (`in` and `out` are usually the same token, so one
  shared candidate order measured the outbound fee against the inbound amount). The top-level
  `bridgeFee.amount` summary is **never priced** — not directly, not reconstructed as
  `amount - affiliate`, not even compared against the components' sum, since amounts in different
  tokens are not addable. One figure in one token cannot describe a fee spanning three, and an
  untrusted response could omit the components and offer a small, conveniently-denominated summary
  that satisfies any cap. It serves only as a detector: with no component present, `mapRouteFees`
  warns `bridge-fee-components-missing` and omits the fee, and a configured cap throws. It is equally
  unfit as **evidence** — `hasBridgeFeeComponents` counts only `in`/`out`/`affiliate` amounts, so an
  explicit component `"0"` passes but a bare `{ amount: "0" }` does not; otherwise a response
  satisfies `maxProtocolFeeBps: 0` with a summary it was never willing to stand behind.
  `affiliate.amount` must be one of the counted fields. The
  affiliate **is** aggregated into `maxProtocolFeeBps` while keeping its `affiliate` fee type: WDK has
  no affiliate cap, and an unset `config.affiliate` means Butter takes the cut with its own wallet.
  For `maxProtocolFeeBps`, both `swapFee.nativeFee` and `swapFee.tokenFee` must be present and are
  valued as the complete Butter swap-fee result. `swapFee` already includes any referrer charge
  configured by `feeConfig`, so deriving another fee from `feeConfig`, summing it, or choosing a
  larger value would misstate the actual fee. `validateFeeData` still checks non-empty Router
  `feeData` against the complete quoted `feeConfig` tuple; this is calldata consistency validation,
  not fee valuation.
- **Fail closed on unvaluable fees**: if a configured fee cap can't be evaluated (missing USD
  metadata, zero gas fee, etc.), throw `ButterFeeValuationError` rather than skipping the check.
- **Conservative status**: an unrecognized Butter state maps to `pending`, never a false terminal;
  a missing/absent state (invalid id) throws. Approval receipts fail closed on revert.
- **Adapter path has a different trust boundary**: `transactionAdapters` (non-EVM / Tron / BTC /
  Solana execution) bypasses the Router V3 calldata validation used on the built-in EVM path —
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
on-chain funds; `tests/butter-swidge-protocol.test.ts` has reusable `makeFetch`/`quoteRoute`/
`sourceChainWithToken` helpers for building fixtures. Live-network checks belong in `examples/`,
gated behind env vars and (for `swap.ts`) an explicit `EXECUTION_CONFIRMATION` string.

## Commit style

Conventional Commits (`fix: ...`, `feat: ...`, `docs: ...`). Keep commits cohesive and include the
regenerated `dist/` output when `src/` changes. PRs should state behavior/security impact, list
verification commands run, and call out any public API or configuration changes.
