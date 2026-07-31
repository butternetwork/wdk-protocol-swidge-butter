# End-to-end tests

These tests exercise the built package against Butter's live production APIs.
They are separate from `npm test`: unit tests remain deterministic and never
require credentials, RPC access, or funds.

## Read-only CI

Configure these non-sensitive GitHub Repository Variables:

- `BUTTER_E2E_ENTRANCE`
- `E2E_READ_MAX_NATIVE_FEE`, in source-chain native base units

The pull-request workflow performs discovery, obtains a cross-chain quote, asks
Butter to assemble `/swap` calldata, runs the provider's transaction validators,
and then stops at a sender that always throws. It has no private key and receives
no Butter API credentials. Do not treat the entrance as secret: pull-request code
can read Repository Variables.

Run the same check locally with:

```sh
cp .env.e2e.example .env.e2e
npm run test:e2e:read-only
```

## Funded local tests

Use a dedicated low-value wallet and a separate recipient address that you
control. Fill one complete scenario in `.env.e2e`; funded fields intentionally
have no defaults. Review the amount, maximum input, native fee cap, fee bps caps,
total gas cap, chain ids, RPC URLs, and both token addresses before every run.

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

Before signing, the guarded wallet prepares each transaction and rejects it if
its cumulative maximum gas cost or native value exceeds the configured scenario
budget. Results are written under `.e2e-results/` with BigInts normalized and
private-key, API-key, API-secret, and authorization fields removed.

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
