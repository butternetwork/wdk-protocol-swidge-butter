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
import { TOKEN_NOT_FOUND_ERRNO, TRON_CHAIN_ID } from './constants.js';
import { ButterApiError } from './errors.js';
import { chainToSupportedChain, normalizeId, tokenToSupportedToken } from './mappers.js';
import { routerDeploymentsForChain } from './router-registry.js';
export class DiscoveryService {
    config;
    requestRouter;
    requestToken;
    strictSlippageChainIds;
    routerRegistry;
    // null marks a confirmed miss (Butter does not know the token) so it is not
    // re-queried; a number is a resolved decimals value.
    tokenDecimalsCache = new Map();
    chainDetails;
    chainDetailsPromise;
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
        return routerChains
            .map((chain) => {
            const id = normalizeId(chain.chainId ?? chain.id);
            const detail = this.chainDetails?.get(id) ?? chain;
            // Detect strict-slippage chains *before* the filter below: dropping a
            // chain from the listing must never relax its slippage floor, which is
            // consulted by chain id whether or not the chain was listed.
            if (isStrictSlippageChain({ ...chain, ...detail }))
                this.strictSlippageChainIds.add(id);
            return chainToSupportedChain({ ...chain, ...detail }, executionFor(id, this.config, this.routerRegistry));
        })
            // Fail closed per chain, as getSupportedTokens does per token: `type` and
            // `nativeToken` are required by WDK, so a chain missing either is dropped
            // rather than surfaced with an empty value as if it were authoritative.
            .filter((chain) => chain.id !== '' && chain.type !== '' && chain.nativeToken !== '');
    }
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
    async findTokenDecimals(chainId, address) {
        const key = `${chainId}:${address}`.toLowerCase();
        const cached = this.tokenDecimalsCache.get(key);
        if (cached !== undefined)
            return cached ?? undefined;
        let data;
        try {
            data = await this.requestRouter('/findToken', { chainId, address });
        }
        catch (error) {
            if (isTokenNotFound(error)) {
                this.tokenDecimalsCache.set(key, null);
                return undefined;
            }
            throw error;
        }
        const list = Array.isArray(data) ? data : data == null ? [] : [data];
        const token = list.find((entry) => normalizeId(entry.chainId) === normalizeId(chainId));
        const decimals = Number(token?.decimals ?? token?.decimal);
        if (!token || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
            this.tokenDecimalsCache.set(key, null);
            return undefined;
        }
        this.tokenDecimalsCache.set(key, decimals);
        return decimals;
    }
    async getSupportedTokens(chainId) {
        const network = await this.networkKeyForChain(chainId);
        const tokens = [];
        let pageNo = 1;
        let count;
        // Raw records consumed, before filtering — the only quantity comparable to
        // Butter's advertised `count`.
        let consumed = 0;
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
            // Compare Butter's advertised `count` against RAW records consumed, never
            // against `tokens.length`: entries are dropped below (unusable decimals,
            // duplicates), so a filtered total can never reach `count`. Conflating the two
            // made every one of these three checks misfire the moment a single token was
            // dropped — the loop could not terminate, then threw on the final empty page.
            if (results.length === 0 && count != null && consumed < count) {
                throw new ButterApiError('Butter token pagination returned an empty page before the advertised count', {
                    pageNo,
                    count,
                    consumed,
                    received: tokens.length
                });
            }
            if (results.length === 0)
                break;
            // A non-empty page is forward progress by definition, so no separate
            // "made no progress" guard is needed: a page of nothing but duplicates or
            // decimals-less tokens still advances `consumed`. `maxPages` bounds the loop.
            consumed += results.length;
            for (const token of results.map((item) => tokenToSupportedToken(item, chainId))) {
                // Fail closed per token: drop entries lacking a usable identifier or
                // valid decimals rather than surfacing a placeholder ('' / 18).
                if (!token.token || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255)
                    continue;
                const key = `${token.chain}:${token.token}`.toLowerCase();
                if (seen.has(key))
                    continue;
                seen.add(key);
                tokens.push(token);
            }
            if (count != null ? consumed >= count : results.length < 100)
                break;
            pageNo++;
        }
        return tokens;
    }
    async networkKeyForChain(chainId) {
        if (!this.chainDetails) {
            // Dedupe concurrent priming so parallel getSupportedTokens calls share a
            // single discovery request rather than each fetching chain metadata.
            this.chainDetailsPromise ??= this.getSupportedChains().finally(() => {
                this.chainDetailsPromise = undefined;
            });
            await this.chainDetailsPromise;
        }
        const chain = this.chainDetails?.get(chainId);
        return chain?.key ?? chainId;
    }
}
/** True when an error is Butter's "token not found" response, not a transport failure. */
function isTokenNotFound(error) {
    if (!(error instanceof ButterApiError))
        return false;
    const details = error.details;
    return details?.errno === TOKEN_NOT_FOUND_ERRNO;
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