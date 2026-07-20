export declare class ButterApiError extends Error {
    readonly details: unknown;
    constructor(message: string, details?: unknown);
}
export declare class ButterUnsupportedError extends Error {
    readonly details: unknown;
    constructor(message: string, details?: unknown);
}
export declare class ButterConfigurationError extends Error {
    readonly details: unknown;
    constructor(message: string, details?: unknown);
}
export declare class ButterActionRequiredError extends Error {
    readonly details: unknown;
    constructor(message: string, details?: unknown);
}
export declare class ButterExactOutUnsupportedError extends ButterUnsupportedError {
    constructor();
}
export declare class ButterQuoteRequiredError extends ButterActionRequiredError {
    constructor();
}
export declare class ButterQuoteExpiredError extends ButterActionRequiredError {
    constructor();
}
export declare class ButterTransactionValidationError extends ButterApiError {
    constructor(message: string, details?: unknown);
}
//# sourceMappingURL=errors.d.ts.map