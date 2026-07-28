# @butternetwork/wdk-protocol-swidge-butter

Butter Network Swidge provider for WDK.

This package adapts WDK's Swidge interface to Butter Smart Router's `/route`,
`/swap`, `/supportedChainInfo`, token-discovery, and Butter swap-data APIs.

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
  apiKeyId: process.env.BUTTER_API_KEY_ID,
  apiSecret: process.env.BUTTER_API_SECRET,
  maxNativeFee: 20000000000000000n, // required for cross-chain (see Safety Defaults)
  evm: {
    walletClient: toEvmWalletClient(viemWalletClient),
    publicClient: toEvmPublicClient(viemPublicClient) // enables allowance checks + status
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

## Behavior

- `quoteSwidge(options)` calls Butter `/route`, stores a non-binding quote as an
  optional execution cache, and returns it with a `routeHash` you can pin.
- `swidge(options, config?)` can be called directly. By default it reuses a
  matching fresh cached route or obtains a new one, enforces fee limits, calls
  `/swap`, validates the returned transaction intent, performs EVM approval when
  required, then sends the source transaction.
- Pinning a quote: pass `options.routeHash` (from a prior `quoteSwidge` result)
  to `swidge` to execute that exact quoted route. `swidge` accepts
  `ButterSwidgeOptions` (`SwidgeOptions & { routeHash? }`), so the field is part
  of the public typed API. If the route has expired or no longer matches the
  options, `swidge` throws `ButterActionRequiredError` instead of silently
  re-quoting at a different price. Pins are held in the instance's in-memory
  route cache, so quote and execution must use the same protocol instance.
  Without `routeHash`, execution auto-re-quotes as before.
- `getSwidgeStatus(id)` calls
  `/api/queryBridgeInfoBySourceHash`; `{ byOrderId: true }` calls
  `/api/queryCrossInfoByOrderId`. Same-chain swaps produce no cross-chain record,
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
  (configured `transactionAdapters`), or `quote-only`.
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

`quoteSwidge`/`swidge` map Butter route fees into WDK `SwidgeFee[]`:

| Butter field | `SwidgeFee.type` | Notes |
| --- | --- | --- |
| `bridgeFee` | `protocol` | cross-chain bridge fee |
| `bridgeFee.affiliate` | `affiliate` | integrator/affiliate share |
| `gasFee` | `network` | source-chain gas; estimate, replaced by measured gas when the sender reports every send's fee |
| `swapFee.nativeFee` | `protocol` | native-denominated swap fee |
| `swapFee.tokenFee` | `protocol` | input-token-denominated swap fee |

Fees can span different tokens; read the itemised `fees[]` (see the legacy-scalar
caveat in Safety Defaults) rather than summing amounts.

## Safety Defaults

- `sourceChainId` and `entrance` are required.
- Exact-out, zero inputs, unsafe JavaScript numbers, and amount conversions that
  would discard decimal precision are rejected.
- Explicit cross-chain slippage below Butter's documented floor is rejected.
  Defaults use the applicable minimum. BTC and TON routes use the stricter 300
  bps floor; additional IDs can be configured with `strictSlippageChainIds`.
- `minAmountOut` is enforced locally because Butter's documented `/route` API
  does not expose a separate request parameter for it.
- Quotes accept `refundAddress`. Execution requires it to match the source
  sender because Butter's Router API does not expose an independent refund
  recipient.
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
  and the transaction value must equal
  `input (if native) + routerFee + bridgeFee`. Same-chain `swapAndCall`
  additionally verifies the destination token, recipient, leftover receiver, and
  minimum output.
- Native-spend bound: the `tx.value` check bounds the transaction value to
  `input + quoted routerFee + the bridge messaging fee Butter declares in the
  calldata`. That Butter-declared bridge fee is **trusted** and not otherwise
  bounded by the quote, so cross-chain execution additionally requires
  `maxNativeFee` (an absolute cap on `routerFee + bridgeFee`, in native base
  units). When set, the cap is enforced on any chain (same-chain carries only the
  router fee); cross-chain execution additionally **fails closed** if it is not
  configured, while same-chain swaps do not require it.
- Cross-chain destination routing — the destination **recipient, output token,
  and minimum output** encoded in the nested bridge payload — is **trusted to
  Butter's `/swap` response and is NOT verified**. This is an accepted
  middle-tier trust boundary, not full calldata intent validation: a compromised
  or buggy `/swap` could route the destination output elsewhere. Only the bridge
  target (destination chain) is checked. Source-token exposure remains bounded
  because the module approves only the exact input amount to the router. Set
  `minAmountOut` for a locally-enforced destination minimum.
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

Runnable Node.js examples for discovery, exact-in quotes, status lookup, and a
confirmation-gated same-chain EVM swap are available in
[`examples/`](./examples/README.md).

```sh
npm run example:discover
npm run example:quote
npm run example:status
npm run example:swap
```
