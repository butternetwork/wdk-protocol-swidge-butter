# EVM Account Chain Binding

Status: deferred by the user on 2026-09-11. This known issue remains unresolved;
the account API migration is not part of the current implementation. Continue
reviewing and fixing other issues. The design below is retained for future work.

## Problem

The published WDK EVM transaction populator replaces the requested `chainId`
with the account provider's network before signing. A Butter source configured
for chain 56 can therefore broadcast on chain 1 and report chain 56. Versions
1.0.0-beta.17, 1.0.0-beta.18 and 2.0.0-rc.1 retain this behavior. Checking a
separate public client does not verify the sending account's network.

The existing account interface exposes neither its provider nor a hook between
transaction population and signing. Calling its public `signTransaction` first
does not constrain its subsequent `sendTransaction`.

## Proposed Public Contract

Add an optional `wdk-evm` entrypoint providing a factory that accepts the official
WDK `ISignerEvm`, wallet configuration, and a positive safe integer chain ID.
It returns a full official WDK EVM account with an immutable chain-binding
descriptor. The core package entrypoint does not load the EVM wallet dependency.
If wallet configuration and the factory's expected chain ID disagree, construction
fails with `ButterConfigurationError`; neither value silently overrides the other.

The factory guarantees that the final populated transaction has the expected
chain ID before delegating signing, and that the serialized signature result
encodes the expected chain ID before the account can broadcast it. Unprotected
legacy transactions and unparsable results are refused. Mismatches throw
`ButterConfigurationError`; failures after an earlier broadcast preserve the
existing `ButterPartialExecutionError` contract.

Built-in EVM execution requires a matching chain-binding descriptor before
requesting a route. Quotes and non-EVM adapter execution retain their existing
requirements. Custom accounts may implement the same binding contract, but the
descriptor is a host assertion: it cannot prove that arbitrary host code obeys
its contract. Do not provide a helper that merely labels an unprotected account.

The factory preserves signer method context, lifecycle and derivation behavior.
Each account captures an immutable expected chain without mutating the original
signer or another account. It adds no nonce concurrency guarantees.
Supplied signers are borrowed, just like existing account delegates: disposing a
guarded account does not dispose the caller-owned signer. The caller remains
responsible for disposing it after all accounts using it have finished.

## Compatibility

An existing manager-created account can be reused through its public
`signTransaction` method as the signing delegate of a new official sending
account. The new account installs the final-signature guard and is the only
account whose `sendTransaction` is called. Integrators provide the new account's
provider configuration explicitly; no existing provider or private key is read.
The delegate is borrowed: disposing the wrapper must not dispose the original
account. Existing signing policies, including fee checks, remain in effect.

This migration path was verified using real official accounts and simulated
EIP-1193 providers: an original account configured for chain 1 signed the new
account's chain-56 transaction through its public signing method without using
its RPC, and only the new provider broadcast on chain 56. A new provider on
chain 1 was rejected before the original signing call or any broadcast.

The existing account's own send method remains unprotected. Callers must pass
the guarded sending account to Butter, or supply an account whose own
implementation guarantees final-signature chain binding. Do not extract private
keys or access protected account fields to migrate.

This requirement is a breaking change and needs an explicit compatibility
decision, migration documentation, package entrypoint checks and release notes.
An opt-in guard would leave the original unguarded path unresolved.

## Validation

- Use the real official account with simulated providers and signers.
- Correct network: native swaps, allowance resets, approvals and swaps succeed.
- Wrong network: no original signing call and no broadcast.
- Network changes before signing: refuse; after an approval, report its hash.
- A signer returning a different chain or an unprotected signature is refused.
- Concurrent accounts bound to distinct chains preserve their own constraints.
- Reusing an existing account as a signing delegate never calls its send method,
  preserves its signing policies, and does not transfer lifecycle ownership.
- Missing or mismatching descriptors fail before route or approval requests.
- Preserve quote availability, non-EVM execution, method context, derivation,
  partial execution reporting and the single sending-account model.
- Run all deterministic tests, repository checks, type checks, build and package
  entrypoint tests, followed by another independent whole-project review.
