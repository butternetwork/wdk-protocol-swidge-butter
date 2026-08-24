# Changelog

All notable changes to `@butternetwork/wdk-protocol-swidge-butter` are documented
here. This project follows [Conventional Commits](https://www.conventionalcommits.org)
and (once published) [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed
- Align the package with WDK review conventions: public Viem adapters no longer
  expose `any`, deterministic tests exercise only the package entrypoint with
  concrete assertions, and repository checks and live E2E scenarios have
  dedicated `checks/` and `scripts/e2e/` entrypoints.
- Split the protocol regression suite by public method, isolate stateful public
  workflows under `tests/integration`, require exact error names and messages,
  and use SDK-realistic EVM addresses and transaction hashes in fixtures.
- Narrow the configurable EVM client contracts to Viem read parameters and the
  package's `EvmTransactionRequest`, while preserving open-ended non-EVM adapter
  payloads.
- Remove unreachable exact-out execution branches while retaining the public
  fail-fast unsupported error, and split `swidge()` preparation, broadcasting,
  and result assembly into focused private stages without changing execution
  ordering or partial-execution reporting.
- Remove built-in TON chain metadata, native aliases, address-family handling,
  and strict-slippage behavior. Unrecognized chains continue through the generic
  unknown-chain path instead of receiving chain-specific treatment.
- Make GitHub Release publishing idempotent: an npm version already published
  from the same tag commit is a successful no-op, while registry errors and
  mismatched or invalid `gitHead` metadata fail closed.
- Raise the supported `@tetherto/wdk-wallet` floor to `1.0.0-beta.15`, develop
  against `1.0.0-beta.17`, and omit absent optional fields to match WDK's exact
  optional-property declarations without changing populated results.

### Documentation
- Replace generated-style JSDoc wording with domain-specific parameter and return
  contracts, and reject placeholder wording or internal-module test imports in
  the AST compliance checks.
- Add Tether's reviewed "Built with WDK" badge to the README and published
  package contents.
- Complete JSDoc descriptions, parameters, return values, and thrown-error
  contracts across named source declarations, with an AST-based regression gate.
- Add a security policy covering supported versions, private vulnerability
  reporting, response and disclosure timelines, safe harbor, and reward terms;
  publish it with the npm package and link it from the README.
- Align the README with WDK provider documentation requirements: add a complete
  read-only discovery and quote example, make execution configuration explicit,
  enumerate every supported status mapping, and include the zero-fee placeholder
  in the fee mapping table.
- Replace the static supported-chain snapshot with runtime discovery guidance, so
  historical Router allowlist entries are not presented as current Butter support.

## [0.1.0] - 2026-08-04

Security hardening from multi-round expert review. **Breaking** changes are marked.

### End-to-end testing
- Raise the read-only BSC-to-Polygon default input from 0.001 BNB to 0.01 BNB.
  Butter's fixed protocol fee exceeded the existing 1000 bps safety cap on the
  smaller quote; the larger no-broadcast input keeps the cap intact while making
  the production API check viable.
- Add a no-broadcast live Butter API workflow for pull requests, scheduled runs,
  and local checks. It exercises discovery, quoting, `/swap` assembly, and local
  transaction validation without a private key or Butter credentials.
- Add confirmation-gated funded scenarios for same-chain native, same-chain
  ERC-20, and cross-chain native swaps. Each scenario requires explicit input,
  native-fee, protocol-fee, and cumulative gas budgets before signing.
- Add resumable status polling and redacted JSON result artifacts. Partial
  execution hashes are recorded immediately and are never retried automatically.

### Discovery
- Clarify that `getSupportedTokens` returns Butter's advertised, non-exhaustive
  token catalog rather than a route allowlist. Quotes and swaps continue to let
  `/route` determine whether tokens omitted from the catalog are routeable.
- Move `getSupportedTokens` from the token API's paginated
  `/api/queryTokenList` flow to Router's `/supportedTokenList?chainId=<id>`.
  The response must contain exactly one matching chain group and a token array;
  malformed or wrong-chain token rows remain fail-closed and are dropped.
- Reuse validated `/supportedTokenList` decimals for later quotes. Canonical-equal
  rows with conflicting decimals now fail closed instead of depending on response
  order.

### Security / correctness
- Compare token identifiers in their source or destination chain's format space.
  Tron Base58Check, `41`-hex, and Butter `0x` forms now resolve to one account;
  Solana mints remain case-sensitive, while `sol`/`So111…`, `trx`/`T9yD…`, and
  `btc`/zero-address resolve as chain-scoped native aliases.
- Recognize Butter's canonical Solana and Tron native addresses during fee
  enforcement, so a zero USD estimate cannot route a real native gas fee through
  the cross-token valuation path and bypass `maxNetworkFeeBps`.
- Bound every Butter HTTP request, including response-body parsing, with the new
  `requestTimeoutMs` setting (default 10 seconds). Timeouts abort and surface as
  typed `ButterApiError`s; requests are not retried automatically.
- Change the default ERC-20 approval confirmation deadline from 60 seconds to 10
  seconds. Both public-client waits and fallback receipt lookups are bounded by
  the same deadline; `evm.approvalTimeoutMs` remains configurable and accepts `0`
  for an immediate timeout.
- Validate route token identifiers and required output amounts before quoting,
  normalize blank recipients as absent, validate string-form source decimals,
  and type malformed discovery envelopes while dropping malformed individual rows.
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
  route quoted a non-zero referrer fee, and — for a non-empty `feeData` — fail
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
  wait defaults to 10s), and the swap send. A route with a second left could pass
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
- Validate the **address** of a `/findToken` result, not only its chain. Butter
  matches by address and ignores the `chainId` parameter, and an earlier revision took
  that as licence to check the chain alone — treating a description of Butter's
  behaviour as a property of the response. A same-chain entry for a *different* token
  could therefore supply the decimals, and those decimals become
  `FeeContext.sourceTokenDecimals`: the value a source-denominated fee is parsed with
  while the denominator is the caller's real base units. A `decimals: 0` answer for the
  wrong token understated a 10% fee to 0.001% and passed a 1% cap — the bypass
  `trustedSourceDecimals` exists to close, reached through `/findToken` instead. Entries
  are now matched on chain **and** address, format-aware so a Base58 mint stays
  case-sensitive.
- Harden `/findToken` parsing and cache only valid, useful outcomes. Matching decimals
  must be an integer from 0 through 255 (base-10 digit strings are accepted), and the
  `decimals` / `decimal` aliases and duplicate matching records must agree; malformed or
  conflicting metadata now raises a typed `ButterApiError` and is never cached. Malformed
  unrelated array entries are
  ignored, while a malformed top-level payload is rejected. An affirmative not-found is
  cached for 300 seconds before retrying, a response that simply lacks the requested
  token remains inconclusive and uncached, and the whole decimals cache is now a
  256-entry LRU so a long-lived process cannot grow it without bound.
- Normalize **transaction hashes in their own format space**, separate from token
  identifiers. Bitcoin and Tron txids are bare 64-character hex with no `0x` prefix,
  and hex is case-insensitive, so the token-identifier rule rejected a BTC txid that
  differed only in case (`sourceHash does not match requested id`) and filed two
  casings of one txid under two operation keys. Length 64 is what keeps Base58 out —
  a Solana signature is 87–88 characters — so signatures stay compared exactly.
- Index configured `tokenDecimals` under the **same key function the lookup uses**.
  Only the query was ever normalized, so a checksummed configuration key was
  unreachable from the equivalent lowercase request and configured decimals were
  reported missing — a defect that predates the identifier work and was masked
  whenever `/findToken` resolved the token anyway. Entries that normalize together
  but disagree now raise `ButterConfigurationError` at construction, since otherwise
  object key order would decide which decimals apply. Note `tokenDecimals` does not
  apply to native tokens; use `nativeTokenDecimals`.
- Compare on-chain identifiers **format-aware** instead of lowercasing everything.
  Case-insensitivity is a property of EVM hex — EIP-55 casing is a checksum over an
  address — not of identifiers in general: Solana mints and signatures, Tron and TON
  addresses are Base58, where a character's case is part of the encoded value, so
  `AbCd…` and `abcd…` are different public keys. A blanket `toLowerCase()` merged them
  in four places at once. A bridge fee charged in one mint was accepted as the caller's
  source token because the two differed only in case, which gave it the caller's own
  input as a fee denominator and let it pass a bps cap. A `/route` response could
  satisfy the token-intent check with a differently cased token. Two distinct mints
  collapsed into a single discovery entry and shared a decimals cache slot, so one
  mint's decimals could be served for the other. And two Solana signatures were
  treated as the same operation, reporting one transaction's status for another and
  returning a hash the caller never asked about. All such comparisons and map keys now
  go through the new `identifiers.ts`, which normalizes only confirmed `0x`-hex.
  Symbols, chain ids, chain names and status strings remain case-insensitive, and the
  EVM-only calldata and router-registry paths are unchanged.
- Recognize a source-token bridge fee by one rule: **a symbol can only ever confirm a
  symbolic identifier.** A declared address decides alone, and the symbol is consulted
  only when the component names no address *and* the source token is itself symbolic
  (`native`/`btc`/`ton`/`trx`/`sol`). An ungated symbol fallback let any component
  claim the caller's own amount as its denominator simply by naming the source
  token's address in its `symbol` field — on EVM, where `sourceToken` *is* an address,
  that needs no address of its own at all. Such a component is now unidentifiable and
  refused. The rule has failed in three directions across three reviews, so the full
  matrix of source-identifier kind against component shape is now pinned by a
  table-driven test rather than a case per round. Both earlier halves were bypasses
  too. Requiring an address outright meant a genuine
  `{ symbol: 'BTC', decimals: 8 }` component — the normal shape on a non-EVM source,
  where `sourceToken` is `'btc'` — was valued against `route.srcChain.totalAmountIn`,
  so a route inflating its reported input 100× turned a 1000 bps fee into 10 and
  passed a 10 bps cap. Letting a symbol override a declared address is the reverse:
  `{ address: '0x…ee', symbol: 'BTC' }` was treated as the caller's BTC and divided by
  their input, which is a cross-currency division that understates without limit as
  that token's own leg shrinks — a 10000 bps fee passing a 100 bps cap. A trusted
  denominator is not automatically a meaningful one. Matching a component to a route
  *leg* separately requires an address on both sides, since a symbol is not an
  identifier and can select an amount in another currency.
- Stop treating the bridge fee summary as evidence that a fee was reported. Having
  removed it from *pricing* as untrusted, it was still the only thing attesting a fee
  existed — so a cross-chain route reporting `bridgeFee: { amount: "0" }` and no
  components satisfied even `maxProtocolFeeBps: 0`, a cheaper forgery than inventing
  a small summary. A figure too untrusted to price is equally unfit to certify a zero:
  the cross-chain check now counts only `in`/`out`/`affiliate` amounts. An explicit
  component `"0"` is still a real answer and passes.
- Validate the token list's pagination envelope. `count` is the termination bound, so
  a negative one satisfied `consumed >= count` after the very first page: the walk
  stopped with a partial list, requested nothing further, and raised nothing. It must
  now be a non-negative safe integer, and `results` must be an array — a non-array
  previously surfaced as a raw `TypeError` from `for...of` instead of a typed error.
- Answer the two pagination questions with two mechanisms. `count` counts raw rows, so
  `consumed` advances by page size — briefly counting distinct records instead made a
  page containing an in-page duplicate fall short of `count` and abort an otherwise
  legitimate response. Whether the server is really paginating is a separate test: a
  record already returned on an *earlier* page is now an error, since the walk is
  looping or the list shifted and `consumed` would reach `count` with the tail never
  fetched (with `count = 4` and pages `[A,B]` then `[B,C]`, D was never requested).
  Repeats within one page are fine; repeats across pages are not.
- Parse a source-denominated fee with the **resolved** source token decimals, not the
  route's, **in quoting as well as cap enforcement**. The first fix covered only the
  cap, so an ordinary quote with no cap configured still under-reported by a power of
  ten — and a quote is where that does its damage silently, since a caller only has to
  read the number and act on it. The denominator is the caller's real base units, so the numerator's scale
  matters as much as its magnitude: `route.ts` verifies the source token's address but
  never its decimals, so a response claiming `decimals: 0` shrank a 10 USDC fee from
  `10000000n` to `10n` — a 1000 bps charge measured as 0.001 bps, under any cap. The
  decimals this package resolves when building the request are now carried through
  (`CachedRoute.sourceDecimals` → `FeeContext.sourceTokenDecimals`), and a route whose
  declared decimals disagree is refused. Cross-denominated bridge components keep
  their own decimals, where numerator and denominator are both route-reported in the
  same token and the scale cancels.
- Never price the top-level `bridgeFee.amount`. It is one figure in one token for a
  fee that can span three, so it is unattributable — and forgeable: omit the real
  components, report a small summary that happens to match a route token, and any bps
  cap is satisfied by a number the response invented. Reconstructing a component from
  `amount - affiliate`, which the previous release did, was the same trust mistake
  wearing arithmetic; comparing the summary against the components' *sum* is no better,
  since amounts in different tokens are not addable. The summary is now only a
  detector: a route reporting one with no `in`/`out`/`affiliate` has the fee omitted
  from `fees[]` with a `bridge-fee-components-missing` warning, and a configured
  protocol cap refuses.
- Emit `bridge-fee-components-missing` whenever a bridge fee summary arrives with no
  components, including a `"0"` one. Gating the warning on a non-zero summary silently
  narrowed the contract that `ButterWarning` and the README both state. Refusal is
  separate and still requires a non-zero summary: a zero one charges nothing, so a
  same-chain route sending `{ amount: '0' }` is not blocked over it, while cross-chain
  is covered either way by the requirement for a real component.
- Include `affiliate.amount` when testing whether a cross-chain route reports a bridge
  fee at all. An affiliate-only bridge fee is a legitimate response and was being
  rejected as if the route had reported nothing.
- Count the **affiliate share** against `maxProtocolFeeBps`, and stop double-charging
  it. Live responses show the bridge fee summary is `in + out + affiliate` (observed:
  `0 + 0.139954 + 0.23 = 0.369954`), so the affiliate sits *inside* the summary. The
  cap previously counted neither the affiliate nor anything derived from it — in that
  observed route the affiliate was 62% of the bridge fee — and the summary fallback
  emitted the affiliate portion a second time as a protocol fee. `fees[]` keeps WDK's
  `affiliate` type for the share; only the cap aggregates it, because WDK has no
  affiliate cap and an unset `affiliate` config means Butter takes the cut with its
  own wallet. The summary is now used only when no component is present and only
  after subtracting the affiliate; when that subtraction is impossible the fee is
  omitted with a `bridge-fee-components-missing` warning and a configured cap
  refuses.
- Choose a bridge fee component's denominator by its **leg**. `in` and `out` are
  usually the same token, so one shared candidate order matched the inbound amount
  for both, understating the outbound fee wherever `totalAmountIn > totalAmountOut`.
- Resolve the bridge fee summary's token by an actual match rather than falling back
  to any route token. `bridgeFeeToken` omitted `srcChain.tokenIn`, so a fee charged
  in the source token matched nothing and was parsed with an unrelated token's
  decimals — scaling a 3 USDC fee to `3e18`. The candidate is added, and a summary
  whose declared token still matches nothing now fails closed instead of being
  mis-scaled.
- Treat `swapFee` as Butter's authoritative actual fee result. It already includes
  the charge configured by `feeConfig`, so fee mapping and `maxProtocolFeeBps` now
  ignore `feeConfig` instead of deriving a second amount or choosing the larger
  value. A non-empty Router `feeData` still requires a complete, supported, exactly
  matching `feeConfig` tuple; malformed or unsupported values fail with a typed
  transaction validation error before send. Empty `feeData` remains valid when
  `rateOrNativeFee` is zero, and unused tuple fields are not validated on that path.
- Price `bridgeFee` per **component**. Butter reports it as `in` and `out` parts,
  each with its own amount and token, plus a top-level summary; this package read
  only the summary and *guessed* its token from five candidates. `in` and `out` now
  become separate `protocol` entries with their own tokens, and the summary is used
  only when neither part exists. Butter's documentation does not say whether the
  summary is their sum or a restatement of `out` — preferring the components is
  correct under either reading and never reports less. Each component is also valued
  against a route amount **in its own token**, or fails closed; the previous
  candidate list could divide a fee by an amount in a different currency.
- Value a **source-token bridge fee** against the caller's own input rather than a
  route-reported amount. `bridgeFeeRatio` chose its denominator from three
  route-supplied candidates, the last being `srcChain.totalAmountIn` — the exact
  value `sourceDenominator` exists to avoid. A bridge fee charged in the source
  token could therefore be pushed under `maxProtocolFeeBps` by inflating the
  route's self-reported input (10 USDC of fee on a real 100 USDC input reports as
  10 bps instead of 1000 if the route claims 10000 in). Route amounts are still
  used for genuinely cross-denominated fees, where no caller-supplied amount
  exists to divide by.
