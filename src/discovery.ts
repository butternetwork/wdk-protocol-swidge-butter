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

import {
  TOKEN_DECIMALS_CACHE_MAX_ENTRIES,
  TOKEN_DECIMALS_NOT_FOUND_TTL_SECONDS,
  TOKEN_NOT_FOUND_ERRNO,
  TRON_CHAIN_ID
} from './constants.js'
import { ButterApiError } from './errors.js'
import { normalizeTokenKey, sameTokenIdentifier } from './identifiers.js'
import { chainToSupportedChain, normalizeId, tokenToSupportedToken } from './mappers.js'
import { routerDeploymentsForChain, type ButterRouterRegistry } from './router-registry.js'
import type { ButterChainExecution, ButterChainInfo, ButterTokenInfo, ButterSupportedChain, ButterSwidgeProtocolConfig, SwidgeSupportedToken } from './types.js'

type TokenDecimalsCacheEntry =
  | { kind: 'resolved', decimals: number }
  | { kind: 'not-found', expiresAt: number }

export class DiscoveryService {
  private readonly config: ButterSwidgeProtocolConfig
  private readonly requestRouter: <T>(path: string, params?: Record<string, unknown>) => Promise<T>
  private readonly requestToken: <T>(path: string, params?: Record<string, unknown>) => Promise<T>
  private readonly strictSlippageChainIds: Set<string>
  private readonly routerRegistry: ButterRouterRegistry
  private readonly tokenDecimalsCache = new Map<string, TokenDecimalsCacheEntry>()

  /**
   * Creates a discovery service instance.
   *
   * @param {ButterSwidgeProtocolConfig} config - The configuration used by the operation.
   * @param {<T>(path: string, params?: Record<string, unknown>) => Promise<T>} requestRouter - The injected requester for Butter Router endpoints.
   * @param {<T>(path: string, params?: Record<string, unknown>) => Promise<T>} requestToken - The injected requester for Butter token endpoints.
   * @param {Set<string>} strictSlippageChainIds - The chain identifiers requiring the strict slippage floor.
   * @param {ButterRouterRegistry} routerRegistry - The allowlisted Router deployments used to classify execution.
   */
  constructor (config: ButterSwidgeProtocolConfig, requestRouter: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, requestToken: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, strictSlippageChainIds: Set<string>, routerRegistry: ButterRouterRegistry) {
    this.config = config
    this.requestRouter = requestRouter
    this.requestToken = requestToken
    this.strictSlippageChainIds = strictSlippageChainIds
    this.routerRegistry = routerRegistry
  }

