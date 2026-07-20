# @butternetwork/wdk-protocol-swidge-butter

Butter Network Swidge provider for WDK.

This package adapts WDK's Swidge interface to Butter Smart Router's `/route`,
`/swap`, `/supportedChainInfo`, `/findToken`, and Butter swap-data APIs.

## Install

```sh
npm install @butternetwork/wdk-protocol-swidge-butter @tetherto/wdk-wallet
```

## Usage

```ts
import ButterSwidgeProtocol from '@butternetwork/wdk-protocol-swidge-butter'

const protocol = new ButterSwidgeProtocol(account, {
  sourceChainId: 56,
  entrance: 'wdk',
  apiKeyId: process.env.BUTTER_API_KEY_ID,
  apiSecret: process.env.BUTTER_API_SECRET,
  evm: {
    publicClient,
    walletClient
  }
})
```

Only exact-in quotes are supported. Pass `fromTokenAmount` as a positive
`bigint` in base units. Butter Router does not currently support exact-out, so
`toTokenAmount` is rejected before any network request.

`apiSecret` must not be bundled into browser or mobile clients. For public
clients, use a backend proxy or explicitly set `authMode: 'optional'` and accept
Butter's unauthenticated rate-limit behavior.

## Behavior

- `quoteSwidge(options)` calls Butter `/route` and stores the confirmed quote.
- `swidge(options)` consumes that quote once, without silently replacing it,
  calls `/swap` with the same route hash and slippage, validates the returned
  transaction intent, performs EVM approval when required, then sends the
  source transaction. Missing, expired, or already-consumed quotes are rejected.
- `getSwidgeStatus(id)` calls
  `/api/queryBridgeInfoBySourceHash`; `{ byOrderId: true }` calls
  `/api/queryCrossInfoByOrderId`.
- `getSupportedChains()` merges Router-supported chains with token API metadata.
- `getSupportedTokens(options)` resolves the chain `key` from
  `/api/queryChainList` and paginates `/api/queryTokenList`.

## Safety Defaults

- `sourceChainId` and `entrance` are required.
- Exact-out, zero inputs, unsafe JavaScript numbers, and amount conversions that
  would discard decimal precision are rejected.
- Cross-chain slippage below Butter's documented floor is rejected instead of
  silently increased. BTC routes use the stricter 300 bps floor.
- `minAmountOut` is enforced locally because Butter's documented `/route` API
  does not expose a separate request parameter for it.
- `refundAddress` is rejected because Butter's documented Router APIs do not
  expose a dedicated refund-address parameter.
- EVM Router V3 calldata is ABI-decoded. The target, source and destination
  chains, initiator, source token and amount, final token and recipient, leftover
  and refund recipients, and minimum output must match the confirmed intent.
  Permit and callback payloads are rejected. Unknown or opaque bridge payload
  encodings are also rejected; support requires a package validator update tied
  to an explicit deployment version.
- ERC20 approval only occurs after the full calldata validation and only targets
  a configured Butter router for the source chain.
- Native-source transaction value must equal the exact input amount; ERC20
  Router transactions must carry zero native value. Routes requiring additional
  native value fail closed.
- Tron, Solana, BTC, and TON require explicit `transactionAdapters`; Tron is not
  treated as viem-compatible EVM execution.
- EVM transaction submission requires `evm.walletClient`, `evm.sendTransaction`,
  or explicit `evm.useAccountTransaction`.

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
  },
  evm: { publicClient, walletClient }
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
