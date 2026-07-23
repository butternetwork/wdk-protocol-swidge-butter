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
     * Results, including confirmed misses (Butter does not know the token), are
     * cached per chain and address so an unknown token is queried only once.
     * Returns undefined on a genuine miss. Transport/auth failures are *not*
     * swallowed — they rethrow so a network blip is not misreported as an
     * unknown token.
     */
    findTokenDecimals(chainId: string, address: string): Promise<number | undefined>;
    getSupportedTokens(chainId: string): Promise<SwidgeSupportedToken[]>;
    private networkKeyForChain;
}
//# sourceMappingURL=discovery.d.ts.map