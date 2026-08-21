import { type ButterRouterRegistry } from './router-registry.js';
import type { ButterSupportedChain, ButterSwidgeProtocolConfig, SwidgeSupportedToken } from './types.js';
export declare class DiscoveryService {
    private readonly config;
    private readonly requestRouter;
    private readonly requestToken;
    private readonly strictSlippageChainIds;
    private readonly routerRegistry;
    private readonly tokenDecimalsCache;
    /**
     * Creates a discovery service instance.
     *
     * @param {ButterSwidgeProtocolConfig} config - The configuration used by the operation.
     * @param {<T>(path: string, params?: Record<string, unknown>) => Promise<T>} requestRouter - The injected requester for Butter Router endpoints.
     * @param {<T>(path: string, params?: Record<string, unknown>) => Promise<T>} requestToken - The injected requester for Butter token endpoints.
     * @param {Set<string>} strictSlippageChainIds - The chain identifiers requiring the strict slippage floor.
     * @param {ButterRouterRegistry} routerRegistry - The allowlisted Router deployments used to classify execution.
     */
    constructor(config: ButterSwidgeProtocolConfig, requestRouter: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, requestToken: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, strictSlippageChainIds: Set<string>, routerRegistry: ButterRouterRegistry);
    /**
     * Returns the chains currently advertised by Butter with this provider's execution capability.
     *
     * @returns {Promise<ButterSupportedChain[]>} The resolved result.
     */
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
     *
     * @param {string} chainId - The chain identifier used for normalization or lookup.
     * @param {string} address - The address or identifier to process.
     * @returns {Promise<number | undefined>} The resolved result.
     * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
     */
    findTokenDecimals(chainId: string, address: string): Promise<number | undefined>;
    /** @private */
    private now;
    /** @private */
    private touchTokenDecimalsCache;
    /** @private */
    private setTokenDecimalsCache;
    /**
     * Returns Butter's non-exhaustive token catalog for the selected chain.
     *
     * @param {string} chainId - The chain identifier used for normalization or lookup.
     * @returns {Promise<SwidgeSupportedToken[]>} The resolved result.
     * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
     */
    getSupportedTokens(chainId: string): Promise<SwidgeSupportedToken[]>;
}
//# sourceMappingURL=discovery.d.ts.map