- Distinguish **absent** fee metadata from an explicit zero when a cap is
  configured. A missing `gasFee.amount` (network cap) or a missing
  `bridgeFee.amount` on a cross-chain route (protocol cap) now raises
  `ButterFeeValuationError`; previously both scored as zero, so omitting the field
  was enough to pass any limit. An explicit `'0'` is a real answer and still passes.
- Require an explicit `recipient` when the destination chain's address family is
  **unrecognized**, not only when it differs from the source's. An unlisted chain
  used to be assumed EVM; since Butter adds chains without this package being
  republished, that silently reused a `0x` sender as the receiver on a newly added
  non-EVM chain. Two unknown families no longer count as matching. The new
  `evmChainIds` config accepts a not-yet-listed EVM chain without patching the
  built-in table.
- Truncate sub-basis-point slippage **down** instead of up. WDK defines `slippage`
  as the maximum acceptable, so rounding `0.00505` up to 51 bps authorized more
  slippage than the caller stated. A positive value that floors to 0 bps is now
  rejected rather than silently widened to 1 bp.
- Fix the placeholder fee's token: a `network` (gas) entry was labelled with the
  **input** token for any non-native source, because `nativeTokenId(context) ??
  context.sourceToken` collapses to `context.sourceToken` in both branches. It now
  reports `'native'`.
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
- `swidge` requires an explicit `recipient` for a destination chain whose address
  family is unrecognized, in addition to one that differs from the source's. See
  the Security section; `evmChainIds` is the escape hatch.
