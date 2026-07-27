import type { ButterRoute, SwidgeFee, SwidgeProtocolConfig } from './types.js';
/** Chain and token context required to parse Butter route fees. */
export interface FeeContext {
    sourceChainId: string;
    sourceToken: string;
    nativeTokenDecimals?: Record<string, number>;
    /**
     * The caller's exact input in source-token base units. Used as the denominator
     * for source-denominated fee caps so an inflated route-reported input cannot
     * understate the ratio and bypass a bps limit. Required when a source-token
     * fee cap is enforced.
     */
    requestedAmountIn?: bigint;
}
/** Effective WDK fee limits after constructor and per-call precedence. */
export interface ResolvedFeeLimits {
    maxNetworkFeeBps?: bigint;
    maxProtocolFeeBps?: bigint;
}
/** Resolves and validates constructor and per-call WDK fee limits. */
export declare function resolveFeeLimits(defaults: SwidgeProtocolConfig, overrides: SwidgeProtocolConfig): ResolvedFeeLimits;
/** Validates configured fee limits eagerly, rejecting malformed bps values. */
export declare function validateFeeLimits(config: SwidgeProtocolConfig): void;
/**
 * Maps Butter fee metadata into WDK fee entries using denomination-specific decimals.
 *
 * NOTE (upstream WDK contract): the base SwidgeProtocol's legacy `swap()` and
 * `bridge()` sum `fees[].amount` across entries regardless of denomination.
 * Butter fees can be denominated in different tokens (native, input token,
 * bridge token), so the legacy aggregated `fee` / `bridgeFee` have no coherent
 * unit when denominations differ. Consumers needing correct per-currency costs
 * must read the itemised `fees[]` on the SwidgeQuote/SwidgeResult, not the
 * legacy scalars. This cannot be fixed here without overriding legacy methods
 * (which providers must not do); it needs a WDK PR #39 mapping-contract change.
 */
export declare function mapRouteFees(route: ButterRoute, context: FeeContext): SwidgeFee[];
/** Returns the route's additional native protocol fee in source-chain base units. */
export declare function routeNativeFee(route: ButterRoute, context: FeeContext): bigint;
/** Enforces WDK network and protocol fee caps before transaction construction. */
export declare function enforceFeeLimits(route: ButterRoute, context: FeeContext, limits: ResolvedFeeLimits): void;
/** Resolves source-chain native token decimals with caller overrides. */
export declare function nativeDecimalsForChain(chainId: string, configured: Record<string, number> | undefined): number;
//# sourceMappingURL=fees.d.ts.map