import { type ButterRouterRegistry } from './router-registry.js';
import type { ButterSupportedChain, ButterSwidgeProtocolConfig, SwidgeSupportedToken } from './types.js';
export declare class DiscoveryService {
    private readonly config;
    private readonly requestRouter;
    private readonly requestToken;
    private readonly strictSlippageChainIds;
    private readonly routerRegistry;
    private readonly tokenDecimalsCache;
    private chainDetails?;
    private chainDetailsPromise;
    constructor(config: ButterSwidgeProtocolConfig, requestRouter: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, requestToken: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, strictSlippageChainIds: Set<string>, routerRegistry: ButterRouterRegistry);
    getSupportedChains(): Promise<ButterSupportedChain[]>;
    /**
     * Resolves a token's decimals via Butter's `/findToken` router API.
     *
     * `/findToken` matches by address and ignores the `chainId` parameter, so a
     * token deployed at the same address on multiple chains returns several
     * entries. We must filter by `token.chainId` and only trust the entry for the
     * requested chain — never blindly the first result, whose decimals could be
     * from another chain.
     *
     * Results, including confirmed misses, are cached per chain and address.
     * Transport/auth failures rethrow so a network blip is not misreported as an
     * unknown token.
     */
    findTokenDecimals(chainId: string, address: string): Promise<number | undefined>;
    getSupportedTokens(chainId: string): Promise<SwidgeSupportedToken[]>;
    private networkKeyForChain;
}
//# sourceMappingURL=discovery.d.ts.map