# End-to-end tests

These tests exercise the built package against Butter's live production APIs.
They are separate from `npm test`: unit tests remain deterministic and never
require credentials, RPC access, or funds.

## Read-only CI

The workflow has safe, non-sensitive defaults:

- `BUTTER_E2E_ENTRANCE=butter+`
- `E2E_READ_MAX_NATIVE_FEE=20000000000000000`, or `0.02 BNB` for the
  default BSC source chain
- `E2E_READ_AMOUNT=100000000000000000`, or `0.1 BNB` for the default
  BSC native-token input

The matching GitHub Repository Variables are optional overrides. Set them when
the integration entrance, source-chain native-fee budget, or live API minimum
input needs to differ.

The pull-request workflow performs discovery, obtains a cross-chain quote, asks
Butter to assemble `/swap` calldata, runs the provider's transaction validators,
and then stops at a sender that always throws. Each run derives a fresh EVM address
from an in-memory random private key, immediately discards the key, and never gives
the sender signing capability. It receives no configured private key or Butter API
credentials. Do not treat the entrance as secret: pull-request code can read
Repository Variables. The runner also ignores `BUTTER_API_KEY_ID` and
`BUTTER_API_SECRET` when they are present in the same `.env.e2e` for funded tests.

Run the same check locally with:

```sh
cp .env.e2e.example .env.e2e
npm run test:e2e:read-only
```

The copied defaults are immediately runnable for the default BSC-to-Polygon
scenario. Change both the source chain and its native-fee budget together.

## Funded local tests

Use a dedicated low-value wallet and a separate recipient address that you
control. Fill one complete scenario in `.env.e2e`; funded fields intentionally
have no defaults. Review the amount, maximum input, native fee cap, fee bps caps,
total gas cap, chain ids, RPC URLs, and both token addresses before every run.
The common Butter API credentials are used only by funded and status tests.

Set the exact confirmation only for the command you intend to run:

```text
CONFIRM_EXECUTION=I_UNDERSTAND_THIS_SENDS_REAL_FUNDS
```

Run one scenario at a time:

```sh
npm run test:e2e:same-native
npm run test:e2e:same-erc20
npm run test:e2e:cross-native
```

The ERC20 scenario deliberately requires at least one `approval` transaction in
the result. It leaves `approvalTimeoutMs` unset so the package's 10-second default
is exercised. Same-chain status polls every 3 seconds for at most 3 minutes;
cross-chain status polls every 15 seconds for at most 45 minutes. A successful run
requires `completed` status and a recipient balance increase at least equal to the
quoted minimum.

Cross-chain polling treats an explicit Butter `data.info: null` response as a
temporary indexing delay and continues within the same 45-minute timeout. Other
API, authentication, malformed-response, and infrastructure errors still fail
immediately.

Before signing, the guarded wallet prepares each transaction and rejects it if
its cumulative maximum gas cost or native value exceeds the configured scenario
budget. Results are written under `.e2e-results/` with BigInts normalized and
private-key, API-key, API-secret, and authorization fields removed.

If viem automatically prepares an EIP-1559 transaction with `maxFeePerGas: 0`,
the guarded wallet re-prepares the original request as legacy before signing. An
explicit transaction type is never overridden, and the gas budget uses the final
legacy `gasPrice`; this is preparation fallback, not a broadcast retry.

## Partial execution

Never rerun a failed funded command without inspecting its result file. If the
provider throws `ButterPartialExecutionError`, the harness records every known
hash immediately. When a source transaction exists it only polls that operation;
it never calls `swidge()` again. An approval-only failure stops with an explicit
do-not-retry error.

If the process was interrupted after the source transaction was sent, configure
the `E2E_STATUS_*` fields and resume read-only polling:

```sh
npm run test:e2e:status
```
