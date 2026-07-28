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
- Multi-transaction non-EVM adapters must classify each transaction
  (`{ transaction, type }`) and resolve to **exactly one** `source` (the operation
  id); an ambiguous, unclassified, or illegally-typed result is now rejected before
  any transaction is broadcast.
- The `@tetherto/wdk-wallet` peer range is capped to `<2.0.0`.

### Types
- Export `ButterPartialExecutionError` (extends `ButterActionRequiredError`) with a
  `transactions: readonly SwidgeTransaction[]` list and the underlying `cause`.
- Export `ButterAdapterResult` and `ViemPublicClientLike`, and simplify
  `ButterTransactionAdapter`'s return type — previously `unknown | ButterAdapterResult`,
  which collapsed to `unknown` — so the typed adapter form is discoverable. Return
  stays intentionally open for arbitrary non-EVM transaction shapes.

### Known upstream issue
- The WDK base class's legacy `swap`/`quoteSwap`/`bridge`/`quoteBridge` sum
  `fees[].amount` across denominations (ignoring `fee.token`); the scalar totals
  are only meaningful when all fees share a currency. This requires a WDK-side fix
  (PR #39 follow-up); consumers should read the itemised `fees[]`.

### Follow-ups
- Testnet integration tests (per the WDK integration guide) are not yet included;
  the env-gated flows in `examples/` cover live checks in the meantime.
