/** Converts a non-negative decimal token amount into integer base units. */
export declare function parseTokenAmount(amount: string | number | bigint | undefined | null, decimals?: number): bigint;
/** Formats integer base units as a decimal token amount without floating point conversion. */
export declare function formatTokenAmount(amount: bigint | number | string, decimals?: number): string;
/** Parses a decimal or hexadecimal integer amount returned by Butter. */
export declare function parseIntegerAmount(value: string | number | bigint | undefined | null): bigint;
//# sourceMappingURL=amounts.d.ts.map