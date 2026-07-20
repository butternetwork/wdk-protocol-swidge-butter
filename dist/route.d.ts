import type { ButterRoute, CachedRoute, SwidgeOptions } from './types.js';
export interface RouteRequestContext {
    sourceChainId: string;
    entrance: string;
    now: () => number;
    tokenDecimals: Record<string, number>;
    requestRoute: (params: Record<string, unknown>) => Promise<ButterRoute[] | ButterRoute>;
}
export declare class RouteManager {
    private readonly context;
    private readonly cache;
    constructor(context: RouteRequestContext);
    getRoute(options: SwidgeOptions, { forExecution }?: {
        forExecution?: boolean;
    }): Promise<CachedRoute>;
    buildRouteRequest(options: SwidgeOptions): Record<string, unknown>;
    enforceMinAmountOut(options: SwidgeOptions, route: ButterRoute): void;
    private decimalsFor;
    private validateRouteMatchesRequest;
}
export declare function routeExpiresAt(route: ButterRoute, now: number): number;
export declare function decimalsOf(token: {
    decimals?: string | number;
} | undefined): number;
//# sourceMappingURL=route.d.ts.map