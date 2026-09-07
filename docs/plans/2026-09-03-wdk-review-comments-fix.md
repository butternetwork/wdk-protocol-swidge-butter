# WDK Review Comments Fix

## Public contract

Built-in EVM execution accepts one full WDK EVM account. That account provides
the source address and receives every approval and Router transaction, including
`data` and `chainId`. Version 0.2 removes the former `evm.walletClient` API, so
there is no second sender or fallback path.

The package continues to export its published Butter error names. Each is also
catchable through the corresponding WDK category: configuration errors are
`ValueError`, unsupported-operation errors are `UnsupportedOperationError`, fee
limit errors are `MaximumFeeExceededError`, missing full-account errors are
`AccountRequiredError`, and Butter-specific bases are `WdkError`.

## Migration

The package root re-exports the upstream WDK error constructors without wrapping
them. This identity guarantee covers `WdkError`, `ValueError`,
`UnsupportedOperationError`, `MaximumFeeExceededError`, `ProviderError`,
`ProviderRequiredError`, `TransactionError`, and `AccountRequiredError`.
Applications upgrading from 0.1 must remove `evm.walletClient` and
`toEvmWalletClient`, then supply their WDK EVM account directly to the protocol
constructor.

A failure from the WDK account before any transaction is broadcast propagates
unchanged, including `ProviderRequiredError`, `ProviderError`, and
`TransactionError`. Once at least one transaction has been broadcast, a later
failure is reported as `ButterPartialExecutionError`; its `cause` retains the
original account error and its `transactions` retain every known broadcast hash.

## Acceptance

Public behavior tests must prove WDK error ancestry, exact Butter diagnostics,
single-account native and ERC20 execution, exact approvals, partial-execution
reporting, non-EVM adapter preservation, packed Node/Bare exports, and compile-time
compatibility with `@tetherto/wdk-wallet-evm@1.0.0-beta.17`.
The packed consumer installs the minimum supported
`@tetherto/wdk-wallet@1.0.0-beta.17`, and negative contracts prove that the
removed wallet-client API cannot be imported or configured.
