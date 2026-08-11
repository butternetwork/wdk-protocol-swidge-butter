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
 * @throws {ButterUnsupportedError} If slippage is outside the supported range or cannot be represented in whole basis points.
 * @throws {ButterActionRequiredError} If slippage is below the route's required minimum.
 */
export declare function toButterSlippage(slippage: number | undefined, options?: SlippageOptions): number;
/** Returns the minimum Butter slippage in basis points for a route. */
export declare function minimumSlippageBps(options: SlippageOptions): number;
//# sourceMappingURL=slippage.d.ts.map