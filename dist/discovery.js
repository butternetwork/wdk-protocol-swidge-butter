// Copyright 2026 Butter Network
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import { TRON_CHAIN_ID } from './constants.js';
import { ButterApiError } from './errors.js';
import { chainToSupportedChain, normalizeId, tokenToSupportedToken } from './mappers.js';
import { routerDeploymentsForChain } from './router-registry.js';
export class DiscoveryService {
    config;
    requestRouter;
    requestToken;
    strictSlippageChainIds;
    routerRegistry;
    tokenDecimalsCache = new Map();
    chainDetails;
    constructor(config, requestRouter, requestToken, strictSlippageChainIds, routerRegistry) {
        this.config = config;
        this.requestRouter = requestRouter;
        this.requestToken = requestToken;
        this.strictSlippageChainIds = strictSlippageChainIds;
        this.routerRegistry = routerRegistry;
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
            if (isStrictSlippageChain({ ...chain, ...detail }))
                this.strictSlippageChainIds.add(id);
            return chainToSupportedChain({ ...chain, ...detail }, executionFor(id, this.config, this.routerRegistry));
        });
    }
    /**
     * Resolves a token's decimals via Butter's `/findToken` router API.
     *
     * Results (including confirmed misses) are cached per chain and address.
     * Returns undefined when Butter does not know the token or the response
     * carries no usable decimals.
     */
    async findTokenDecimals(chainId, address) {
        const key = `${chainId}:${address}`.toLowerCase();
        if (this.tokenDecimalsCache.has(key))
            return this.tokenDecimalsCache.get(key);
        let data;
        try {
            data = await this.requestRouter('/findToken', { chainId, address });
        }
        catch {
            return undefined;
        }
        const token = Array.isArray(data) ? data[0] : data;
        const decimals = Number(token?.decimals ?? token?.decimal);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
            return undefined;
        this.tokenDecimalsCache.set(key, decimals);
        return decimals;
    }
    async getSupportedTokens(chainId) {
        const network = await this.networkKeyForChain(chainId);
        const tokens = [];
        let pageNo = 1;
        let count;
        const seen = new Set();
        const maxPages = 1000;
        while (true) {
            if (pageNo > maxPages)
                throw new ButterApiError(`Butter token pagination exceeded ${maxPages} pages`);
            const data = await this.requestToken('/api/queryTokenList', {
                network,
                pageNo,
                pageSize: 100
            });
            const results = data.results ?? [];
            if (data.count != null)
                count = data.count;
            if (results.length === 0 && count != null && tokens.length < count) {
                throw new ButterApiError('Butter token pagination returned an empty page before the advertised count', {
                    pageNo,
                    count,
                    received: tokens.length
                });
            }
            if (results.length === 0)
                break;
            let added = 0;
            for (const token of results.map((item) => tokenToSupportedToken(item, chainId))) {
                const key = `${token.chain}:${token.token}`.toLowerCase();
                if (seen.has(key))
                    continue;
                seen.add(key);
                tokens.push(token);
                added++;
            }
            const moreExpected = count != null ? tokens.length < count : results.length >= 100;
            if (added === 0 && moreExpected) {
                throw new ButterApiError('Butter token pagination made no progress', { pageNo, count, received: tokens.length });
            }
            if (count != null ? tokens.length >= count : results.length < 100)
                break;
            pageNo++;
        }
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
function isStrictSlippageChain(chain) {
    const values = [chain.chainType, chain.type, chain.name, chain.key];
    return values.some((value) => {
        const normalized = String(value ?? '').toLowerCase();
        return normalized === 'btc' || normalized === 'ton' || normalized.includes('bitcoin') || normalized.includes('toncoin');
    });
}
function executionFor(chainId, config, registry) {
    if (chainId === TRON_CHAIN_ID)
        return config.transactionAdapters?.[chainId] ? 'adapter' : 'quote-only';
    if (routerDeploymentsForChain(registry, chainId).length > 0)
        return 'native';
    if (config.transactionAdapters?.[chainId])
        return 'adapter';
    return 'quote-only';
}
//# sourceMappingURL=discovery.js.map