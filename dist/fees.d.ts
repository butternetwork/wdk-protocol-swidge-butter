import type { ButterRoute, SwidgeFee, SwidgeProtocolConfig } from './types.js';
/** Chain and token context required to parse Butter route fees. */
export interface FeeContext {
    sourceChainId: string;
    sourceToken: string;
    nativeTokenDecimals?: Record<string, number>;
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
/** Returns true when the resolved limits contain at least one active cap. */
export declare function hasFeeLimits(limits: ResolvedFeeLimits): boolean;
/** Maps Butter fee metadata into WDK fee entries using denomination-specific decimals. */
export declare function mapRouteFees(route: ButterRoute, context: FeeContext): SwidgeFee[];
/** Returns the route's additional native protocol fee in source-chain base units. */
export declare function routeNativeFee(route: ButterRoute, context: FeeContext): bigint;
/** Enforces WDK network and protocol fee caps before transaction construction. */
export declare function enforceFeeLimits(route: ButterRoute, context: FeeContext, limits: ResolvedFeeLimits): void;
/** Resolves source-chain native token decimals with caller overrides. */
export declare function nativeDecimalsForChain(chainId: string, configured: Record<string, number> | undefined): number;
//# sourceMappingURL=fees.d.ts.map