- Sub-basis-point `slippage` now truncates down, and a positive value below 1 bp
  throws `ButterUnsupportedError` instead of being widened to 1 bp.
- Fee caps fail closed on absent (as opposed to explicitly zero) fee metadata,
  including incomplete `route.swapFee` amounts under `maxProtocolFeeBps`.
- A route reporting only a top-level `bridgeFee.amount`, with no `in`/`out`/`affiliate`
  component, now has that fee omitted from `fees[]` and cannot be executed under a
  configured `maxProtocolFeeBps` — including when that summary is `"0"`, since the
  summary cannot certify a zero any more than it can be priced. State a zero through a
  component instead.
- `tokenDecimals` entries that normalize to the same key with different values now
  throw `ButterConfigurationError` at construction instead of one silently winning.
- Non-EVM identifiers are now compared exactly. If Butter returns the same Solana
  mint with inconsistent casing across endpoints, what previously matched by accident
  will now fail closed — correct per Base58 semantics, but it surfaces as a new error
  on Solana routes rather than silently. `npm run example:discover` shows the live
  casing.
- A cross-denominated bridge fee component that names no token address is refused
  under a configured `maxProtocolFeeBps`: its currency cannot be confirmed, and a
  symbol is not enough to choose which route amount to measure it against. A
  component in the source token is unaffected — it is matched by symbol too.