  /**
   * Returns the chains currently advertised by Butter with this provider's execution capability.
   *
   * @returns {Promise<ButterSupportedChain[]>} The validated WDK chain descriptors advertised by both Butter APIs.
   */
  async getSupportedChains (): Promise<ButterSupportedChain[]> {
    const [routerPayload, tokenPayload] = await Promise.all([
      this.requestRouter<unknown>('/supportedChainInfo'),
      this.requestToken<unknown>('/api/queryChainList')
    ])
    const routerChains = recordArray(routerPayload, 'Butter supported-chain list') as ButterChainInfo[]
    const tokenEnvelope = requiredRecord(tokenPayload, 'Butter token-chain envelope')
    const tokenChains = optionalRecordArray(tokenEnvelope.chains, 'Butter token-chain list') as ButterChainInfo[]
    const chainDetails = new Map<string, ButterChainInfo>()
    for (const chain of tokenChains) {
      chainDetails.set(normalizeId(chain.chainId ?? chain.id), chain)
    }
    return routerChains
      .map((chain) => {
        const id = normalizeId(chain.chainId ?? chain.id)
        const detail = chainDetails.get(id) ?? chain
        // Detect strict-slippage chains *before* the filter below: dropping a
        // chain from the listing must never relax its slippage floor, which is
        // consulted by chain id whether or not the chain was listed.
        if (isStrictSlippageChain({ ...chain, ...detail })) this.strictSlippageChainIds.add(id)
        return chainToSupportedChain({ ...chain, ...detail }, executionFor(id, this.config, this.routerRegistry))
      })
      // Fail closed per chain, as getSupportedTokens does per token: `type` and
      // `nativeToken` are required by WDK, so a chain missing either is dropped
      // rather than surfaced with an empty value as if it were authoritative.
      .filter((chain) => chain.id !== '' && chain.type !== '' && chain.nativeToken !== '')
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
   *
   * @param {string} chainId - The chain identifier used for normalization or lookup.
   * @param {string} address - The requested token address in its chain-specific format.
   * @returns {Promise<number | undefined>} The matching token decimals, or undefined for an affirmative not-found response.
   * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
   */
  async findTokenDecimals (chainId: string, address: string): Promise<number | undefined> {
    // The key is chain-aware: Solana Base58 stays exact, while valid equivalent
    // Tron Base58Check/hex representations share one cache entry.
    const key = `${chainId}:${normalizeTokenKey(chainId, address)}`
    const cached = this.tokenDecimalsCache.get(key)
    if (cached) {
      if (cached.kind === 'not-found' && cached.expiresAt <= this.now()) {
        this.tokenDecimalsCache.delete(key)
      } else {
        this.touchTokenDecimalsCache(key, cached)
        return cached.kind === 'resolved' ? cached.decimals : undefined
      }
    }

    let data: unknown
    try {
      data = await this.requestRouter<unknown>('/findToken', { chainId, address })
    } catch (error) {
      if (isTokenNotFound(error)) {
        this.setTokenDecimalsCache(key, {
          kind: 'not-found',
          expiresAt: this.now() + TOKEN_DECIMALS_NOT_FOUND_TTL_SECONDS
        })
        return undefined
      }
      throw error
    }
    const matches: { decimals: number, entry: Record<string, unknown> }[] = []
    for (const entry of findTokenRecords(data)) {
      const candidateChain = scalarChainId(entry.chainId)
      const candidateAddress = tokenIdentifier(entry)
      if (candidateChain == null || candidateAddress == null) continue
      // Chain AND token identity. Solana Base58 remains exact; Tron is compared only
      // after checksum/length-validated conversion to its 20-byte account id.
      if (normalizeId(candidateChain) !== normalizeId(chainId) || !sameTokenIdentifier(chainId, candidateAddress, address)) continue
      const decimals = parseDiscoveryDecimals(entry.decimals ?? entry.decimal)
      const aliasDecimals = entry.decimals != null && entry.decimal != null
        ? parseDiscoveryDecimals(entry.decimal)
        : decimals
      if (decimals == null || aliasDecimals == null) {
        throw new ButterApiError('Butter /findToken returned invalid decimals for the requested token', {
          chainId,
          address,
          entry
        })
      }
      if (aliasDecimals !== decimals) {
        throw new ButterApiError('Butter /findToken returned conflicting decimals for the requested token', {
          chainId,
          address,
          entry
        })
      }
      matches.push({ decimals, entry })
    }
    const firstMatch = matches[0]
    if (!firstMatch) {
      // Inconclusive, not a confirmed miss: the response said nothing about this
      // token. Caching it would fix the failure in place for the whole process.
      return undefined
    }
    const decimals = firstMatch.decimals
    if (matches.some((match) => match.decimals !== decimals)) {
      throw new ButterApiError('Butter /findToken returned conflicting decimals for the requested token', {
        chainId,
        address,
        matches
      })
    }
    this.setTokenDecimalsCache(key, { kind: 'resolved', decimals })
    return decimals
  }

  /** @private */
  private now (): number {
    return this.config.now?.() ?? Math.floor(Date.now() / 1000)
  }

  /** @private */
  private touchTokenDecimalsCache (key: string, entry: TokenDecimalsCacheEntry): void {
    this.tokenDecimalsCache.delete(key)
    this.tokenDecimalsCache.set(key, entry)
  }

  /** @private */
  private setTokenDecimalsCache (key: string, entry: TokenDecimalsCacheEntry): void {
    this.touchTokenDecimalsCache(key, entry)
    while (this.tokenDecimalsCache.size > TOKEN_DECIMALS_CACHE_MAX_ENTRIES) {
      const oldest = this.tokenDecimalsCache.keys().next().value
      if (oldest === undefined) break
      this.tokenDecimalsCache.delete(oldest)
    }
  }

  /**
   * Returns Butter's non-exhaustive token catalog for the selected chain.
   *
   * @param {string} chainId - The chain identifier used for normalization or lookup.
   * @returns {Promise<SwidgeSupportedToken[]>} The deduplicated, valid token descriptors for the requested chain.
   * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
   */
  async getSupportedTokens (chainId: string): Promise<SwidgeSupportedToken[]> {
    const groups = await this.requestRouter<unknown>('/supportedTokenList', { chainId })
    if (!Array.isArray(groups)) {
      throw new ButterApiError('Butter Router supported-token list returned a non-array payload', groups)
    }
    if (groups.length !== 1 || !isRecord(groups[0]) || normalizeId(groups[0].chainId as string | number | undefined) !== chainId) {
      throw new ButterApiError('Butter Router supported-token list must return exactly one group for the requested chain', {
        chainId,
        groups
      })
    }
    const group = groups[0]
    if (!Array.isArray(group?.tokens)) {
      throw new ButterApiError('Butter Router supported-token group must contain a token array', {
        chainId,
        group
      })
    }
    const results = recordArray(group.tokens, 'Butter Router supported-token entries')
    const tokens = new Map<string, SwidgeSupportedToken>()
    for (const item of results) {
      const token = tokenToSupportedToken(item as ButterTokenInfo, chainId)
      if (!token.token || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) continue
      if (token.chain !== chainId) continue
      const key = `${token.chain}:${normalizeTokenKey(token.chain, token.token)}`
      const existing = tokens.get(key)
      if (existing != null) {
        if (existing.decimals !== token.decimals) {
          throw new ButterApiError('Butter supported-token list returned conflicting decimals for the same token', {
            chainId,
            token: token.token,
            decimals: [existing.decimals, token.decimals]
          })
        }
        continue
      }
      tokens.set(key, token)
    }
    // Seed only after the whole response is validated. A later canonical duplicate
    // with conflicting decimals must not leave an earlier value cached.
    for (const [key, token] of tokens) {
      this.setTokenDecimalsCache(key, { kind: 'resolved', decimals: token.decimals })
    }
    return [...tokens.values()]
  }

}

/**
 * Finds token records in the supplied data.
 *
 * @param {unknown} data - The partially trusted data to inspect.
 * @returns {Record<string, unknown>[]} The matching token records.
 * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
 */
function findTokenRecords (data: unknown): Record<string, unknown>[] {
  if (data == null) return []
  if (Array.isArray(data)) {
    return data.filter((entry): entry is Record<string, unknown> => isRecord(entry))
  }
  if (isRecord(data)) return [data]
  throw new ButterApiError('Butter /findToken returned an invalid payload', data)
}

/**
 * Returns whether the value is a non-null, non-array record.
 *
 * @param {unknown} value - The candidate Butter response value.
 * @returns {boolean} Whether the value is a non-null object and not an array.
 */
function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Returns a required record from a Butter response or rejects the malformed payload.
 *
 * @param {unknown} value - The Butter payload expected to be an object.
 * @param {string} label - The human-readable label used in validation errors.
 * @returns {Record<string, unknown>} The validated response record.
 * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
 */
function requiredRecord (value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ButterApiError(`${label} returned an invalid payload`, value)
  return value
}

/**
 * Returns a required array containing only record values.
 *
 * @param {unknown} value - The Butter payload expected to be an array.
 * @param {string} label - The human-readable label used in validation errors.
 * @returns {Record<string, unknown>[]} The validated record array.
 * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
 */
function recordArray (value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new ButterApiError(`${label} returned a non-array payload`, value)
  return value.filter((entry): entry is Record<string, unknown> => isRecord(entry))
}

/**
 * Returns an optional record array, treating an absent value as empty.
 *
 * @param {unknown} value - The optional Butter payload expected to be an array when present.
 * @param {string} label - The human-readable label used in validation errors.
 * @returns {Record<string, unknown>[]} The record array, or an empty array when absent.
 */
function optionalRecordArray (value: unknown, label: string): Record<string, unknown>[] {
  return value == null ? [] : recordArray(value, label)
}

/**
 * Extracts a scalar chain identifier from partially trusted metadata.
 *
 * @param {unknown} value - The partially trusted chain-id field.
 * @returns {string | number | undefined} The scalar chain identifier, or undefined when unusable.
 */
function scalarChainId (value: unknown): string | number | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

/**
 * Returns the first usable token address or identifier in a discovery entry.
 *
 * @param {Record<string, unknown>} entry - The cache or API entry to inspect.
 * @returns {string | undefined} The usable token identifier, or undefined when none is present.
 */
function tokenIdentifier (entry: Record<string, unknown>): string | undefined {
  for (const value of [entry.address, entry.token]) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * Parses a discovery decimal field while enforcing the 0 through 255 range.
 *
 * @param {unknown} value - The number or decimal string returned by Butter.
 * @returns {number | undefined} The validated decimal count, or undefined for malformed metadata.
 */
function parseDiscoveryDecimals (value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined
  }
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) return undefined
  const decimals = Number(normalized)
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : undefined
}

