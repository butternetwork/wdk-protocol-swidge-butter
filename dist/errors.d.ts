import type { SwidgeTransaction } from './types.js';
/** Indicates malformed, inconsistent, or unsuccessful Butter API data. */
export declare class ButterApiError extends Error {
    readonly details: unknown;
    constructor(message: string, details?: unknown);
}
/** Indicates an operation or option unsupported by this provider. */
export declare class ButterUnsupportedError extends Error {
    readonly details: unknown;
    constructor(message: string, details?: unknown);
}
/** Indicates missing or invalid provider configuration. */
export declare class ButterConfigurationError extends Error {
    readonly details: unknown;
    constructor(message: string, details?: unknown);
}
/** Indicates that caller action is required before an operation can continue. */
export declare class ButterActionRequiredError extends Error {
    readonly details: unknown;
    constructor(message: string, details?: unknown);
}
/**
 * Indicates that a configured fee cap could not be evaluated because the
 * Butter route lacks the metadata (USD values, gas fee) needed to value a fee
 * against the input amount. Fee limits fail closed on unvaluable routes.
 */
export declare class ButterFeeValuationError extends ButterApiError {
    constructor(message: string, details?: unknown);
}
/**
 * Indicates that Butter has no route for the requested pair — either an explicit
 * `errno 2003` ("No Route Found", which Butter returns with HTTP 200) or a response
 * whose candidates all report no liquidity.
 *
 * Distinguished from a plain {@link ButterApiError} because "this pair is not
 * routable right now" is a normal, retryable outcome a caller may want to surface
 * to a user, whereas a bad parameter or a rejected API key is not.
 */
export declare class ButterNoRouteError extends ButterApiError {
    constructor(message: string, details?: unknown);
}
/** Indicates that a configured WDK network or protocol fee cap was exceeded. */
export declare class ButterFeeLimitExceededError extends ButterActionRequiredError {
    constructor(feeType: 'network' | 'protocol', actualBps: bigint, maximumBps: bigint);
}
/**
 * Indicates that execution stopped after one or more transactions had already
 * been broadcast, so the operation is partially applied on-chain.
 *
 * {@link transactions} lists every transaction this provider confirmed it sent
 * before the failure. A caller MUST NOT blindly retry the operation — the listed
 * transactions are already submitted and re-sending would double-execute them.
 * Inspect them (and the source transaction's status) first.
 *
 * This covers a later send failing and an approval that cannot be confirmed
 * (revert, unknown receipt status, timeout) — the approval is already on the
 * wire either way. The underlying failure is preserved as {@link cause}.
 *
 * Only thrown when at least one transaction was broadcast; a failure before
 * anything reaches the chain propagates unwrapped.
 */
export declare class ButterPartialExecutionError extends ButterActionRequiredError {
    /** Transactions already broadcast, in submission order. */
    readonly transactions: readonly SwidgeTransaction[];
    /** The underlying send failure. Declared explicitly so it is typed without `lib.es2022.error`. */
    readonly cause: unknown;
    /** Role of the transaction whose send failed, when known. */
    readonly failedType: SwidgeTransaction['type'] | undefined;
    constructor(transactions: readonly SwidgeTransaction[], cause: unknown, failedType?: SwidgeTransaction['type']);
}
/** Indicates that execution was attempted without a send-capable signer. */
export declare class ButterReadOnlyAccountError extends ButterConfigurationError {
    constructor(message?: string);
}
/**
 * @deprecated No longer thrown. Exact-out is supported: `quoteSwidge` accepts it
 * unconditionally, and `swidge` requires `options.maxFromTokenAmount` — whose
 * absence raises `ButterConfigurationError`, matching the cross-chain
 * `maxNativeFee` requirement. Still exported so existing `catch` clauses and
 * imports keep compiling; it will be removed in a future major.
 */
export declare class ButterExactOutUnsupportedError extends ButterUnsupportedError {
    constructor();
}
/** Indicates that `/swap` transaction data does not match the requested intent. */
export declare class ButterTransactionValidationError extends ButterApiError {
    constructor(message: string, details?: unknown);
}
//# sourceMappingURL=errors.d.ts.map