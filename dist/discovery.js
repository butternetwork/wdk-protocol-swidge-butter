import { TRON_CHAIN_ID } from './constants.js';
import { chainToSupportedChain, normalizeId, tokenToSupportedToken } from './mappers.js';
import { createRouterRegistry, routerDeploymentsForChain } from './router-registry.js';
export class DiscoveryService {
    config;
    requestRouter;
    requestToken;
    chainDetails;
    constructor(config, requestRouter, requestToken) {
        this.config = config;
        this.requestRouter = requestRouter;
        this.requestToken = requestToken;
    }
    async getSupportedChains() {
        const [routerChains, tokenChains] = await Promise.all([
            this.requestRouter('/supportedChainInfo'),
            this.requestToken('/api/queryChainList')
        ]);
        this.chainDetails = new Map();
        for (const chain of tokenChains.chains ?? []) {
            this.chainDetails.set(normalizeId(chain.chainId ?? chain.id), chain);
        }
        return routerChains.map((chain) => {
            const id = normalizeId(chain.chainId ?? chain.id);
            const detail = this.chainDetails?.get(id) ?? chain;
            return chainToSupportedChain({ ...chain, ...detail }, executionFor(id, this.config));
        });
    }
    async getSupportedTokens(chainId) {
        const network = await this.networkKeyForChain(chainId);
        const tokens = [];
        let pageNo = 1;
        let count = 0;
        do {
            const data = await this.requestToken('/api/queryTokenList', {
                network,
                pageNo,
                pageSize: 100
            });
            count = data.count ?? data.results?.length ?? 0;
            tokens.push(...(data.results ?? []).map((token) => tokenToSupportedToken(token, chainId)));
            pageNo++;
        } while (tokens.length < count);
        return tokens;
    }
    async networkKeyForChain(chainId) {
        if (!this.chainDetails) {
            await this.getSupportedChains();
        }
        const chain = this.chainDetails?.get(chainId);
        return chain?.key ?? chainId;
    }
}
function executionFor(chainId, config) {
    if (chainId === TRON_CHAIN_ID)
        return config.transactionAdapters?.[chainId] ? 'adapter' : 'quote-only';
    if (routerDeploymentsForChain(createRouterRegistry(config.routerContracts), chainId).length > 0)
        return 'native';
    if (config.transactionAdapters?.[chainId])
        return 'adapter';
    return config.exposeQuoteOnlyChains ? 'quote-only' : 'unsupported';
}
//# sourceMappingURL=discovery.js.map