# @butternetwork/wdk-protocol-swidge-butter

Butter Network Swidge provider for WDK.

This package adapts WDK's Swidge interface to Butter Smart Router's `/route`,
`/swap`, `/supportedChainInfo`, token-discovery, and Butter swap-data APIs.

See [CHANGELOG.md](./CHANGELOG.md) for release notes, breaking changes, and known
upstream issues, and [Known limitations](#known-limitations) for what this provider
does not do.

## Install

```sh
npm install @butternetwork/wdk-protocol-swidge-butter @tetherto/wdk-wallet
```

## Usage

```ts
import ButterSwidgeProtocol, {
  toEvmWalletClient,
  toEvmPublicClient
} from '@butternetwork/wdk-protocol-swidge-butter'

// EVM execution needs BOTH a full WDK account and an EVM-capable sender.
const protocol = new ButterSwidgeProtocol(account, {
  sourceChainId: 56,
  entrance: 'wdk',
  requestTimeoutMs: 10_000, // complete Butter HTTP request, including body parsing
  apiKeyId: process.env.BUTTER_API_KEY_ID,
  apiSecret: process.env.BUTTER_API_SECRET,
  maxNativeFee: 20000000000000000n, // required for cross-chain (see Safety Defaults)
  evm: {
    walletClient: toEvmWalletClient(viemWalletClient),
    publicClient: toEvmPublicClient(viemPublicClient), // enables allowance checks + status
    approvalTimeoutMs: 10_000
  }
})
```

EVM execution requires **both**:

1. a **full (send-capable) WDK account** — the WDK `swidge()` contract throws
   without one, so a read-only or absent account is rejected; and
2. an **EVM-capable sender** — `evm.walletClient` — to carry the swap/approval
   calldata (`data`/`chainId`). The WDK account alone cannot, because the WDK
   `Transaction` type only guarantees `{ to, value }`, so calldata could be
   silently dropped. The wallet client carries a bound `account.address` that is
   validated against the WDK account, so the signer, calldata initiator, and
   allowance owner can never split. (This dual requirement collapses to one if WDK
   extends `Transaction` with `data`.)

The account resolves the sender address and (optionally) confirms approval
receipts via `getTransactionReceipt`; it is never used to submit EVM calldata.
Wrap a viem wallet client with the exported `toEvmWalletClient` adapter (a raw
viem client is not structurally assignable). An optional `evm.publicClient`
enables ERC20 allowance checks (without one, an approval is always submitted and
confirmed through a receipt lookup). When **every** send reports the gas fee it
paid, the executed `SwidgeResult` reports that measured source gas; otherwise it
keeps the route estimate.

Only exact-in quotes are supported. Pass `fromTokenAmount` as a positive
`bigint` in base units. This module deliberately rejects exact-out
(`toTokenAmount`) before any network request: Butter's exact-out routing is not
uniformly available across chains, so the option fails fast with
`ButterExactOutUnsupportedError`. This also applies to the WDK base-class
`swap()` delegation when it forwards a `tokenOutAmount`.

`apiSecret` must not be bundled into browser or mobile clients. For public
clients, use a backend proxy. Authentication defaults to `optional`; anonymous
requests are subject to Butter's unauthenticated rate limits. Set
`authMode: 'required'` for production integrations that must never fall back to
anonymous requests.

### Affiliate and referrer

Two optional construction-time settings are forwarded to Butter `/route`:

| Config | Format | Notes |
| --- | --- | --- |
| `affiliate` | `<nickname>` or `<nickname>:<rate>` | The affiliate collecting the integrator's share. Validated at construction. |
| `referrer` | free-form string | **Mandatory for Solana same-chain routes**; optional on EVM. |

**Leaving `affiliate` unset does not make the swap cheaper.** Butter substitutes
its own default affiliate wallet whenever the parameter is absent, so the share
is charged to the user either way — omitting it only forgoes *your* cut of a fee
the user already pays. Set it to collect that share, and know that it is being
collected regardless.

It is validated at construction rather than on the first request for the same
reason: because Butter silently falls back to its own wallet, a malformed value
would otherwise produce a perfectly successful swap with the share quietly going
elsewhere, and nothing to notice.

A Solana **same-chain** route without `referrer` throws `ButterConfigurationError`
before any request is sent — Butter documents the parameter as mandatory there, so
the request could never be valid.

Both participate in the route cache key, so a route quoted under one affiliate is
never reused after it changes. When unset, neither appears in the outgoing query
nor in the cache key.

### Exact-in only

Pass `fromTokenAmount`. Exact-out (`toTokenAmount`) is rejected before any network
request with `ButterExactOutUnsupportedError`, on both `quoteSwidge`/`swidge` and the
legacy `quoteSwap`/`swap` delegation path.

Butter's `/route` documents `type: exactOut` as a valid value, but two things stop
this package from offering it:

- The default production endpoint has been observed rejecting `type=exactOut` with
  `errno 2000` ("Parameter error") while the identical `exactIn` request succeeds.
- The `/route` documentation describes `amount` only as *"amount of source token"*,
  with no variant for exactOut — so even against a working endpoint, which side the
  amount denominates is unspecified, and guessing would misprice the trade.

`npm run example:probe-exact-out` re-checks both against the live API (read-only, no
funded account, `exactIn` used as a control). If it reports exactOut accepted and
settles the denomination, re-enabling is a small change: the execution-side
machinery — the source-amount upper bound, and the `min(cap, route-reported input)`
fee denominator that keeps an inflated route from understating a fee ratio — is
retained and unit-tested.

## Behavior

- `quoteSwidge(options)` calls Butter `/route`, stores a non-binding quote as an
  optional execution cache, and returns it with a `routeHash` you can pin.
- `swidge(options, config?)` can be called directly. By default it reuses a
  matching fresh cached route or obtains a new one, enforces fee limits, calls
  `/swap`, validates the returned transaction intent, performs EVM approval when
  required, then sends the source transaction.
- Route freshness is stricter on execution than on quoting. A cached route is
  reused for a **quote** while ≥15s of its 5-minute lifetime remain, but
  **execution** requires ≥`routeExecutionMarginSeconds` (default **45s**): it
  still has to complete the `/swap` round-trip, an optional ERC20 approval, and
  the swap send before the quoted price has to hold on-chain. Inside the margin,
  unpinned execution transparently re-quotes. The default deliberately does not
  assume an approval — when approvals are expected, raise
  `routeExecutionMarginSeconds` above `evm.approvalTimeoutMs / 1000` (which
  defaults to 10s). These two values are coupled; the
  margin is configurable rather than hardcoded so the coupling stays explicit.
- Butter HTTP calls have a complete-request deadline: `requestTimeoutMs`
  defaults to **10,000ms** and covers the fetch plus error-body or JSON-body
  parsing. Timed-out requests abort and throw `ButterApiError`; they are not
  retried automatically. ERC20 approval confirmation independently defaults to
  **10,000ms** via `evm.approvalTimeoutMs` (`0` means immediate timeout).
- Pinning a quote: pass `options.routeHash` (from a prior `quoteSwidge` result)
  to `swidge` to execute that exact quoted route. `swidge` accepts
  `ButterSwidgeOptions` (`SwidgeOptions & { routeHash? }`), so the field is part
  of the public typed API. If the route has expired, expires within the execution
  margin, or no longer matches the options, `swidge` throws
  `ButterActionRequiredError` instead of silently re-quoting at a different
  price — a pin is the price you approved, so it is never re-fetched the way an
  unpinned execution is. Pins are held in the instance's in-memory
  route cache, so quote and execution must use the same protocol instance.
  Without `routeHash`, execution auto-re-quotes as before.
- Exact-in only; see [Exact-in only](#exact-in-only) for why exact-out is rejected.
- `getSwidgeStatus(id)` calls
  `/api/queryBridgeInfoBySourceHash`; `{ byOrderId: true }` calls
  `/api/queryCrossInfoByOrderId`. The options type is exported as
  `ButterSwidgeStatusOptions`. Note this package never produces an order ID —
  `SwidgeResult.id` is always the source-chain hash — so `byOrderId` is for callers
  who obtained one from Butter separately. Same-chain swaps produce no cross-chain record,
  so their status is derived from the transaction receipt — but only after the
  source transaction is **attributed to a Butter Router**. If this instance
  executed the id (recorded at `swidge` time) it is trusted; otherwise the source
  tx is fetched via `evm.publicClient.getTransaction` and must target an
  allowlisted Router **and** be `swapAndCall` (`swapAndBridge` ⇒ cross-chain).
  This attribution holds even with explicit `{ fromChain, toChain }` hints — hints
  never bypass it — so an unrelated transaction is never reported as a completed
  swidge (an unverifiable same-chain id throws). It also works across process
  restarts / new instances. Without a resolvable attribution it defaults to the
  cross-chain API (which never falsely reports completion). Transaction and
  receipt lookups treat only viem's `TransactionNotFoundError` /
  `TransactionReceiptNotFoundError` as absence; infrastructure faults (RPC
  timeout, auth, rate-limit) propagate to the caller rather than being masked as
  "not found" (which would force a false `pending` or a silent cross-API
  fallback). Receipt-derived status
  requires an `evm.publicClient` with `getTransactionReceipt` or an account that
  exposes `getTransactionReceipt`, and is fail-closed (only an explicit success is
  `completed`; an unknown receipt status stays `pending`).
- `getSwidgeStatus` maps Butter cross states `0 → pending` (crossing),
  `1 → completed`, and `6 → refunded`. There is no numeric `failed` state.
  Any undocumented or intermediate code (e.g. a relaying state) maps
  conservatively to `pending` rather than a terminal status, so an in-flight
  transfer is never misreported as failed. A response with no swidge info or
  no state still throws (the id is invalid/unknown).
- `getSupportedChains()` merges Router-supported chains with token API
  metadata. Each entry carries an extra `execution` field describing how this
  instance would execute on that chain: `native` (built-in EVM), `adapter`
  (configured `transactionAdapters`), or `quote-only`. A chain whose merged
  metadata is missing an `id`, `type`, or `nativeToken` symbol is **dropped**
  rather than listed with a placeholder — the same fail-closed rule
  `getSupportedTokens` applies to a token with unusable decimals. Quoting and
  execution are unaffected: they take chain ids from the caller, not from this
  listing, and a dropped chain keeps any strict slippage floor it qualifies
  for. Run `npm run example:discover` to see which chains this costs you on
  live data (the output reports the dropped ids and their missing fields).
- `getSupportedTokens(options)` resolves the chain `key` from
  `/api/queryChainList` and paginates `/api/queryTokenList`. Chain selection
  uses `fromChain`, then `toChain`, then the instance's source chain;
  route-scoped `fromToken` filtering is not available from Butter's token API.
- Token decimals resolve from `tokenDecimals` config first, then automatically
  through Butter's `/findToken` API (cached per token). Configure
  `tokenDecimals` only for tokens Butter cannot resolve.

## Status & fee mapping

`getSwidgeStatus` maps Butter's state to WDK's `SwidgeStatus`:

| Source | Value | `SwidgeStatus` |
| --- | --- | --- |
| Cross-chain `state` | `0` crossing | `pending` |
| Cross-chain `state` | `1` completed | `completed` |
| Cross-chain `state` | `6` refund | `refunded` |
| Cross-chain `state` | any other / intermediate | `pending` (never a false terminal) |
| Same-chain receipt | explicit success | `completed` |
| Same-chain receipt | explicit revert | `failed` |
| Same-chain receipt | missing / unknown | `pending` |

`quoteSwidge`/`swidge` map Butter route fees into WDK `SwidgeFee[]`. The last column
is where each entry lands in the legacy `swap()`/`bridge()` scalars:

| Butter field | `SwidgeFee.type` | Legacy field | Notes |
| --- | --- | --- | --- |
| `bridgeFee.in` | `protocol` | `bridgeFee` | inbound leg of the bridge fee, in **its own** token |
| `bridgeFee.out` | `protocol` | `bridgeFee` | outbound leg of the bridge fee, in **its own** token |
| `bridgeFee.affiliate` | `affiliate` | *(not visible)* | integrator/affiliate share — **counted against `maxProtocolFeeBps`** |
| `bridgeFee.amount` | — | — | never priced; used only to detect that a fee exists which no component describes |
| `gasFee` | `network` | `fee` | source-chain gas; estimate, replaced by measured gas when the sender reports every send's fee |
| `swapFee.nativeFee` | `protocol` | `bridgeFee` | native-denominated swap fee |
| `swapFee.tokenFee` | `protocol` | `bridgeFee` | input-token-denominated swap fee |
| `feeConfig` | `protocol` | `bridgeFee` | the integrator fee, added **only** when `swapFee` does not already report it; a proportional rate needs `fromTokenAmount` to be shown as an amount |

`bridgeFee` is reported per component, and the top-level `bridgeFee.amount` summary is
**never priced**. It is a single figure in a single token describing a fee that can
span three tokens, so it is not attributable — and amounts in different tokens cannot
be added, which rules out reconstructing a component from it or even checking it
against the components' sum. When a route reports a summary but no `in`, `out` or
`affiliate`, the fee is omitted from `fees[]` with a `bridge-fee-components-missing`
warning and a configured protocol cap refuses outright, rather than measuring a number
it cannot attribute. `npm run example:probe-fee-model` shows how a live route
decomposes.

**The affiliate share counts against `maxProtocolFeeBps`**, even though `fees[]`
keeps WDK's `affiliate` type for it. This is a deliberate deviation: WDK has no
affiliate cap, and leaving the share unbounded bites hardest when you do *not* set
`affiliate` — Butter then substitutes its own wallet, so your users pay a cut you
never chose. `maxProtocolFeeBps` is the only knob available to bound it.

`feeConfig` is the integrator fee as it will actually be encoded in the Router
calldata, and it is what `maxProtocolFeeBps` is checked against — `swapFee` merely
reports it. Where both describe the same fee the larger is used, never the sum. When
`feeConfig` charges a fee that `swapFee` does not report, `onWarning` fires with
`undeclared-integrator-fee` and the fee is added to `fees[]`: a fixed native fee
directly, and a proportional rate as `fromTokenAmount × rate / 10000` — so it appears
only when you supplied an input amount, since a rate on its own is not an amount.

`fees[]` is always populated: if Butter reports no fees at all, it carries a single
zero-amount `network` entry rather than being empty (an empty array reads as "free").

**Read `fees[]`, not the legacy scalars.** The `protocol` group can hold three
different denominations at once — bridge token, native, and input token — so the
legacy `bridgeFee` total adds unlike currencies together. `bridge()`/`quoteBridge()`
at least group by type (`fee` ← `network`, `bridgeFee` ← `protocol`);
`swap()`/`quoteSwap()` do **not** group at all and sum every entry regardless of
type or currency. Both behaviours live in the WDK base class, which providers must
not override, so this needs a WDK-side fix. Set `onWarning` to be told when it
applies to a given route:

```js
const protocol = new ButterSwidgeProtocol(account, {
  sourceChainId: 56,
  entrance: 'wdk',
  onWarning: ({ code, message, details }) => console.warn(code, message, details)
})
// -> 'mixed-currency-protocol-fees' when the protocol group spans several tokens
// -> 'no-fees-reported'              when Butter reported none and fees[] is a placeholder
// -> 'undeclared-integrator-fee'     when feeConfig charges a fee swapFee omits
// -> 'bridge-fee-components-missing' when a bridge fee summary cannot be split
//                                    from its affiliate share
```

## Safety Defaults

- `sourceChainId` and `entrance` are required.
- Exact-out, zero inputs, unsafe JavaScript numbers, and amount conversions that
  would discard decimal precision are rejected.
- Explicit cross-chain slippage below Butter's documented floor is rejected.
  Defaults use the applicable minimum. BTC and TON routes use the stricter 300
  bps floor; additional IDs can be configured with `strictSlippageChainIds`.
- `minAmountOut` is compared locally with the minimum returned by `/route`
  because Butter's documented API does not expose a separate request parameter.
  For cross-chain execution this remains a quote check, not calldata enforcement:
  the destination minimum is inside the nested bridge payload trusted to Butter.
- `refundAddress` is optional, and when you name one it is **verified rather
  than assumed**. Omit it to accept Butter's own default refund destination,
  trusted like the rest of the destination routing. Naming one asks for a
  guarantee, so it is checked against the address the calldata actually encodes:
  the nested bridge payload's `refundAddress` cross-chain, or `swapAndCall`'s
  leftover receiver same-chain. If that payload cannot be decoded, the guarantee
  cannot be checked, so execution is rejected instead of proceeding as if it
  held — drop `refundAddress` to continue with Butter's default. It no longer has
  to equal the source sender: on a cross-VM route the source address is not even
  spendable on the destination chain.
- The built-in EVM path executes **exactly one** Router transaction. A `/swap`
  response with more than one transaction is rejected, so repeated
  individually-valid Router calls cannot multiply native/ERC20 spend.
- EVM Router V3 calldata is validated at a deliberate middle tier. Always
  enforced: the target must be an allowlisted router (and match the route's
  `contract`); the top-level intent — initiator, source token, source amount,
  and empty permit data — must match the request; the integrator `feeData` must
  match the route's quoted `feeConfig` as a full `(feeType, referrer,
  rateOrNativeFee)` tuple — empty `feeData` is rejected when the route quoted a
  non-zero fee, and a non-empty `feeData` requires the quoted tuple to be
  complete (fail closed on any missing field) and to match exactly, so `/swap`
  cannot inject an unchecked `feeType`/`referrer` by under-specifying the quote;
  and the transaction value must satisfy the native-spend bounds below.
  Same-chain `swapAndCall` additionally verifies the destination token,
  recipient, leftover receiver, and minimum output.
- Native-spend bounds: `tx.value` is checked as two *one-sided* bounds rather
  than an exact `input + routerFee + bridgeFee` equality. `/route` formats the
  router fee as a decimal string while `/swap` returns `tx.value` as a hex
  integer, so exact equality would reject a perfectly good transaction over a
  sub-wei artifact in that round-trip.
  - The native **input** half is a hard **lower** bound: a value below the
    quoted native input is rejected as under-funded.
  - The remaining **fee** half is bounded only from **above**. Paying less than
    quoted cannot harm you — the router reverts if the fee is genuinely
    insufficient — so there is no lower bound and no two-sided tolerance.
  - The fee half's upper bounds are `maxNativeFee` (the security boundary) and
    the quoted `routerFee + bridgeFee` plus a 0.5 % formatting-drift tolerance
    (a consistency sanity check that catches a `/swap` charging materially more
    native than `/route` advertised).
  The bridge messaging fee inside `tx.value` comes from the `/swap` calldata and
  is **trusted** — it is not bounded by the quote — so `maxNativeFee` (an
  absolute cap on the whole fee half, in native base units) is the actual
  native-drain guard. When set, it is enforced on any chain (same-chain carries
  only the router fee). **Cross-chain execution fails closed without it**
  whenever the destination chain differs from the source chain — including when
  the calldata reports a zero bridge fee, so a route cannot opt out of the cap
  by under-reporting what `tx.value` spends. Same-chain swaps do not require it.

  `maxNativeFee` can also be passed **per call** on `swidge(options)`, where it
  takes precedence over the configured value (in both directions — a per-call cap
  may loosen or tighten it, and `0n` means "no native fee at all"). Prefer the
  per-call form when one long-lived instance serves a wide range of trade sizes:
  a single absolute cap is either too tight for small routes or nominal for large
  ones, and the caller knows the size at call time. Setting it per call also
  satisfies the cross-chain fail-closed requirement.
- Cross-VM destinations require an **explicit `recipient`** on `swidge`. WDK
  defaults the recipient to the account address, which is only meaningful while
  the destination chain uses the same address format; bridging EVM→Solana/BTC/TON
  without one would otherwise forward a `0x` address as the destination receiver.
  Address families are resolved from a best-effort table of Butter's non-EVM chain
  ids (`constants.ts: NON_EVM_CHAIN_FAMILIES`) — unlisted chains are treated as
  EVM, so **the table must be extended when Butter adds a non-EVM chain**. The
  requirement applies only to `swidge`: `quoteSwidge` still prices a cross-VM route
  without a recipient, since asking a price before choosing a destination address
  is the normal flow.
- Cross-chain destination routing — the destination **recipient, output token,
  and minimum output** encoded in the nested bridge payload — is **trusted to
  Butter's `/swap` response and is NOT verified**. This is an accepted
  middle-tier trust boundary, not full calldata intent validation: a compromised
  or buggy `/swap` could route the destination output elsewhere. Only the bridge
  target (destination chain) is checked. Source-token exposure remains bounded
  because the module approves only the exact input amount to the router. Setting
  `minAmountOut` rejects an inadequate route, but does not upgrade this
  cross-chain destination guarantee beyond `quoted-only`.
- ERC20 approval only occurs after calldata validation and only targets a
  configured Butter router for the source chain. The approval is **always for the
  exact input amount** — there is no unbounded/`max` approval option — so a
  compromised router can never move more than this swap's input.
- `maxNetworkFeeBps` and `maxProtocolFeeBps` are enforced only in `swidge`,
  before `/swap`, approvals, or transaction submission. `quoteSwidge` never
  throws on a cap — a quote is a non-binding estimate and always returns the
  full fee breakdown for inspection. Per-call values override constructor
  defaults. Cross-token fees require route-provided USD or same-stage valuation
  metadata when a cap is enabled; unvaluable fees fail closed with
  `ButterFeeValuationError`.
- Quotes and discovery do not require a signer or local transaction adapter.
  Execution without a send-capable account or configured signer fails before a
  route request.
- Tron, Solana, BTC, and TON require explicit `transactionAdapters`; Tron is not
  treated as viem-compatible EVM execution. Adapter execution bypasses the
  Router V3 calldata validation performed on the built-in EVM path — only chain
  ID and required transaction fields are checked, so adapters carry their own
  trust responsibility for the provider-supplied transaction data. Adapter
  output is still fully classified **before anything is broadcast**: each
  declared `type` must be a legal `SwidgeTransaction` role, a multi-transaction
  result must classify every entry (`{ transaction, type }`), and the set must
  resolve to exactly one `source` — any violation throws with nothing sent, so a
  failed classification cannot leave a partially-broadcast operation a retry
  could double-execute.
- EVM transaction submission requires **both** a full (send-capable) WDK account
  (per the WDK `swidge()` contract) **and** `evm.walletClient` (which carries the
  swap calldata, with a bound `account.address` validated against the WDK account);
  the WDK account cannot submit EVM calldata because its `Transaction` type is only
  `{ to, value }`. The account is used for the sender address and approval
  receipts. ERC20 approval is always the exact input amount — an oversized existing
  allowance is reduced (`approve(0)` then `approve(amount)`), and an approval that
  cannot be confirmed (no receipt source) is refused rather than sent
  fire-and-forget. `SwidgeResult.fees` reports the measured source gas only when
  **every** send returns a fee, otherwise the route estimate; bridge/protocol fees
  remain route-derived
  estimates.
- **Partial execution is reported, never silently discarded.** Execution can
  broadcast more than one transaction (`approve(0)`, `approve(amount)`, the swap;
  or several adapter legs). If execution fails *after* at least one transaction has
  already gone out, `swidge()` throws a `ButterPartialExecutionError` whose
  `transactions` lists every broadcast hash in submission order and whose `cause`
  is the original failure. **Do not blindly retry** — those transactions are
  already on-chain and re-sending would double-execute them; inspect them first.
  This includes an approval that cannot be confirmed (reverted, unknown receipt
  status, or a confirmation timeout): the approval is already on the wire, so you
  get its hash and the underlying error as `cause` — the swap itself is still never
  sent against an unconfirmed approval. It also includes a send that succeeded but
  reported an unusable gas fee: a transaction is recorded the moment its send
  returns, *before* the fee is validated, so a malformed fee never erases the hash.
  Fees are checked at runtime as non-negative bigints and hashes as non-empty
  strings on both the built-in EVM path and the adapter path, because a
  host-supplied sender makes the declared types hints rather than guarantees. The
  hash is the one value checked *before* recording — it *is* the record, so a send
  that returns no usable hash is unidentifiable and throws unwrapped rather than
  being reported. A failure before anything is broadcast propagates
  unwrapped. When the broadcast set includes the `source` transaction, it is
  registered before the throw, so `getSwidgeStatus(hash)` still resolves the
  in-flight swidge.
- Transaction/receipt lookups through `toEvmPublicClient` treat only a genuine
  viem not-found as absent; every other fault (RPC timeout, auth, rate-limit)
  propagates. The check is **copy-independent** — it matches viem's error `name`
  plus its `BaseError` shape rather than relying on `instanceof`, which fails when
  the host application resolves a different copy of viem than this package.
- Legacy `swap()`/`quoteSwap()`/`bridge()`/`quoteBridge()` from the WDK base
  class sum `fees[].amount` **across denominations** (ignoring `fee.token`), so
  their scalar `fee`/`bridgeFee` are only meaningful when every fee shares one
  currency. Butter fees can span native, input, and bridge tokens — read the
  itemised `fees[]` on the `SwidgeQuote`/`SwidgeResult` for correct per-currency
  costs. This is a WDK base-class contract issue a provider cannot fix without
  overriding legacy methods (which is disallowed); a WDK-side change is needed.

Example fee policy:

```ts
const protocol = new ButterSwidgeProtocol(account, {
  sourceChainId: 56,
  entrance: 'wdk',
  maxNetworkFeeBps: 100,
  maxProtocolFeeBps: 200
})

await protocol.swidge(options, { maxNetworkFeeBps: 50 })
```

## Supported chains and tokens

Execution capability comes in three tiers (`discovery.ts: executionFor`), reported
per chain as `execution` by `getSupportedChains()`:

| Tier | Meaning |
| --- | --- |
| `native` | built-in EVM Router execution: this package validates the `/swap` calldata itself and submits it through `evm.walletClient` |
| `adapter` | execution goes through a `transactionAdapters` entry you supply. Router calldata validation does **not** apply — only chain ID and required fields are checked |
| `quote-only` | quoting, discovery, and status work; execution is unavailable until you pin a Router via `routerContracts` or supply an adapter |

Chains with a pinned Router in the built-in registry (`constants.ts:
DEFAULT_ROUTER_CONTRACTS`), i.e. `native` out of the box:

| Chain | ID |
| --- | --- |
| Ethereum | `1` |
| OP Mainnet | `10` |
| BNB Smart Chain | `56` |
| Unichain | `130` |
| Polygon | `137` |
| X Layer | `196` |
| Base | `8453` |
| Arbitrum One | `42161` |
| Avalanche C-Chain | `43114` |
| Linea | `59144` |

This is a curated subset of Butter's deployments, not the full set — see
[Router Registry](#router-registry) for adding others. Non-EVM chains Butter
supports (Solana, Bitcoin, TON, Tron) are `quote-only` until you supply an adapter;
Tron is always `adapter`-or-`quote-only` and never uses the built-in EVM path.

**Tokens are discovered at runtime**, not listed here — call
`getSupportedTokens({ chain })`. Both listings are fail-closed on missing required
metadata: a token without usable decimals, and a chain without an `id`, `type`, or
`nativeToken` symbol, are **dropped** rather than returned with a placeholder. A
chain you expect to see but don't is usually this, not an outage.

## Known limitations

- **No automated testnet integration tests.** The WDK integration guide asks for
  them; this package does not have them yet. The env-gated flows in
  [`examples/`](./examples/README.md) are the live-check mechanism in the meantime,
  including a read-only `example:decode-swap-data` for inspecting real Router
  calldata.
- **Cross-chain `toTokenAmountMin` is quoted, not enforced.** Check
  `quote.destinationGuarantees`: `'enforced'` (same-chain, the minimum is verified
  against the Router calldata) or `'quoted-only'` (cross-chain, the destination
  minimum sits in the nested bridge payload that this package trusts to Butter by
  design). WDK's field description calls it a guaranteed minimum, so the difference
  is worth knowing.
- **Exact-out is not supported** — see [Exact-in only](#exact-in-only). Butter
  documents the mode, but the default production endpoint rejects it and the
  denomination of `amount` for it is unspecified.
- **A destination chain this package does not recognize requires an explicit
  `recipient`.** The address-family table is best-effort and Butter adds chains
  between releases, so an unrecognized chain is treated as "cannot default the
  recipient" rather than assumed EVM. Add such a chain to `evmChainIds` once you
  have confirmed it is EVM.
- **`priceImpact` is not reported.** Butter only exposes it per route leg, with no
  documented unit or whole-operation aggregation, so picking one leg would
  misrepresent a multi-leg operation. The field is left `undefined` rather than
  guessed.
- **Legacy fee scalars can be meaningless.** See the fee mapping table above.

## Router Registry

The package includes a versioned registry of known Router V3 deployments.
Addresses are pinned because `/route` and `/swap` are remote, untrusted inputs;
an API response cannot authorize a new transaction target by itself. The
built-in set is a curated subset of Butter's deployments; a chain without a
pinned entry is quote-only for built-in EVM execution until its Router is
supplied via `routerContracts` (verify the address independently first).

Per-chain configuration replaces the built-in entries for that chain:

```ts
const protocol = new ButterSwidgeProtocol(account, {
  sourceChainId: 56,
  entrance: 'wdk',
  apiKeyId,
  apiSecret,
  routerContracts: {
    56: [{ address: '0x1111111111111111111111111111111111111111', version: 'v3' }],
    137: [{ address: '0x2222222222222222222222222222222222222222', version: 'v3' }]
  }
})
```

Use an empty array to disable built-in EVM execution for a chain. A configured
address must use a validator version supported by this package; an address with
a new ABI version requires a package update.

When Butter changes a Router address, existing installations reject calldata to
the new address before approval or transaction submission. This is a deliberate
fail-closed outage, not an automatic migration. Integrators can restore service
without waiting for a package release by verifying the deployment independently
and replacing that chain's `routerContracts` entry. In an emergency involving a
vulnerable old Router, operators must remove it (or temporarily configure `[]`)
and notify integrators; the static defaults cannot dynamically revoke a formerly
trusted deployment.

## Development

```sh
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

## Examples

Runnable Node.js examples for discovery, exact-in quotes, read-only Router
calldata inspection, status lookup, and a confirmation-gated same-chain EVM swap
are available in [`examples/`](./examples/README.md).

```sh
npm run example:discover
npm run example:quote
npm run example:decode-swap-data
npm run example:probe-exact-out
npm run example:status
npm run example:swap
```

Only `example:swap` sends a transaction, and it refuses to run without an
explicit confirmation value.
