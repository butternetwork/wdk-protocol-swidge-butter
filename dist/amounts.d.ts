/**
 * What to do when a decimal amount carries more precision than the token's
 * `decimals` can represent. `reject` (the default) refuses the value rather than
 * silently losing precision; `floor`/`ceil` are for values where a deliberate
 * rounding direction is safe — pick the direction that cannot favour the
 * counterparty (e.g. `ceil` for an amount that will be compared as an upper bound).
 */
export type TokenAmountRounding = 'reject' | 'floor' | 'ceil';
export interface ParseTokenAmountOptions {
    rounding?: TokenAmountRounding;
}
/** Converts a non-negative decimal token amount into integer base units. */
export declare function parseTokenAmount(amount: string | number | bigint | undefined | null, decimals?: number, options?: ParseTokenAmountOptions): bigint;
/** Parses a token amount from Butter while rejecting an omitted required field. */
export declare function parseRequiredTokenAmount(amount: string | number | bigint | undefined | null, label: string, decimals?: number, options?: ParseTokenAmountOptions): bigint;
/** Formats integer base units as a decimal token amount without floating point conversion. */
export declare function formatTokenAmount(amount: bigint | number | string, decimals?: number): string;
/**
 * Parses a decimal or hexadecimal integer amount returned by Butter.
 *
 * `BigInt` already accepts a `0x` prefix, so there is no separate hex branch. The
 * negative check applies to every input form: a `"-1"` string used to pass here
 * and only fail later in an equality comparison, which pointed the error at the
 * wrong cause.
 */
export declare function parseIntegerAmount(value: string | number | bigint | undefined | null): bigint;
export interface BaseUnitAmountOptions {
    /** Accept `0`; the default requires a strictly positive amount. */
    allowZero?: boolean;
}
/**
 * Validates a caller-supplied base-unit amount from the WDK `number | bigint` union.
 *
 * WDK declares these as `number | bigint`, so an out-of-range `number` (e.g. `1e20`)
 * reaches `BigInt()` and throws a raw `RangeError` that names neither the field nor
 * this package. Every caller-facing amount goes through here so the diagnostics are
 * uniform: `fromTokenAmount`, `toTokenAmount`, `minAmountOut`, `maxFromTokenAmount`.
 *
 * Throws `ButterUnsupportedError` (not `ButterApiError`) because the value came from
 * the caller, not from Butter — this is the type `assertQuoteOptions` already used.
 */
export declare function assertBaseUnitAmount(value: number | bigint | undefined | null, field: string, options?: BaseUnitAmountOptions): bigint;
//# sourceMappingURL=amounts.d.ts.map