/**
 * True when an error is Butter's "token not found" response, not a transport failure.
 *
 * @param {unknown} error - The error value to classify.
 * @returns {boolean} Whether the error is Butter's affirmative token-not-found response.
 */
function isTokenNotFound (error: unknown): boolean {
  if (!(error instanceof ButterApiError)) return false
  const details = error.details as { errno?: number } | undefined
  return details?.errno === TOKEN_NOT_FOUND_ERRNO
}

/**
 * Returns whether Butter metadata identifies a chain with the strict slippage floor.
 *
 * @param {ButterChainInfo} chain - The chain metadata to inspect.
 * @returns {boolean} Whether the chain metadata names Bitcoin and requires the strict floor.
 */
function isStrictSlippageChain (chain: ButterChainInfo): boolean {
  const values = [chain.chainType, chain.type, chain.name, chain.key]
  return values.some((value) => {
    const normalized = String(value ?? '').toLowerCase()
    return normalized === 'btc' || normalized.includes('bitcoin')
  })
}

/**
 * Returns the execution capability available for a discovered chain.
 *
 * @param {string} chainId - The chain identifier used for normalization or lookup.
 * @param {ButterSwidgeProtocolConfig} config - The configuration used by the operation.
 * @param {ButterRouterRegistry} registry - The effective Butter Router allowlist.
 * @returns {ButterChainExecution} The chain execution capability for this provider instance.
 */
function executionFor (chainId: string, config: ButterSwidgeProtocolConfig, registry: ButterRouterRegistry): ButterChainExecution {
  if (chainId === TRON_CHAIN_ID) return config.transactionAdapters?.[chainId] ? 'adapter' : 'quote-only'
  if (routerDeploymentsForChain(registry, chainId).length > 0) return 'native'
  if (config.transactionAdapters?.[chainId]) return 'adapter'
  return 'quote-only'
}
