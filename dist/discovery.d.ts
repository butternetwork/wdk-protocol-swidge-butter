import { type ButterRouterRegistry } from './router-registry.js';
import type { ButterSwidgeProtocolConfig, SwidgeSupportedChain, SwidgeSupportedToken } from './types.js';
export declare class DiscoveryService {
    private readonly config;
    private readonly requestRouter;
    private readonly requestToken;
    private readonly strictSlippageChainIds;
    private readonly routerRegistry;
    private readonly tokenDecimalsCache;
    private chainDetails?;
    constructor(config: ButterSwidgeProtocolConfig, requestRouter: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, requestToken: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, strictSlippageChainIds: Set<string>, routerRegistry: ButterRouterRegistry);
    getSupportedChains(): Promise<Array<SwidgeSupportedChain & {
        execution: string;
    }>>;
    /**
     * Resolves a token's decimals via Butter's `/findToken` router API.
     *
     * Results (including confirmed misses) are cached per chain and address.
     * Returns undefined when Butter does not know the token or the response
     * carries no usable decimals.
     */
    findTokenDecimals(chainId: string, address: string): Promise<number | undefined>;
    getSupportedTokens(chainId: string): Promise<SwidgeSupportedToken[]>;
    private networkKeyForChain;
}
//# sourceMappingURL=discovery.d.ts.map