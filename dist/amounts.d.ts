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
/**
 * Converts a non-negative decimal token amount into integer base units.
 *
 * @param {string | number | bigint | undefined | null} amount - The decimal token amount from Butter or local configuration.
 * @param {number} [decimals] - The token decimal precision used for conversion (default: 18).
 * @param {ParseTokenAmountOptions} [options] - The precision-loss policy for extra fractional digits (default: empty object).
 * @returns {bigint} The non-negative amount in integer base units.
 * @throws {ButterApiError} If the amount is negative, unsafe as a number, malformed, or more precise than the selected rounding policy allows.
 */
export declare function parseTokenAmount(amount: string | number | bigint | undefined | null, decimals?: number, options?: ParseTokenAmountOptions): bigint;
/**
 * Parses a token amount from Butter while rejecting an omitted required field.
 *
 * @param {string | number | bigint | undefined | null} amount - The required decimal token amount returned by Butter.
 * @param {string} label - The human-readable label used in validation errors.
 * @param {number} [decimals] - The token decimal precision used for conversion (default: 18).
 * @param {ParseTokenAmountOptions} [options] - The precision-loss policy for extra fractional digits (default: empty object).
 * @returns {bigint} The required amount in integer base units.
 * @throws {ButterApiError} If Butter omitted the required amount or returned an invalid amount.
 */
export declare function parseRequiredTokenAmount(amount: string | number | bigint | undefined | null, label: string, decimals?: number, options?: ParseTokenAmountOptions): bigint;
/**
 * Formats integer base units as a decimal token amount without floating point conversion.
 *
 * @param {bigint | number | string} amount - The non-negative integer base-unit amount to format.
 * @param {number} [decimals] - The token decimal precision used for conversion (default: 18).
 * @returns {string} The formatted value.
 * @throws {ButterApiError} If the amount or decimal count is negative, unsafe, or otherwise invalid.
 */
export declare function formatTokenAmount(amount: bigint | number | string, decimals?: number): string;
/**
 * Parses a decimal or hexadecimal integer amount returned by Butter.
 *
 * `BigInt` already accepts a `0x` prefix, so there is no separate hex branch. The
 * negative check applies to every input form: a `"-1"` string used to pass here
 * and only fail later in an equality comparison, which pointed the error at the
 * wrong cause.
 *
 * @param {string | number | bigint | undefined | null} value - The decimal or `0x` integer amount returned by Butter.
 * @returns {bigint} The non-negative integer amount.
 * @throws {ButterApiError} If the integer is negative or unsafe as a JavaScript number.
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
 * uniform: `fromTokenAmount`, `toTokenAmount`, and `minAmountOut`.
 *
 * Throws `ButterUnsupportedError` (not `ButterApiError`) because the value came from
 * the caller, not from Butter — this is the type `assertQuoteOptions` already used.
 *
 * @param {number | bigint | undefined | null} value - The caller-provided base-unit amount.
 * @param {string} field - The caller-facing field name used in validation errors.
 * @param {BaseUnitAmountOptions} [options] - Whether zero is valid for this field (default: empty object).
 * @returns {bigint} The validated amount in integer base units.
 * @throws {ButterUnsupportedError} If the amount is missing, fractional, unsafe as a number, negative, or zero when zero is not allowed.
 */
export declare function assertBaseUnitAmount(value: number | bigint | undefined | null, field: string, options?: BaseUnitAmountOptions): bigint;
//# sourceMappingURL=amounts.d.ts.map