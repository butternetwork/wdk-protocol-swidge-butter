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
import { normalizeIdentifier, sameIdentifier } from './identifiers.js';
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
     * Only **conclusive** outcomes are cached: an affirmative not-found from Butter, or
     * our token found with unusable decimals. A response that simply does not contain
     * the requested token is inconclusive and is not cached, so one bad response
     * cannot pin every later quote for that token to "configure tokenDecimals" for the
     * lifetime of the process.
     *
     * Transport/auth failures rethrow so a network blip is not misreported as an
     * unknown token.
     */
    async findTokenDecimals(chainId, address) {
        // Lowercasing the whole key merged two Base58 mints differing only in case, so
        // one mint's decimals could be served for the other.
        const key = `${chainId}:${normalizeIdentifier(address)}`;
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
        // Chain AND address. `sameIdentifier` rather than a lowercase compare because
        // /findToken is exactly where a Base58 Solana mint arrives, and two casings of
        // one are two different mints.
        const token = list.find((entry) => normalizeId(entry.chainId) === normalizeId(chainId) &&
            sameIdentifier(entry.address ?? entry.token, address));
        if (!token) {
            // Inconclusive, not a confirmed miss: the response said nothing about this
            // token. Caching it would fix the failure in place for the whole process.
            return undefined;
        }
        const decimals = Number(token.decimals ?? token.decimal);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
            // Conclusive: this IS our token, and its decimals are unusable.
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
        // Distinct raw records consumed, before filtering — the only quantity
        // comparable to Butter's advertised `count`.
        let consumed = 0;
        const seen = new Set();
        /** Raw record identities, so a replayed page is detected rather than counted. */
        const rawSeen = new Set();
        const maxPages = 1000;
        while (true) {
            if (pageNo > maxPages)
                throw new ButterApiError(`Butter token pagination exceeded ${maxPages} pages`);
            const data = await this.requestToken('/api/queryTokenList', {
                network,
                pageNo,
                pageSize: 100
            });
            // `results` drives the loop, so its shape is a trust boundary: a non-array made
            // `results.length` undefined and surfaced later as a raw TypeError from
            // `for...of` rather than as this package's own error.
            if (data.results != null && !Array.isArray(data.results)) {
                throw new ButterApiError('Butter token list returned a non-array results payload', { pageNo });
            }
            const results = data.results ?? [];
            // Pin the advertised total to the FIRST page. Re-reading it every page let a
            // later response shrink it, ending the walk early with a partial list and no
            // error at all.
            if (count == null) {
                // Validate before trusting it as the termination bound: `count: -1` satisfies
                // `consumed >= count` after the very first page, so the walk stopped with a
                // partial list, no further requests, and no error at all.
                if (data.count != null && (!Number.isSafeInteger(data.count) || data.count < 0)) {
                    throw new ButterApiError('Butter token list advertised an invalid record count', {
                        pageNo,
                        count: data.count
                    });
                }
                count = data.count;
            }
            else if (data.count != null && data.count !== count) {
                throw new ButterApiError('Butter token pagination changed its advertised count mid-walk', {
                    pageNo,
                    count,
                    reported: data.count
                });
            }
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
            // Keys seen on THIS page, so an in-page duplicate is not mistaken for a repeat
            // of an earlier page.
            const pageKeys = new Set();
            // Two separate questions, previously conflated into one counter.
            //
            // How far through the list are we? `count` counts RAW rows, so `consumed` must
            // too — a page legitimately containing the same token twice still consumed both
            // slots, and counting distinct records instead made such a page fall short of
            // `count` and abort the whole walk.
            //
            // Is the server actually paginating? That is a different test: a record already
            // returned on an EARLIER page means the walk is going in circles or the list
            // shifted underneath it, and either way `consumed` would reach `count` without
            // the tail ever being fetched. Repeats within one page are fine; repeats across
            // pages are not.
            for (const item of results) {
                const rawKey = rawRecordKey(item);
                if (rawSeen.has(rawKey) && !pageKeys.has(rawKey)) {
                    throw new ButterApiError('Butter token pagination returned a record from an earlier page', {
                        pageNo,
                        count,
                        consumed,
                        received: tokens.length
                    });
                }
                pageKeys.add(rawKey);
                rawSeen.add(rawKey);
            }
            consumed += results.length;
            for (const token of results.map((item) => tokenToSupportedToken(item, chainId))) {
                // Fail closed per token: drop entries lacking a usable identifier or
                // valid decimals rather than surfacing a placeholder ('' / 18).
                if (!token.token || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255)
                    continue;
                // Format-aware: two Base58 mints differing only in case are two tokens, and
                // lowercasing collapsed them so only the first was ever returned.
                const key = `${token.chain}:${normalizeIdentifier(token.token)}`;
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
/**
 * Identity of a raw `/api/queryTokenList` record, used only to tell a fresh page
 * from a replayed one.
 *
 * Falls back to the whole record when no address-like field is present: an entry
 * that cannot be identified must not silently collide with another and be mistaken
 * for a repeat, which would abort a perfectly good walk.
 */
function rawRecordKey(item) {
    const address = (item?.address ?? item?.token)?.trim();
    if (address)
        return `${String(item?.chainId ?? '')}:${normalizeIdentifier(address)}`;
    try {
        return JSON.stringify(item);
    }
    catch {
        return String(item);
    }
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