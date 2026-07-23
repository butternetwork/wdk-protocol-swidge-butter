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
import ButterSwidgeProtocol from '@butternetwork/wdk-protocol-swidge-butter'

// A full WDK wallet account is all that is needed for EVM execution.
const protocol = new ButterSwidgeProtocol(account, {
  sourceChainId: 56,
  entrance: 'wdk',
  apiKeyId: process.env.BUTTER_API_KEY_ID,
  apiSecret: process.env.BUTTER_API_SECRET
})
```

Execution is account-first: the WDK account's own `sendTransaction` submits
transactions by default. Optional `evm.walletClient` or `evm.sendTransaction`
override the account sender, and an optional `evm.publicClient` enables ERC20
allowance checks (without one, an approval is always submitted and confirmed
through the account's `getTransactionReceipt`).

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

- `quoteSwidge(options)` calls Butter `/route` and stores a non-binding quote as
  an optional execution cache.
- `swidge(options, config?)` can be called directly. It reuses a matching fresh
  cached route or obtains a new one, enforces fee limits, calls `/swap`, validates
  the returned transaction intent, performs EVM approval when required, then
  sends the source transaction.
- `getSwidgeStatus(id)` calls
  `/api/queryBridgeInfoBySourceHash`; `{ byOrderId: true }` calls
  `/api/queryCrossInfoByOrderId`.
- `getSwidgeStatus` maps Butter states `0 → pending`, `1 → completed`,
  `2 → failed`, and `6 → refunded`. Unknown state codes throw instead of being
  reported as `pending`, so refunds and failures are never masked.
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
- EVM Router V3 calldata is ABI-decoded. The target, source and destination
  chains, initiator, source token and amount, final token and recipient, leftover
  and refund recipients, and minimum output must match the confirmed intent.
  Permit and callback payloads are rejected. Unknown or opaque bridge payload
  encodings are also rejected; support requires a package validator update tied
  to an explicit deployment version.
- ERC20 approval only occurs after the full calldata validation and only targets
  a configured Butter router for the source chain.
- Same-chain transaction value is the native input amount or zero for ERC20.
  Cross-chain value additionally includes the decoded and quoted
  `bridge.nativeFee`; mismatches between route, calldata, and transaction value
  fail closed.
- `maxNetworkFeeBps` and `maxProtocolFeeBps` are enforced at quote time and
  again before `/swap`, approvals, or transaction submission. Per-call values
  override constructor defaults. Cross-token fees require route-provided USD or
  same-stage valuation metadata when a cap is enabled; unvaluable fees fail
  closed with `ButterFeeValuationError`.
- Quotes and discovery do not require a signer or local transaction adapter.
  Execution without a send-capable account or configured signer fails before a
  route request.
- Tron, Solana, BTC, and TON require explicit `transactionAdapters`; Tron is not
  treated as viem-compatible EVM execution. Adapter execution bypasses the
  Router V3 calldata validation performed on the built-in EVM path — only chain
  ID and required transaction fields are checked, so adapters carry their own
  trust responsibility for the provider-supplied transaction data.
- EVM transaction submission uses the account's `sendTransaction` by default;
  `evm.sendTransaction` and `evm.walletClient` act as explicit overrides.

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
an API response cannot authorize a new transaction target by itself.

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
