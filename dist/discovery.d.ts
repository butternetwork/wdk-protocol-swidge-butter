import type { ButterSwidgeProtocolConfig, SwidgeSupportedChain, SwidgeSupportedToken } from './types.js';
export declare class DiscoveryService {
    private readonly config;
    private readonly requestRouter;
    private readonly requestToken;
    private readonly strictSlippageChainIds;
    private chainDetails?;
    constructor(config: ButterSwidgeProtocolConfig, requestRouter: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, requestToken: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, strictSlippageChainIds: Set<string>);
    getSupportedChains(): Promise<Array<SwidgeSupportedChain & {
        execution: string;
    }>>;
    getSupportedTokens(chainId: string): Promise<SwidgeSupportedToken[]>;
    private networkKeyForChain;
}
//# sourceMappingURL=discovery.d.ts.map