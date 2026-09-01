import type { ButterRoute, ButterWarning, SwidgeFee, SwidgeProtocolConfig } from './types.js';
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
    /**
     * Source-token decimals this package resolved (config / `/findToken` / native
     * default) and used to build the `/route` request.
     *
     * Required whenever a source-denominated fee is measured against
     * {@link requestedAmountIn}: that denominator is in real base units, so parsing
     * the numerator with the route's own `srcChain.tokenIn.decimals` lets an
     * understated value shrink the fee by a power of ten and slip under a bps cap.
     * The route only has its token *address* checked, never its decimals.
     */
    sourceTokenDecimals?: number;
    /** Receives non-fatal fee-mapping notices; see {@link ButterWarning}. */
    onWarning?: (warning: ButterWarning) => void;
}
/** Effective WDK fee limits after constructor and per-call precedence. */
export interface ResolvedFeeLimits {
    maxNetworkFeeBps?: bigint;
    maxProtocolFeeBps?: bigint;
}
/**
 * Resolves and validates constructor and per-call WDK fee limits.
 *
 * @param {SwidgeProtocolConfig} defaults - The constructor-level defaults used when no override is present.
 * @param {SwidgeProtocolConfig} overrides - The per-call or per-chain overrides to apply.
 * @returns {ResolvedFeeLimits} The validated limits after per-call values override constructor defaults.
 */
export declare function resolveFeeLimits(defaults: SwidgeProtocolConfig, overrides: SwidgeProtocolConfig): ResolvedFeeLimits;
/**
 * Validates configured fee limits eagerly, rejecting malformed bps values.
 *
 * @param {SwidgeProtocolConfig} config - The constructor-level network and protocol fee caps to validate.
 * @returns {void} Returns after every configured fee cap has been validated.
 */
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
 *
 * @param {ButterRoute} route - The Butter route to inspect or map.
 * @param {FeeContext} context - The source chain, source token decimals, and warning sink used to map each fee.
 * @returns {SwidgeFee[]} The mapped provider result.
 */
export declare function mapRouteFees(route: ButterRoute, context: FeeContext): SwidgeFee[];
/**
 * Returns the route's additional native protocol fee in source-chain base units.
 *
 * Rounds up: this value is the quoted side of an upper bound on `tx.value`
 * (`swap-data.ts`), so rounding down would turn a sub-wei formatting artifact in
 * Butter's decimal string into a rejected transaction. Rounding up can only widen
 * the bound by one wei, and the absolute `maxNativeFee` cap is unaffected.
 *
 * @param {ButterRoute} route - The Butter route to inspect or map.
 * @param {FeeContext} context - The source chain and native-decimal overrides used to parse the fee.
 * @returns {bigint} The additional native protocol fee in source-chain base units.
 */
export declare function routeNativeFee(route: ButterRoute, context: FeeContext): bigint;
/**
 * Enforces WDK network and protocol fee caps before transaction construction.
 *
 * @param {ButterRoute} route - The Butter route to inspect or map.
 * @param {FeeContext} context - The trusted source amount, decimals, and chain metadata used for valuation.
 * @param {ResolvedFeeLimits} limits - The resolved fee limits to enforce.
 * @returns {void} Returns when every configured fee ratio is within its cap.
 */
export declare function enforceFeeLimits(route: ButterRoute, context: FeeContext, limits: ResolvedFeeLimits): void;
/**
 * Resolves source-chain native token decimals with caller overrides.
 *
 * @param {string} chainId - The chain identifier used for normalization or lookup.
 * @param {Record<string, number> | undefined} configured - The caller-supplied configuration values.
 * @returns {number} The configured or built-in native-token decimal count.
 */
export declare function nativeDecimalsForChain(chainId: string, configured: Record<string, number> | undefined): number;
//# sourceMappingURL=fees.d.ts.map