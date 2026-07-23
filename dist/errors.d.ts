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
/** Indicates that a configured WDK network or protocol fee cap was exceeded. */
export declare class ButterFeeLimitExceededError extends ButterActionRequiredError {
    constructor(feeType: 'network' | 'protocol', actualBps: bigint, maximumBps: bigint);
}
/** Indicates that execution was attempted without a send-capable signer. */
export declare class ButterReadOnlyAccountError extends ButterConfigurationError {
    constructor(message?: string);
}
/** Indicates use of exact-out, which Butter Router does not currently support. */
export declare class ButterExactOutUnsupportedError extends ButterUnsupportedError {
    constructor();
}
/** Indicates that `/swap` transaction data does not match the requested intent. */
export declare class ButterTransactionValidationError extends ButterApiError {
    constructor(message: string, details?: unknown);
}
//# sourceMappingURL=errors.d.ts.map