# Examples

These scripts import the package through its public entry point. Run them from
the repository root with Node.js 22.9 or newer.

Optionally create a local environment file:

```sh
cp examples/.env.example examples/.env
```

Never commit `examples/.env`. Discovery and status requests can run without
Butter credentials. Quotes and swaps require a dedicated `BUTTER_ENTRANCE`,
`BUTTER_API_KEY_ID`, and `BUTTER_API_SECRET`; obtain these integration values
from Butter.

## Discover chains and tokens

```sh
npm run example:discover
```

`SOURCE_CHAIN_ID` defaults to BNB Smart Chain. Set `TOKEN_CHAIN_ID` to choose
which chain's complete token list is returned.

## Request an exact-in quote

```sh
npm run example:quote
```

The defaults request a small BNB Smart Chain native-token to Polygon
native-token quote. Override the chain, token, amount, recipient, or slippage in
`examples/.env`. ERC20 source tokens also require `FROM_TOKEN_DECIMALS`. The
script fails locally before contacting Butter when integration credentials are
missing.

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
Cross-chain execution is intentionally omitted until its bridge payload encoding
has a versioned validator.
