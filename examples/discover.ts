import ButterSwidgeProtocol from '@butternetwork/wdk-protocol-swidge-butter'

import {
  butterAuthFromEnv,
  envOrDefault,
  printJson,
  runExample
} from './shared.js'

runExample(async () => {
  const sourceChainId = envOrDefault('SOURCE_CHAIN_ID', '56')
  const tokenChainId = envOrDefault('TOKEN_CHAIN_ID', sourceChainId)
  const protocol = new ButterSwidgeProtocol(undefined, {
    sourceChainId,
    entrance: envOrDefault('BUTTER_ENTRANCE', 'wdk'),
    ...butterAuthFromEnv()
  })

  const chains = await protocol.getSupportedChains()
  const tokens = await protocol.getSupportedTokens({ fromChain: tokenChainId })

  printJson({
    chains,
    tokenChainId,
    tokenCount: tokens.length,
    tokens
  })
})
