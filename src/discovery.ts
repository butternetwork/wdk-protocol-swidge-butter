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

import { TOKEN_NOT_FOUND_ERRNO, TRON_CHAIN_ID } from './constants.js'
import { ButterApiError } from './errors.js'
import { chainToSupportedChain, normalizeId, tokenToSupportedToken } from './mappers.js'
import { routerDeploymentsForChain, type ButterRouterRegistry } from './router-registry.js'
import type { ButterChainExecution, ButterChainInfo, ButterTokenInfo, ButterSupportedChain, ButterSwidgeProtocolConfig, SwidgeSupportedToken } from './types.js'

export class DiscoveryService {
  private readonly config: ButterSwidgeProtocolConfig
  private readonly requestRouter: <T>(path: string, params?: Record<string, unknown>) => Promise<T>
  private readonly requestToken: <T>(path: string, params?: Record<string, unknown>) => Promise<T>
  private readonly strictSlippageChainIds: Set<string>
  private readonly routerRegistry: ButterRouterRegistry
  // null marks a confirmed miss (Butter does not know the token) so it is not
  // re-queried; a number is a resolved decimals value.
  private readonly tokenDecimalsCache = new Map<string, number | null>()
  private chainDetails?: Map<string, ButterChainInfo>
  private chainDetailsPromise: Promise<unknown> | undefined

  constructor (config: ButterSwidgeProtocolConfig, requestRouter: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, requestToken: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, strictSlippageChainIds: Set<string>, routerRegistry: ButterRouterRegistry) {
    this.config = config
    this.requestRouter = requestRouter
    this.requestToken = requestToken
    this.strictSlippageChainIds = strictSlippageChainIds
    this.routerRegistry = routerRegistry
  }

  async getSupportedChains (): Promise<ButterSupportedChain[]> {
    const [routerChains, tokenChains] = await Promise.all([
      this.requestRouter<ButterChainInfo[]>('/supportedChainInfo'),
      this.requestToken<{ chains?: ButterChainInfo[] }>('/api/queryChainList')
    ])
    this.chainDetails = new Map()
    for (const chain of tokenChains.chains ?? []) {
      this.chainDetails.set(normalizeId(chain.chainId ?? chain.id), chain)
    }
    return routerChains
      .map((chain) => {
        const id = normalizeId(chain.chainId ?? chain.id)
        const detail = this.chainDetails?.get(id) ?? chain
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
  async findTokenDecimals (chainId: string, address: string): Promise<number | undefined> {
    const key = `${chainId}:${address}`.toLowerCase()
    const cached = this.tokenDecimalsCache.get(key)
    if (cached !== undefined) return cached ?? undefined

    let data: ButterTokenInfo | ButterTokenInfo[] | undefined
    try {
      data = await this.requestRouter<ButterTokenInfo | ButterTokenInfo[]>('/findToken', { chainId, address })
    } catch (error) {
      if (isTokenNotFound(error)) {
        this.tokenDecimalsCache.set(key, null)
        return undefined
      }
      throw error
    }
    const list = Array.isArray(data) ? data : data == null ? [] : [data]
    const token = list.find((entry) => normalizeId(entry.chainId) === normalizeId(chainId))
    const decimals = Number(token?.decimals ?? token?.decimal)
    if (!token || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      this.tokenDecimalsCache.set(key, null)
      return undefined
    }
    this.tokenDecimalsCache.set(key, decimals)
    return decimals
  }

  async getSupportedTokens (chainId: string): Promise<SwidgeSupportedToken[]> {
    const network = await this.networkKeyForChain(chainId)
    const tokens: SwidgeSupportedToken[] = []
    let pageNo = 1
    let count: number | undefined
    const seen = new Set<string>()
    const maxPages = 1000
    while (true) {
      if (pageNo > maxPages) throw new ButterApiError(`Butter token pagination exceeded ${maxPages} pages`)
      const data = await this.requestToken<{ count?: number, results?: ButterTokenInfo[] }>('/api/queryTokenList', {
        network,
        pageNo,
        pageSize: 100
      })
      const results = data.results ?? []
      if (data.count != null) count = data.count
      if (results.length === 0 && count != null && tokens.length < count) {
        throw new ButterApiError('Butter token pagination returned an empty page before the advertised count', {
          pageNo,
          count,
          received: tokens.length
        })
      }
      if (results.length === 0) break
      let added = 0
      for (const token of results.map((item) => tokenToSupportedToken(item, chainId))) {
        // Fail closed per token: drop entries lacking a usable identifier or
        // valid decimals rather than surfacing a placeholder ('' / 18).
        if (!token.token || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) continue
        const key = `${token.chain}:${token.token}`.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        tokens.push(token)
        added++
      }
      const moreExpected = count != null ? tokens.length < count : results.length >= 100
      if (added === 0 && moreExpected) {
        throw new ButterApiError('Butter token pagination made no progress', { pageNo, count, received: tokens.length })
      }
      if (count != null ? tokens.length >= count : results.length < 100) break
      pageNo++
    }
    return tokens
  }

  private async networkKeyForChain (chainId: string): Promise<string> {
    if (!this.chainDetails) {
      // Dedupe concurrent priming so parallel getSupportedTokens calls share a
      // single discovery request rather than each fetching chain metadata.
      this.chainDetailsPromise ??= this.getSupportedChains().finally(() => {
        this.chainDetailsPromise = undefined
      })
      await this.chainDetailsPromise
    }
    const chain = this.chainDetails?.get(chainId)
    return chain?.key ?? chainId
  }
}

/** True when an error is Butter's "token not found" response, not a transport failure. */
function isTokenNotFound (error: unknown): boolean {
  if (!(error instanceof ButterApiError)) return false
  const details = error.details as { errno?: number } | undefined
  return details?.errno === TOKEN_NOT_FOUND_ERRNO
}

function isStrictSlippageChain (chain: ButterChainInfo): boolean {
  const values = [chain.chainType, chain.type, chain.name, chain.key]
  return values.some((value) => {
    const normalized = String(value ?? '').toLowerCase()
    return normalized === 'btc' || normalized === 'ton' || normalized.includes('bitcoin') || normalized.includes('toncoin')
  })
}

function executionFor (chainId: string, config: ButterSwidgeProtocolConfig, registry: ButterRouterRegistry): ButterChainExecution {
  if (chainId === TRON_CHAIN_ID) return config.transactionAdapters?.[chainId] ? 'adapter' : 'quote-only'
  if (routerDeploymentsForChain(registry, chainId).length > 0) return 'native'
  if (config.transactionAdapters?.[chainId]) return 'adapter'
  return 'quote-only'
}
