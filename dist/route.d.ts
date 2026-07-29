import type { ButterRoute, CachedRoute, SwidgeOptions } from './types.js';
export interface RouteRequestContext {
    sourceChainId: string;
    entrance: string;
    now: () => number;
    tokenDecimals: Record<string, number>;
    nativeTokenDecimals: Record<string, number>;
    strictSlippageChainIds: Set<string>;
    /**
     * Seconds of remaining route lifetime required on the execution path, covering
     * the `/swap` round-trip and the approval wait that still follow. Defaults to
     * {@link ROUTE_EXECUTION_MARGIN_SECONDS}.
     */
    executionMarginSeconds?: number;
    /**
     * Butter affiliate string (`<nickname>[:rate]`) collecting the integrator's
     * share. Butter substitutes **its own** default affiliate wallet when this is
     * absent, and the user pays either way — so leaving it unset is a choice to
     * forgo the share, not a way to avoid the fee. Validated at construction.
     */
    affiliate?: string;
    /** Butter referrer. Mandatory for Solana same-chain routes, optional on EVM. */
    referrer?: string;
    requestRoute: (params: Record<string, unknown>) => Promise<ButterRoute[] | ButterRoute>;
    /** Optional fallback resolving decimals for tokens absent from `tokenDecimals`. */
    lookupDecimals?: (token: string) => Promise<number | undefined>;
}
export declare class RouteManager {
    private readonly context;
    private readonly cache;
    private readonly hashIndex;
    constructor(context: RouteRequestContext);
    private executionMargin;
    getRoute(options: SwidgeOptions, { forExecution, senderFallback }?: {
        forExecution?: boolean;
        senderFallback?: string | undefined;
    }): Promise<CachedRoute>;
    /**
     * Consumes a previously quoted route pinned by its Butter hash.
     *
     * Returns the cached route (removing it) only when it is still fresh enough to
     * execute and its request matches the current options; otherwise throws so the
     * caller re-quotes rather than silently executing a different or stale price.
     *
     * A pin is the caller's approved price, so a route inside the execution margin
     * cannot be silently re-fetched the way {@link getRoute} does — that would
     * execute a price the caller never saw. It is rejected instead.
     */
    consumeRouteByHash(hash: string, options: SwidgeOptions, senderFallback?: string): Promise<CachedRoute>;
    /**
     * Bounds cache growth for long-lived quote-only instances: drops expired
     * entries, then evicts oldest (insertion-ordered) entries until under the cap.
     */
    private evictStaleRoutes;
    private evict;
    buildRouteRequest(options: SwidgeOptions, senderFallback?: string): Promise<Record<string, unknown>>;
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