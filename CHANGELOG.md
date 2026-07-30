# Changelog

All notable changes to `@butternetwork/wdk-protocol-swidge-butter` are documented
here. This project follows [Conventional Commits](https://www.conventionalcommits.org)
and (once published) [Semantic Versioning](https://semver.org).

## [Unreleased]

Security hardening from multi-round expert review. **Breaking** changes are marked.

### Security / correctness
- Enforce fee-cap ratios against the caller's `fromTokenAmount`, not the
  Butter-reported `srcChain.totalAmountIn` (an inflated route could otherwise slip
  an over-cap fee past `maxNetworkFeeBps`/`maxProtocolFeeBps`).
- ERC-20 approval is now always the **exact** input amount: an oversized existing
  allowance is reduced (via `approve(0)` then `approve(amount)` for tokens that
  require it) instead of being left in place.
- Fail closed when an ERC-20 approval cannot be confirmed (no
  `waitForTransactionReceipt` / `getTransactionReceipt`) instead of sending the
  swap against an unconfirmed approval.
- Match the calldata `feeData` against the route's quoted `feeConfig` as a full
  `(feeType, referrer, rateOrNativeFee)` tuple: reject an empty `feeData` when the
  route quoted a non-zero integrator fee, and — for a non-empty `feeData` — fail
  closed when the quoted tuple is incomplete instead of matching only the fields
  present, so `/swap` cannot inject an unchecked `feeType`/`referrer` by
  under-specifying the quote.
- Classify all non-EVM adapter output **before broadcasting any transaction**:
  an illegal type, an unclassified multi-transaction result, or anything other than
  exactly one `source` now throws with nothing sent (previously each transaction was
  sent before the classification check, so a rejected result could leave a
  partially-broadcast operation a retry would double-execute).
- Report partial execution instead of discarding it: when execution fails *after* one
  or more transactions have already been broadcast — a later send (`approve(0)` /
  `approve(amount)` / the swap, or several adapter legs) **or** an approval that
  cannot be confirmed (revert, unknown receipt status, confirmation timeout) —
  `swidge()` now throws a `ButterPartialExecutionError` carrying every broadcast hash
  in submission order plus the original `cause`, and registers a broadcast `source`
  transaction so `getSwidgeStatus` still resolves the in-flight swidge. Previously the
  already-sent hashes were lost with the stack frame and a caller could not tell a
  wallet rejection (nothing sent) from a partially applied operation. A failure before
  anything is broadcast still propagates unwrapped.
- Record a transaction the moment its send returns, *before* validating the gas fee
  it reported, and keep the fee total and result assembly inside the guarded region.
  Previously a send that succeeded on-chain but reported a bad fee threw before it
  was ever recorded, so the hash was lost — the exact gap the partial-execution
  report was added to close.
- Validate sender-reported gas fees as non-negative **bigints** at runtime on both
  the built-in EVM path and the adapter path. The wallet client and transaction
  adapters are host-supplied, so the declared `bigint` is not a runtime guarantee: a
  `number` slipped past the old `fee < 0n` test (JS allows mixed relational operands)
  and surfaced later as a raw `TypeError` from the bigint sum, carrying no
  transactions at all.
- Validate sender-reported transaction **hashes** at runtime under the same rule,
  on both paths: a hash must be a non-empty string. Previously the string form was
  taken verbatim and the object form only tested truthiness, so an empty hash
  resolved successfully with an unusable `id: ''` (after burning the full approval
  timeout polling a blank hash on the ERC-20 path), and a numeric hash was recorded
  and then threw a raw `TypeError` from `rememberOperationKind`'s `toLowerCase()` —
  which the partial-execution reporter also calls, so the report itself threw and
  the broadcast hashes were lost anyway. The reporter no longer lets a failure in
  best-effort status registration cost the caller its transaction list.
- Distinguish a genuine "not found" (viem `TransactionNotFoundError` /
  `TransactionReceiptNotFoundError`) from infrastructure faults in
  `evm.publicClient` lookups: RPC timeout / auth / rate-limit errors now propagate
  instead of being swallowed as absence (which masked a same-chain status as a
  perpetual `pending` or silently fell back to the cross-chain API). The match is
  copy-independent (viem error `name` + `BaseError` shape, with `instanceof` kept as
  a fast path), so a genuine not-found is still recognized when the host application
  resolves a different copy of `viem` than this package — while an unrelated error
  that merely shares the name is still rethrown.
- `getSwidgeStatus` attributes a same-chain id to an allowlisted Router
  (`swapAndCall`) before trusting its receipt; explicit hints no longer bypass
  attribution, so an unrelated transaction is never reported as a completed swidge.
- Approval-receipt confirmation and same-chain status share one fail-closed
  receipt classifier (unknown status is never treated as success).
- Add an absolute `maxNativeFee` cap on `routerFee + bridgeFee`; cross-chain
  execution fails closed without it. Same-chain fee-cap semantics documented.
- Bound `tx.value` instead of requiring exact equality with
  `input + routerFee + bridgeFee`. `/route` formats the router fee as a decimal
  string while `/swap` returns `tx.value` as a hex integer, so a sub-wei artifact
  in that round-trip previously failed an otherwise valid transaction. The native
  input half is now a hard *lower* bound and the fee half an *upper* bound only
  (`maxNativeFee`, plus the quoted `routerFee + bridgeFee` and a 0.5 %
  formatting-drift tolerance as a consistency check) — paying less than the quoted
  fee cannot harm the user, since the router reverts if it is genuinely
  insufficient. The security property is unchanged: source-token exposure stays
  bounded by the exact approval and native spend by `maxNativeFee`.
- Verify the refund address Butter actually encodes instead of asserting one.
  Execution previously required `refundAddress` to equal the source sender and
  never checked the calldata, so the constraint bought nothing: the nested bridge
  payload that carries the field was not decoded. It is now decoded and compared
  (raw 20 bytes for an EVM address, UTF-8 text otherwise) whenever the caller
  names a refund destination, and fails closed with `ButterUnsupportedError` when
  the payload is empty or does not match Butter's documented
  `(gasLimit, refundAddress, swapData)` layout — an unverifiable guarantee is
  never reported as holding. Same-chain has no bridge payload, so `swapAndCall`'s
  leftover receiver is compared against the requested address instead. Omitting
  `refundAddress` leaves Butter's default in place and the nested payload
  undecoded, so the default path's trust boundary is unchanged.
- Value the route's native protocol fee by rounding **up** when Butter reports
  more decimals than the chain's native token has. It is the quoted side of an
  upper bound, so rounding up can only widen the bound by one wei, whereas the
  previous hard rejection failed the whole quote on a formatting artifact.
- Require a route freshness margin on the **execution** path, configurable via the
  new `routeExecutionMarginSeconds` (default 45s). The two margins were previously
  inverted: quoting demanded ≥15s of remaining route lifetime while execution
  accepted any route that had not literally expired — even though execution still
  has to complete a `/swap` round-trip, an optional ERC-20 approval (whose receipt
  wait defaults to 60s), and the swap send. A route with a second left could pass
  `/swap` and then land on-chain long after its quote went stale, leaving only
  `minAmount` as protection. Inside the margin, unpinned execution now re-quotes;
  a pinned `routeHash` is rejected with `ButterActionRequiredError` rather than
  silently re-fetched, since a pin is a price the caller already approved. Raise
  the margin above `evm.approvalTimeoutMs / 1000` when approvals are expected.
- Allow `maxNativeFee` to be set **per call** on `swidge(options)`, taking
  precedence over the configured value in either direction (and satisfying the
  cross-chain fail-closed requirement on its own). It is the only guard that
  actually bounds native spend, and as a construction-time absolute it could not
  serve a long-lived instance across a wide range of trade sizes — too low made
  small routes unusable, too high made the cap nominal. The caller knows the size
  at call time.
- Forward Butter's `affiliate` and `referrer` parameters to `/route` via the new
  `affiliate` / `referrer` config. Previously neither was sent, with two
  consequences: Butter substituted its **own** default affiliate wallet (the
  documented behaviour when the parameter is absent), so the integrator could
  neither collect nor waive a share the user was paying regardless; and Solana
  **same-chain** routes — which Butter documents as requiring `referrer` — could
  never produce a valid request, which now fails as an explicit
  `ButterConfigurationError` instead. `affiliate` is validated at construction
  (`<nickname>[:rate]`) precisely because an unusable value fails silently on
  Butter's side. Both participate in the route cache key; when unset, neither
  appears in the request, so an existing integrator's cache keys are unchanged.
- `getSupportedChains` now applies the same fail-closed rule as
  `getSupportedTokens`: a chain missing an `id`, `type`, or `nativeToken` symbol
  is dropped instead of being listed with a placeholder. WDK marks both fields
  as required, and the previous `'unknown'` / `''` values read as authoritative
  while being nothing of the kind. Detection of strict-slippage chains still runs
  before the filter, so dropping a chain never relaxes its slippage floor.
  `npm run example:discover` now reports which chains the filter dropped and
  which field each was missing, so the cost is measurable on live data.
- Check the HTTP status **before** parsing the body. A failing gateway commonly
  returns HTML, so parsing first threw a raw `SyntaxError` and lost both the status
  code and this package's error typing on the single most common failure mode.
  Non-2xx now raises `ButterApiError` with `{ status, body }` (body read as text and
  truncated), and an unparseable 2xx body raises one too instead of escaping as a
  `SyntaxError`.
- Reject negative integer amounts in every input form. A `"-1"` string previously
  passed `parseIntegerAmount` and only failed later in an equality comparison, which
  pointed the error at the wrong cause. Also removed a dead branch that special-cased
  a `0x` prefix `BigInt` already handles.
- Validate caller-supplied base-unit amounts through one shared
  `assertBaseUnitAmount`, so `minAmountOut` gets the guard `fromTokenAmount` already
  had. An out-of-range `number` (WDK types these as `number | bigint`) previously
  reached `BigInt()` and threw a raw `RangeError` naming neither the field nor this
  package.
- Round **reported** fee amounts down rather than rejecting extra decimals: a USDT
  fee quoted to 7 places used to fail the whole quote over a formatting artifact,
  and under-reporting a displayed fee by one base unit cannot harm the caller. The
  cap-enforcement parses are deliberately left on `reject` (or `ceil` for a quoted
  upper bound), where the rounding direction does matter.
- Warn instead of silently misreporting when the legacy fee scalars are
  meaningless. The new `onWarning` config receives
  `mixed-currency-protocol-fees` when the `protocol` group spans several tokens, and
  `no-fees-reported` when Butter reports none.
- `fees[]` is never empty: a route with no reported fees yields a single
  zero-amount `network` entry (the WDK guide requires a populated array, and an
  empty one reads as "free" rather than "Butter told us nothing"). As a side effect,
  a measured source gas fee now lands on that entry even when the route carried no
  `gasFee` metadata, where it was previously dropped.
- Describe each transaction when `/swap` returns more than one, instead of only a
  count. The single-Router-transaction rule is unchanged, but the error now carries
  `{ index, to, chainId, value, method }` per entry, so "one Router call plus an
  approval" is distinguishable from "two Router calls" — which is what decides the
  response. Butter documents `/swap` as returning one *or more*, so this narrowing
  is deliberate and now explains itself.
- Fall back to the next liquid route candidate. Butter returns candidates ordered
  best-output-first; taking `[0]` unconditionally failed the entire request whenever
  the top candidate happened to lack liquidity. Chain/token validation still runs on
  whichever candidate is chosen.
- Cross-chain routes must include a matching `dstChain` (a missing one is a
  same-chain path and is rejected).
- The built-in EVM path executes exactly one Router transaction.
- Exact slippage→bps conversion (no floating-point drift, incl. scientific
  notation).
- `priceImpact` is only surfaced from an authoritative source (per-leg values are
  no longer guessed), and `SwidgeResult.fees` reports measured source gas only
  when every send reports a fee.

### Breaking
- EVM execution requires **both** a full (send-capable) WDK account **and**
  `evm.walletClient`; the raw `evm.sendTransaction` callback and
  `evm.approvalAmount: 'max'` options were removed. Wrap a viem wallet client with
  the new `toEvmWalletClient` and a viem public client with `toEvmPublicClient`.
- `EvmWalletClient.account` is now required (its address is validated against the
  WDK account so the signer, calldata initiator, and allowance owner cannot split).
- A failure that occurs once an approval is on the wire — a reverted approval, an
  uninterpretable receipt status, a confirmation timeout, or an unusable gas fee
  reported by the sender — now surfaces as
  `ButterPartialExecutionError` rather than the bare `ButterConfigurationError`. The
  original error is preserved as `.cause`, so callers matching the underlying type
  should read `error.cause` (the swap is still never sent against an unconfirmed
  approval).
- Cross-chain execution now **always** requires `maxNativeFee`. The fail-closed
  requirement is keyed on the destination chain differing from the source chain; it
  was previously conditioned on the calldata declaring a non-zero bridge fee, so a
  route reporting a zero bridge fee opted out of the only cap that bounds what
  `tx.value` actually spends.
- `refundAddress` changes meaning on `swidge`. It no longer has to equal the
  source sender — that rejection is gone, and a cross-VM refund destination (or a
  cold wallet / multisig) is now accepted. In exchange, a requested
  `refundAddress` that cannot be verified against the calldata now throws
  `ButterUnsupportedError` where execution previously proceeded. Callers who were
  passing the sender's own address to satisfy the old rule can simply drop the
  field. `quoteSwidge` is unaffected.
- `swidge` now requires an explicit `recipient` when the destination chain's
  address family differs from the source chain's (EVM → Solana / BTC / TON / Tron
  and the reverse). WDK's documented default — recipient falls back to the wallet
  account address — is only meaningful within one address family; across families
  it forwarded a `0x` address as the destination receiver, at best rejected by
  Butter and at worst delivering funds to an address nobody can spend. Families
  come from a best-effort table of Butter's non-EVM chain ids
  (`constants.ts: NON_EVM_CHAIN_FAMILIES`); unlisted chains are assumed EVM, so
  the table must be extended when Butter adds a non-EVM chain. `quoteSwidge` is
  unaffected and still prices a cross-VM route with no recipient.
- Exact-out (`toTokenAmount`) is no longer rejected outright. `quoteSwidge` accepts
  it unconditionally, and `swidge` requires the new `options.maxFromTokenAmount` —
  raising `ButterConfigurationError` without it, the same fail-closed treatment as a
  missing cross-chain `maxNativeFee`. WDK's exact-out options name the output and
  carry no input cap, so that value is the only caller-supplied bound on the source
  spend; the alternative would be trusting Butter's own `srcChain.totalAmountIn`,
  i.e. letting the response validate itself. The cap is what the calldata's source
  amount is checked against (`amount <= cap`), what the ERC-20 approval is set to,
  and what bounds the source-denominated fee-cap denominator. Exact-out **execution**
  is unreachable through the legacy `swap()`, whose options have nowhere to carry the
  cap; quoting via `quoteSwap({ tokenOutAmount })` works.
  `ButterExactOutUnsupportedError` is `@deprecated` and no longer thrown, but remains
  exported so existing `catch` clauses compile.
- `ButterSwidgeQuote` gains a required `destinationGuarantees` field
  (`'enforced' | 'quoted-only'`). Code that only reads quotes is unaffected; code
  that *constructs* the type must now supply it.
- `assertQuoteOptions` rejects "both amounts" and "neither amount" with a single
  message naming both modes, where it previously said only `fromTokenAmount is
  required`.
- `getSupportedChains` may return **fewer** chains than before: entries whose
  merged discovery metadata lacks a `type` or a `nativeToken` symbol are dropped.
  Consumers that relied on `type: 'unknown'` or `nativeToken: ''` appearing in the
  listing will no longer see those entries. Quoting and execution are unaffected
  (they take chain ids from the caller, not from this listing).
- Multi-transaction non-EVM adapters must classify each transaction
  (`{ transaction, type }`) and resolve to **exactly one** `source` (the operation
  id); an ambiguous, unclassified, or illegally-typed result is now rejected before
  any transaction is broadcast.
- The `@tetherto/wdk-wallet` peer range is capped to `<2.0.0`.

### Types
- Export `ButterNoRouteError` (extends `ButterApiError`), raised for Butter's in-band
  `errno 2003` "No Route Found" and for a response whose candidates all lack
  liquidity — so an unroutable pair (normal, retryable) is finally distinguishable
  from a bad parameter or a rejected API key. Both previously surfaced as a plain
  `ButterApiError`, which still matches it.
- Export `ButterSwidgeStatusOptions` (`SwidgeStatusOptions & { byOrderId?: boolean }`)
  and use it for `getSwidgeStatus`, replacing an inline object literal that TypeScript
  consumers could not name. `byOrderId` is documented rather than removed: this
  package never produces an order ID (`SwidgeResult.id` is always the source hash), so
  the flag is for callers who obtained one from Butter separately.
- Export `ButterWarning` and `ButterDestinationGuarantees`; add `config.onWarning`
  and `options.maxFromTokenAmount`.
- Export `ButterPartialExecutionError` (extends `ButterActionRequiredError`) with a
  `transactions: readonly SwidgeTransaction[]` list and the underlying `cause`.
- Export `ButterAdapterResult` and `ViemPublicClientLike`, and simplify
  `ButterTransactionAdapter`'s return type — previously `unknown | ButterAdapterResult`,
  which collapsed to `unknown` — so the typed adapter form is discoverable. Return
  stays intentionally open for arbitrary non-EVM transaction shapes.

### Tooling
- `test/` is now type-checked (`tsconfig.test.json`, wired into `npm run typecheck`).
  It never was, and the net immediately caught four latent errors in tests that had
  been passing: a legacy `bridge()` call passing `targetChain` as a number where WDK
  declares a string, two unchecked array index accesses under
  `noUncheckedIndexedAccess`, and an explicit `undefined` override rejected by
  `exactOptionalPropertyTypes`.
- Added coverage for the legacy delegation paths the WDK integration guide requires
  (§7.2). `quoteSwap` and `quoteBridge` had none at all.

### Known upstream issue
- The WDK base class's legacy `swap`/`quoteSwap`/`bridge`/`quoteBridge` sum
  `fees[].amount` across denominations (ignoring `fee.token`); the scalar totals
  are only meaningful when all fees share a currency. This requires a WDK-side fix
  (PR #39 follow-up); consumers should read the itemised `fees[]`. Worse than first
  documented: only `bridge`/`quoteBridge` group by fee **type** at all —
  `swap`/`quoteSwap` add every entry together regardless of type or currency. A
  regression test now pins both behaviours so a WDK-side fix is noticed, and
  `config.onWarning` reports when a route is affected.

### Follow-ups
- Testnet integration tests (per the WDK integration guide) are not yet included;
  the env-gated flows in `examples/` cover live checks in the meantime. Now also
  listed under "Known limitations" in the README so integrators see it, not just
  contributors.
- Deferred robustness items, none affecting correctness: inject the clock into
  `evm.ts` (approval polling still uses a bare `Date.now()`, bypassing the injectable
  `config.now` used for route TTLs — note the seconds/milliseconds mismatch when
  fixing); an `evm.allowanceStrategy: 'exact' | 'sufficient'` option (an existing
  allowance *larger* than the input currently costs two extra approvals to reduce);
  a TTL or `refreshChains()` for `DiscoveryService.chainDetails` (populated once and
  reused for the process lifetime, so a long-lived instance never sees new Butter
  chains); and splitting the strict-slippage detection out of `getSupportedChains`,
  which mutates policy state as a side effect of a getter.
- Not passing Butter's `caller`/`swapCaller` (semantically already the sender, which
  the calldata `initiator` check enforces) or `disableSrcSwap` (no confirmed demand;
  it would add a route cache-key dimension).
- `/swap` returning multiple transactions is reported with per-transaction detail but
  still rejected. Absorbing a recognizable ERC-20 `approve` from that array was
  considered and declined: `evm.ts` already issues its own exact-amount approval, and
  accepting one from `/swap` would add a second approval source and a new trust
  surface.
- Two behaviours are pending a check against live Butter responses before
  release, both covered by read-only env-gated examples: the nested cross-chain
  bridge payload layout that the explicit-`refundAddress` check decodes
  (`npm run example:decode-swap-data` reports `layoutConfirmed`; if Butter's live
  encoding differs from its documentation, an explicit `refundAddress` fails
  closed rather than mis-verifying, but the feature would be unusable until the
  layout is corrected) and how much chain coverage the new discovery metadata
  filter costs (`npm run example:discover`).
- Enforcing the destination minimum output for cross-chain routes would make
  `toTokenAmountMin` a guarantee rather than a route estimate. The nested payload
  is now decoded at one point (for `refundAddress`), which is where that check
  would go, but it tightens the documented trust boundary and needs its own
  security review.
- A relative `maxNativeFeeBps` (scaling the native cap with trade size) was
  considered alongside the per-call absolute cap and deliberately deferred: it
  would have to reuse the USD valuation chain in `fees.ts` for non-native inputs,
  and the per-call absolute already covers the case that motivated it.
