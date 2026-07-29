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
/** Formats integer base units as a decimal token amount without floating point conversion. */
export declare function formatTokenAmount(amount: bigint | number | string, decimals?: number): string;
/** Parses a decimal or hexadecimal integer amount returned by Butter. */
export declare function parseIntegerAmount(value: string | number | bigint | undefined | null): bigint;
//# sourceMappingURL=amounts.d.ts.map