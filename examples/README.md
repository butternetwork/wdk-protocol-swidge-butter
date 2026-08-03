# Examples

These scripts import the package through its public entry point. Run them from
the repository root with Node.js 22.9 or newer.

Optionally create a local environment file:

```sh
cp examples/.env.example examples/.env
```

Never commit `examples/.env`. Discovery and status requests can run without
Butter credentials. Quotes require a dedicated `BUTTER_ENTRANCE`; API
credentials are optional but recommended because anonymous requests are rate
limited. The real swap example requires all three integration values.

## Discover chains and tokens

```sh
npm run example:discover
```

`SOURCE_CHAIN_ID` defaults to BNB Smart Chain. Set `TOKEN_CHAIN_ID` to choose
which chain's complete token list is returned.

The output includes a `chainCoverage` section listing the chains Butter reported
but `getSupportedChains()` dropped for missing WDK-required metadata (`type`,
`nativeToken`). Check it against live data before assuming that filter is free.

## Inspect the Router calldata Butter returns

```sh
npm run example:decode-swap-data
```

Read-only: it requests a `/route` plus the matching `/swap` and decodes the
resulting Router V3 calldata, including the nested cross-chain bridge payload
(`b_data`). No wallet is constructed and nothing is signed or broadcast. `SENDER`
is required — it is only the `from` address of the `/swap` request, so any
address works and no key is involved.

Use it to confirm that `b_data` really is
`(uint256 gasLimit, bytes refundAddress, bytes swapData)` on live responses, as
Butter's router-interface documentation states. `layoutConfirmed` in the output
reports the verdict per transaction.

## Check whether Butter accepts exact-out

```sh
npm run example:probe-exact-out
```

Read-only, no funded account, nothing signed. Sends the same `/route` request twice
— once as `exactIn` (the control) and once as `exactOut` — and prints both verdicts.

This package rejects exact-out with `ButterExactOutUnsupportedError` because the
default production endpoint has answered `errno 2000` ("Parameter error") for it
while the identical `exactIn` request succeeds, and because `/route` documents
`amount` only as *"amount of source token"*, leaving the exactOut denomination
unspecified. Run this to re-check both against the live API. If it reports exactOut
accepted, compare `amount` with the echoed `totalAmountIn` / `totalAmountOut` to
settle which side it denominates before re-enabling anything.

Override the probe with `PROBE_FROM_CHAIN`, `PROBE_TO_CHAIN`, `PROBE_TOKEN_IN`,
`PROBE_TOKEN_OUT`, `PROBE_AMOUNT`, `PROBE_SLIPPAGE`.

## Inspect Butter's fee model

```sh
npm run example:probe-fee-model
```

Read-only, no funded account. Prints a live route's `bridgeFee` — the top-level
`amount` alongside `in`, `out`, and `affiliate` — plus `feeConfig` and `swapFee`.

This package relies on **no** relationship between the summary and its components.
`fees.ts` prices `in`, `out` and `affiliate` individually and never the summary: one
figure in one token cannot describe a fee spanning three, and amounts in different
tokens cannot be added, so there is nothing safe to reconstruct or cross-check. A
route reporting a summary with no components has the fee omitted from `fees[]` and a
configured `maxProtocolFeeBps` refuses.

What this script is for is seeing how a live route actually decomposes: which
components Butter populates, whether they ever span multiple tokens, and how large the
affiliate share is — that share is charged to your users whether or not you configure
`affiliate`, and it counts toward `maxProtocolFeeBps`.

Defaults to a cross-chain pair, since a same-chain route has no bridge leg and so no
bridge fee to look at. Set `PROBE_AFFILIATE=<nickname>:<rate>` to make Butter
populate a non-zero `feeConfig`. The probe prints it next to `swapFee` so you can
compare the referrer configuration with Butter's actual fee result; fee mapping and
the protocol fee cap use only `swapFee`, which already includes that charge. Other
overrides: `PROBE_FROM_CHAIN`, `PROBE_TO_CHAIN`,
`PROBE_TOKEN_IN`, `PROBE_TOKEN_OUT`, `PROBE_AMOUNT`, `PROBE_SLIPPAGE`.

## Request an exact-in quote

```sh
npm run example:quote
```

The defaults request a small BNB Smart Chain native-token to Polygon
native-token quote. Override the chain, token, amount, recipient, or slippage in
`examples/.env`. ERC20 source tokens also require `FROM_TOKEN_DECIMALS`. The
script fails locally before contacting Butter when `BUTTER_ENTRANCE` is missing
or only one API credential is provided.

## Query status

Set `SWIDGE_ID` to a source transaction hash, then run:

```sh
npm run example:status
```

For an order ID, also set `STATUS_BY_ORDER_ID=true`. Optional source and
destination chain hints use `STATUS_FROM_CHAIN` and `STATUS_TO_CHAIN`.

## Execute a same-chain EVM swap

This command sends a real transaction. Use a dedicated low-value account and
review every value in `examples/.env`. The script only executes a same-chain
swap and validates the Butter quote before sending.

Set the Butter integration values, `RPC_URL`, `PRIVATE_KEY`, and this exact
confirmation value:

```text
CONFIRM_EXECUTION=I_UNDERSTAND_THIS_SENDS_A_REAL_TRANSACTION
```

Then run:

```sh
npm run example:swap
```

The default pair is native BNB to BSC USDT. An ERC20 source token additionally
requires `EXECUTION_FROM_TOKEN_DECIMALS` and may submit an approval transaction.
The example remains same-chain to limit operational risk. The package supports
cross-chain Router V3 execution with versioned calldata validation.
