import type { ButterRoute, CachedRoute, SwidgeOptions } from './types.js';
export interface RouteRequestContext {
    sourceChainId: string;
    entrance: string;
    now: () => number;
    /**
     * Configured decimals, indexed by `normalizeTokenKey`. A Map rather than a record
     * so the key function that built it is the one the lookup uses; see
     * `protocol.ts: normalizedTokenDecimals`.
     */
    tokenDecimals: ReadonlyMap<string, number>;
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
interface RouteLookupOptions {
    forExecution?: boolean;
    senderFallback?: string;
}
interface RouteRequestResult {
    request: Record<string, unknown>;
    sourceDecimals: number;
}
export declare class RouteManager {
    private readonly context;
    private readonly cache;
    private readonly hashIndex;
    /**
     * Creates a route manager instance.
     *
     * @param {RouteRequestContext} context - The validated context required by the operation.
     */
    constructor(context: RouteRequestContext);
    /** @private */
    private executionMargin;
    /**
     * Returns a fresh or reusable Butter route matching the caller options.
     *
     * @param {SwidgeOptions} options - The caller-supplied operation options.
     * @param {RouteLookupOptions} [lookupOptions] - The cache and sender options used for route lookup (default: empty object).
     * @returns {Promise<CachedRoute>} The resolved result.
     * @throws {ButterNoRouteError} If Butter provides no liquid route for the request.
     */
    getRoute(options: SwidgeOptions, lookupOptions?: RouteLookupOptions): Promise<CachedRoute>;
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
     *
     * @param {string} hash - The transaction or route hash to process.
     * @param {SwidgeOptions} options - The caller-supplied operation options.
     * @param {string} [senderFallback] - The sender used when the route requires a receiver fallback.
     * @returns {Promise<CachedRoute>} The pinned route removed from the cache for one execution attempt.
     * @throws {ButterActionRequiredError} If caller action is required before the operation can continue.
     */
    consumeRouteByHash(hash: string, options: SwidgeOptions, senderFallback?: string): Promise<CachedRoute>;
    /** @private */
    private evictStaleRoutes;
    /** @private */
    private evict;
    /**
     * Builds the `/route` query, and returns the source-token decimals it resolved
     * alongside it.
     *
     * Those decimals are the trusted ones — from `config.tokenDecimals`, `/findToken`,
     * or the chain's native default — and they are what converted the caller's base
     * units into Butter's decimal `amount`. They are returned rather than recomputed
     * so fee valuation can use exactly the same number instead of the route's own
     * `srcChain.tokenIn.decimals`, which is untrusted.
     *
     * @param {SwidgeOptions} options - The caller-supplied operation options.
     * @param {string} [senderFallback] - The sender used when the route requires a receiver fallback.
     * @returns {Promise<RouteRequestResult>} The normalized request and trusted source-token decimals.
     * @throws {ButterActionRequiredError} If caller action is required before the operation can continue.
     * @throws {ButterConfigurationError} If required provider configuration is missing or invalid.
     * @throws {ButterExactOutUnsupportedError} If an exact-out operation is requested.
     */
    buildRouteRequest(options: SwidgeOptions, senderFallback?: string): Promise<RouteRequestResult>;
    /**
     * Enforces min amount out.
     *
     * @param {SwidgeOptions} options - The caller-supplied operation options.
     * @param {ButterRoute} route - The Butter route to inspect or map.
     * @returns {void} Nothing; the function throws when validation fails.
     * @throws {ButterActionRequiredError} If caller action is required before the operation can continue.
     */
    enforceMinAmountOut(options: SwidgeOptions, route: ButterRoute): void;
    /** @private */
    private decimalsFor;
    /** @private */
    private validateRouteMatchesRequest;
}
/**
 * Returns the conservative expiry timestamp for a Butter route.
 *
 * @param {ButterRoute} route - The Butter route to inspect or map.
 * @param {number} now - The current Unix timestamp in seconds.
 * @returns {number} The conservative Unix expiry timestamp in seconds.
 * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
 */
export declare function routeExpiresAt(route: ButterRoute, now: number): number;
/**
 * Reads a route token's decimals, requiring them to be present and valid.
 *
 * Butter always echoes token decimals on a route; a missing value indicates
 * malformed data, so we fail rather than silently defaulting to 18 (which
 * would misscale amounts by orders of magnitude).
 *
 * @param {{ decimals?: string | number } | undefined} token - The token identifier or metadata to process.
 * @param {string} [label] - The human-readable label used in validation errors (default: 'token').
 * @returns {number} The validated token decimal count.
 * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
 */
export declare function decimalsOf(token: {
    decimals?: string | number;
} | undefined, label?: string): number;
export {};
//# sourceMappingURL=route.d.ts.map