- `fees[]` reports `bridgeFee.in`, `bridgeFee.out` and `bridgeFee.affiliate` as
  separate entries instead of one summary entry, so the array can be **longer** than
  before for a cross-chain route and each entry names its own token.
- `maxProtocolFeeBps` now includes the affiliate share, so a route that previously
  passed can be rejected. Raise the cap, or set `affiliate` deliberately, if this
  fires on routes you consider acceptable.
- `ButterSwidgeQuote` gains a required `destinationGuarantees` field
  (`'enforced' | 'quoted-only'`). Code that only reads quotes is unaffected; code
  that *constructs* the type must now supply it.
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
  and `config.evmChainIds`.
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
- Nothing depends on how `bridgeFee.amount` relates to its components any more — the
  summary is never priced — but `npm run example:probe-fee-model` still reports the
  decomposition, including whether the components ever span multiple tokens, which is
  the case that makes any summary arithmetic meaningless.
- Exact-out remains unsupported pending a live contract confirmation from Butter:
  the default production `/route` rejects `type=exactOut` with `errno 2000`, and the
  docs describe `amount` only as "amount of source token" with no exactOut variant,
  leaving the denomination unspecified. `npm run example:probe-exact-out` re-checks
  both (read-only, `exactIn` as a control). The execution-side machinery
  (`maxAmountIn`, `assertSourceAmountIn`, the `min(cap, reported)` fee denominator)
  is retained and unit-tested so re-enabling is small.
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
