import { TRON_CHAIN_ID } from './constants.js'
import { chainToSupportedChain, normalizeId, tokenToSupportedToken } from './mappers.js'
import { createRouterRegistry, routerDeploymentsForChain } from './router-registry.js'
import type { ButterChainInfo, ButterTokenInfo, ButterSwidgeProtocolConfig, SwidgeSupportedChain, SwidgeSupportedToken } from './types.js'

export class DiscoveryService {
  private readonly config: ButterSwidgeProtocolConfig
  private readonly requestRouter: <T>(path: string, params?: Record<string, unknown>) => Promise<T>
  private readonly requestToken: <T>(path: string, params?: Record<string, unknown>) => Promise<T>
  private chainDetails?: Map<string, ButterChainInfo>

  constructor (config: ButterSwidgeProtocolConfig, requestRouter: <T>(path: string, params?: Record<string, unknown>) => Promise<T>, requestToken: <T>(path: string, params?: Record<string, unknown>) => Promise<T>) {
    this.config = config
    this.requestRouter = requestRouter
    this.requestToken = requestToken
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
      return chainToSupportedChain({ ...chain, ...detail }, executionFor(id, this.config))
    })
  }

  async getSupportedTokens (chainId: string): Promise<SwidgeSupportedToken[]> {
    const network = await this.networkKeyForChain(chainId)
    const tokens: SwidgeSupportedToken[] = []
    let pageNo = 1
    let count = 0
    do {
      const data = await this.requestToken<{ count?: number, results?: ButterTokenInfo[] }>('/api/queryTokenList', {
        network,
        pageNo,
        pageSize: 100
      })
      count = data.count ?? data.results?.length ?? 0
      tokens.push(...(data.results ?? []).map((token) => tokenToSupportedToken(token, chainId)))
      pageNo++
    } while (tokens.length < count)
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

function executionFor (chainId: string, config: ButterSwidgeProtocolConfig): string {
  if (chainId === TRON_CHAIN_ID) return config.transactionAdapters?.[chainId] ? 'adapter' : 'quote-only'
  if (routerDeploymentsForChain(createRouterRegistry(config.routerContracts), chainId).length > 0) return 'native'
  if (config.transactionAdapters?.[chainId]) return 'adapter'
  return config.exposeQuoteOnlyChains ? 'quote-only' : 'unsupported'
}
