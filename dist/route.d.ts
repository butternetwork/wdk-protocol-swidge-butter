import type { ButterRoute, CachedRoute, SwidgeOptions } from './types.js';
export interface RouteRequestContext {
    sourceChainId: string;
    entrance: string;
    now: () => number;
    tokenDecimals: Record<string, number>;
    nativeTokenDecimals: Record<string, number>;
    strictSlippageChainIds: Set<string>;
    requestRoute: (params: Record<string, unknown>) => Promise<ButterRoute[] | ButterRoute>;
    /** Optional fallback resolving decimals for tokens absent from `tokenDecimals`. */
    lookupDecimals?: (token: string) => Promise<number | undefined>;
}
export declare class RouteManager {
    private readonly context;
    private readonly cache;
    private readonly hashIndex;
    constructor(context: RouteRequestContext);
    getRoute(options: SwidgeOptions, { forExecution }?: {
        forExecution?: boolean;
    }): Promise<CachedRoute>;
    /**
     * Consumes a previously quoted route pinned by its Butter hash.
     *
     * Returns the cached route (removing it) only when it is still fresh and its
     * request matches the current options; otherwise throws so the caller
     * re-quotes rather than silently executing a different or stale price.
     */
    consumeRouteByHash(hash: string, options: SwidgeOptions): Promise<CachedRoute>;
    /**
     * Bounds cache growth for long-lived quote-only instances: drops expired
     * entries, then evicts oldest (insertion-ordered) entries until under the cap.
     */
    private evictStaleRoutes;
    private evict;
    buildRouteRequest(options: SwidgeOptions): Promise<Record<string, unknown>>;
    enforceMinAmountOut(options: SwidgeOptions, route: ButterRoute): void;
    private decimalsFor;
    private validateRouteMatchesRequest;
}
export declare function routeExpiresAt(route: ButterRoute, now: number): number;
/**
 * Reads a route token's decimals, requiring them to be present and valid.
 *
 * Butter always echoes token decimals on a route; a missing value indicates
 * malformed data, so we fail rather than silently defaulting to 18 (which
 * would misscale amounts by orders of magnitude).
 */
export declare function decimalsOf(token: {
    decimals?: string | number;
} | undefined, label?: string): number;
//# sourceMappingURL=route.d.ts.map