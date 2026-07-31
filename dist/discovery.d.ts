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
     * An entry is trusted only when **both** its chain and its address match what was
     * asked for. `/findToken` matches by address and ignores the `chainId` parameter,
     * so one address deployed on several chains returns several entries — but that is
     * a description of Butter's behaviour, not a verified property of the response.
     * Filtering on the chain alone (which an earlier revision did, on the reasoning
     * that the address "must" already be right) let a same-chain entry for a
     * *different* token supply the decimals. That matters far beyond discovery: this
     * value becomes `FeeContext.sourceTokenDecimals` via `route.ts: decimalsFor`, and
     * it is the number a source-denominated fee is parsed with while the denominator
     * is the caller's real base units. A `decimals: 0` answer for the wrong token
     * therefore understates a fee by orders of magnitude and slips it under a bps cap
     * — the same bypass `trustedSourceDecimals` exists to close, reached through this
     * door instead.
     *
     * Successful resolutions are cached until LRU eviction. An affirmative not-found
     * is cached briefly to avoid hammering Butter, then retried; malformed metadata is
     * never cached. A response that simply does not contain the requested token is
     * inconclusive and is not cached either.
     *
     * Transport/auth failures rethrow so a network blip is not misreported as an
     * unknown token.
     */
    findTokenDecimals(chainId: string, address: string): Promise<number | undefined>;
    private now;
    private touchTokenDecimalsCache;
    private setTokenDecimalsCache;
    getSupportedTokens(chainId: string): Promise<SwidgeSupportedToken[]>;
    private networkKeyForChain;
}
//# sourceMappingURL=discovery.d.ts.map