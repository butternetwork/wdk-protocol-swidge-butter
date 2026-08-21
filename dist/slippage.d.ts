/** Context used to apply Butter's route-specific slippage floors. */
export interface SlippageOptions {
    crossChain?: boolean;
    sourceChainId?: string | number;
    toChainId?: string | number;
    strictChainMinimum?: number;
}
/**
 * Converts WDK decimal slippage to Butter basis points and enforces minimums.
 *
 * @param {number | undefined} slippage - The maximum caller-approved slippage as a decimal fraction.
 * @param {SlippageOptions} [options] - The caller-supplied operation options (default: empty object).
 * @returns {number} The caller-approved slippage in integer basis points.
 * @throws {ButterUnsupportedError} If slippage is outside 0 through 0.5 or cannot be expressed at one-basis-point precision.
 * @throws {ButterActionRequiredError} If the requested slippage is below Butter's route-specific minimum.
 */
export declare function toButterSlippage(slippage: number | undefined, options?: SlippageOptions): number;
/**
 * Returns the minimum Butter slippage in basis points for a route.
 *
 * @param {SlippageOptions} options - The caller-supplied operation options.
 * @returns {number} The minimum route slippage in basis points.
 */
export declare function minimumSlippageBps(options: SlippageOptions): number;
//# sourceMappingURL=slippage.d.ts.map