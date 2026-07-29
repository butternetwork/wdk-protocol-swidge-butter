import ButterSwidgeProtocol from '@butternetwork/wdk-protocol-swidge-butter'

import {
  butterAuthFromEnv,
  envOrDefault,
  printJson,
  runExample
} from './shared.js'

interface RawChain {
  chainId?: string | number
  id?: string | number
  chainType?: string
  type?: string
  name?: string
  nativeToken?: string
}

runExample(async () => {
  const sourceChainId = envOrDefault('SOURCE_CHAIN_ID', '56')
  const tokenChainId = envOrDefault('TOKEN_CHAIN_ID', sourceChainId)

  // `getSupportedChains` drops chains whose WDK-required `type`/`nativeToken`
  // are missing, so the listing alone cannot tell you how much real coverage
  // that costs. Observe the raw router response on the way through to report
  // exactly which chains were dropped and why. Read-only: the wrapper never
  // alters the request, only the body it re-serves to the parser.
  const rawChains: RawChain[] = []
  const observingFetch = async (
    url: string,
    init?: { method?: string, headers?: Record<string, string> }
  ): Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }> => {
    const response = await globalThis.fetch(url, init)
    const body: unknown = await response.json()
    if (url.includes('/supportedChainInfo')) {
      const data = (body as { data?: RawChain[] } | undefined)?.data
      if (Array.isArray(data)) rawChains.push(...data)
    }
    return { ok: response.ok, status: response.status, json: async () => body }
  }

  const protocol = new ButterSwidgeProtocol(undefined, {
    sourceChainId,
    entrance: envOrDefault('BUTTER_ENTRANCE', 'wdk'),
    fetch: observingFetch,
    ...butterAuthFromEnv()
  })

  const chains = await protocol.getSupportedChains()
  const tokens = await protocol.getSupportedTokens({ fromChain: tokenChainId })

  const listed = new Set(chains.map((chain) => chain.id))
  const dropped = rawChains
    .map((chain) => ({
      id: String(chain.chainId ?? chain.id ?? ''),
      name: chain.name,
      missing: [
        chain.chainId ?? chain.id ? undefined : 'id',
        chain.chainType ?? chain.type ? undefined : 'type',
        chain.nativeToken ? undefined : 'nativeToken'
      ].filter((field): field is string => field != null)
    }))
    .filter((chain) => !listed.has(chain.id))

  printJson({
    chains,
    chainCoverage: {
      reportedByRouter: rawChains.length,
      listed: chains.length,
      // Non-empty here means real coverage is being lost to missing metadata.
      // The raw `nativeToken` is a JSON blob that may also parse without a
      // `symbol`, so `missing` is a hint, not the whole reason.
      dropped
    },
    tokenChainId,
    tokenCount: tokens.length,
    tokens
  })
})
