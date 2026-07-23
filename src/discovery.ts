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

import { TRON_CHAIN_ID } from './constants.js'
import { ButterApiError } from './errors.js'
import { chainToSupportedChain, normalizeId, tokenToSupportedToken } from './mappers.js'
import { createRouterRegistry, routerDeploymentsForChain } from './router-registry.js'
import type { ButterChainInfo, ButterTokenInfo, ButterSwidgeProtocolConfig, SwidgeSupportedChain, SwidgeSupportedToken } from './types.js'

export class DiscoveryService {
  private readonly config: ButterSwidgeProtocolConfig
  private readonly requestRouter: <T>(path: string, params?: Record<string, unknown>) => Promise<T>
  private readonly requestToken: <T>(path: string, params?: Record<string, unknown>) => Promise<T>
  private readonly strictSlippageChainIds: Set<string>
  private chainDetails?: Map<string, ButterChainInfo>

  constructor (config: ButterSwidgeProtocolConfig, requestRouter: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, requestToken: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, strictSlippageChainIds: Set<string>) {
    this.config = config
    this.requestRouter = requestRouter
    this.requestToken = requestToken
    this.strictSlippageChainIds = strictSlippageChainIds
  }

  async getSupportedChains (): Promise<Array<SwidgeSupportedChain & { execution: string }>> {
    const [routerChains, tokenChains] = await Promise.all([
      this.requestRouter<ButterChainInfo[]>('/supportedChainInfo'),
      this.requestToken<{ chains?: ButterChainInfo[] }>('/api/queryChainList')
    ])
    this.chainDetails = new Map()
    for (const chain of tokenChains.chains ?? []) {
      this.chainDetails.set(normalizeId(chain.chainId ?? chain.id), chain)
    }
    return routerChains.map((chain) => {
      const id = normalizeId(chain.chainId ?? chain.id)
      const detail = this.chainDetails?.get(id) ?? chain
      if (isStrictSlippageChain({ ...chain, ...detail })) this.strictSlippageChainIds.add(id)
      return chainToSupportedChain({ ...chain, ...detail }, executionFor(id, this.config))
    })
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
      await this.getSupportedChains()
    }
    const chain = this.chainDetails?.get(chainId)
    return chain?.key ?? chainId
  }
}

function isStrictSlippageChain (chain: ButterChainInfo): boolean {
  const values = [chain.chainType, chain.type, chain.name, chain.key]
  return values.some((value) => {
    const normalized = String(value ?? '').toLowerCase()
    return normalized === 'btc' || normalized === 'ton' || normalized.includes('bitcoin') || normalized.includes('toncoin')
  })
}

function executionFor (chainId: string, config: ButterSwidgeProtocolConfig): string {
  if (chainId === TRON_CHAIN_ID) return config.transactionAdapters?.[chainId] ? 'adapter' : 'quote-only'
  if (routerDeploymentsForChain(createRouterRegistry(config.routerContracts), chainId).length > 0) return 'native'
  if (config.transactionAdapters?.[chainId]) return 'adapter'
  return 'quote-only'
}
