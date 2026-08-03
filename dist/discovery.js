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
import { TOKEN_DECIMALS_CACHE_MAX_ENTRIES, TOKEN_DECIMALS_NOT_FOUND_TTL_SECONDS, TOKEN_NOT_FOUND_ERRNO, TRON_CHAIN_ID } from './constants.js';
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
    tokenDecimalsCache = new Map();
    constructor(config, requestRouter, requestToken, strictSlippageChainIds, routerRegistry) {
        this.config = config;
        this.requestRouter = requestRouter;
        this.requestToken = requestToken;
        this.strictSlippageChainIds = strictSlippageChainIds;
        this.routerRegistry = routerRegistry;
    }
    async getSupportedChains() {
        const [routerPayload, tokenPayload] = await Promise.all([
            this.requestRouter('/supportedChainInfo'),
            this.requestToken('/api/queryChainList')
        ]);
        const routerChains = recordArray(routerPayload, 'Butter supported-chain list');
        const tokenEnvelope = requiredRecord(tokenPayload, 'Butter token-chain envelope');
        const tokenChains = optionalRecordArray(tokenEnvelope.chains, 'Butter token-chain list');
        const chainDetails = new Map();
        for (const chain of tokenChains) {
            chainDetails.set(normalizeId(chain.chainId ?? chain.id), chain);
        }
        return routerChains
            .map((chain) => {
            const id = normalizeId(chain.chainId ?? chain.id);
            const detail = chainDetails.get(id) ?? chain;
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
     * Successful resolutions are cached until LRU eviction. An affirmative not-found
     * is cached briefly to avoid hammering Butter, then retried; malformed metadata is
     * never cached. A response that simply does not contain the requested token is
     * inconclusive and is not cached either.
     *
     * Transport/auth failures rethrow so a network blip is not misreported as an
     * unknown token.
     */
    async findTokenDecimals(chainId, address) {
        // Lowercasing the whole key merged two Base58 mints differing only in case, so
        // one mint's decimals could be served for the other.
        const key = `${chainId}:${normalizeIdentifier(address)}`;
        const cached = this.tokenDecimalsCache.get(key);
        if (cached) {
            if (cached.kind === 'not-found' && cached.expiresAt <= this.now()) {
                this.tokenDecimalsCache.delete(key);
            }
            else {
                this.touchTokenDecimalsCache(key, cached);
                return cached.kind === 'resolved' ? cached.decimals : undefined;
            }
        }
        let data;
        try {
            data = await this.requestRouter('/findToken', { chainId, address });
        }
        catch (error) {
            if (isTokenNotFound(error)) {
                this.setTokenDecimalsCache(key, {
                    kind: 'not-found',
                    expiresAt: this.now() + TOKEN_DECIMALS_NOT_FOUND_TTL_SECONDS
                });
                return undefined;
            }
            throw error;
        }
        const matches = [];
        for (const entry of findTokenRecords(data)) {
            const candidateChain = scalarChainId(entry.chainId);
            const candidateAddress = tokenIdentifier(entry);
            if (candidateChain == null || candidateAddress == null)
                continue;
            // Chain AND address. `sameIdentifier` rather than a lowercase compare because
            // /findToken is exactly where a Base58 Solana mint arrives, and two casings of
            // one are two different mints.
            if (normalizeId(candidateChain) !== normalizeId(chainId) || !sameIdentifier(candidateAddress, address))
                continue;
            const decimals = parseDiscoveryDecimals(entry.decimals ?? entry.decimal);
            const aliasDecimals = entry.decimals != null && entry.decimal != null
                ? parseDiscoveryDecimals(entry.decimal)
                : decimals;
            if (decimals == null || aliasDecimals == null) {
                throw new ButterApiError('Butter /findToken returned invalid decimals for the requested token', {
                    chainId,
                    address,
                    entry
                });
            }
            if (aliasDecimals !== decimals) {
                throw new ButterApiError('Butter /findToken returned conflicting decimals for the requested token', {
                    chainId,
                    address,
                    entry
                });
            }
            matches.push({ decimals, entry });
        }
        const firstMatch = matches[0];
        if (!firstMatch) {
            // Inconclusive, not a confirmed miss: the response said nothing about this
            // token. Caching it would fix the failure in place for the whole process.
            return undefined;
        }
        const decimals = firstMatch.decimals;
        if (matches.some((match) => match.decimals !== decimals)) {
            throw new ButterApiError('Butter /findToken returned conflicting decimals for the requested token', {
                chainId,
                address,
                matches
            });
        }
        this.setTokenDecimalsCache(key, { kind: 'resolved', decimals });
        return decimals;
    }
    now() {
        return this.config.now?.() ?? Math.floor(Date.now() / 1000);
    }
    touchTokenDecimalsCache(key, entry) {
        this.tokenDecimalsCache.delete(key);
        this.tokenDecimalsCache.set(key, entry);
    }
    setTokenDecimalsCache(key, entry) {
        this.touchTokenDecimalsCache(key, entry);
        while (this.tokenDecimalsCache.size > TOKEN_DECIMALS_CACHE_MAX_ENTRIES) {
            const oldest = this.tokenDecimalsCache.keys().next().value;
            if (oldest === undefined)
                break;
            this.tokenDecimalsCache.delete(oldest);
        }
    }
    async getSupportedTokens(chainId) {
        const groups = await this.requestRouter('/supportedTokenList', { chainId });
        if (!Array.isArray(groups)) {
            throw new ButterApiError('Butter Router supported-token list returned a non-array payload', groups);
        }
        if (groups.length !== 1 || !isRecord(groups[0]) || normalizeId(groups[0].chainId) !== chainId) {
            throw new ButterApiError('Butter Router supported-token list must return exactly one group for the requested chain', {
                chainId,
                groups
            });
        }
        const group = groups[0];
        if (!Array.isArray(group?.tokens)) {
            throw new ButterApiError('Butter Router supported-token group must contain a token array', {
                chainId,
                group
            });
        }
        const results = recordArray(group.tokens, 'Butter Router supported-token entries');
        const tokens = [];
        const seen = new Set();
        for (const item of results) {
            const token = tokenToSupportedToken(item, chainId);
            if (!token.token || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255)
                continue;
            if (token.chain !== chainId)
                continue;
            const key = `${token.chain}:${normalizeIdentifier(token.token)}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            tokens.push(token);
        }
        return tokens;
    }
}
function findTokenRecords(data) {
    if (data == null)
        return [];
    if (Array.isArray(data)) {
        return data.filter((entry) => isRecord(entry));
    }
    if (isRecord(data))
        return [data];
    throw new ButterApiError('Butter /findToken returned an invalid payload', data);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requiredRecord(value, label) {
    if (!isRecord(value))
        throw new ButterApiError(`${label} returned an invalid payload`, value);
    return value;
}
function recordArray(value, label) {
    if (!Array.isArray(value))
        throw new ButterApiError(`${label} returned a non-array payload`, value);
    return value.filter((entry) => isRecord(entry));
}
function optionalRecordArray(value, label) {
    return value == null ? [] : recordArray(value, label);
}
function scalarChainId(value) {
    if (typeof value === 'string')
        return value.trim() === '' ? undefined : value;
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    return undefined;
}
function tokenIdentifier(entry) {
    for (const value of [entry.address, entry.token]) {
        if (typeof value === 'string' && value.trim() !== '')
            return value;
    }
    return undefined;
}
function parseDiscoveryDecimals(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined;
    }
    if (typeof value !== 'string')
        return undefined;
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized))
        return undefined;
    const decimals = Number(normalized);
    return Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : undefined;
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