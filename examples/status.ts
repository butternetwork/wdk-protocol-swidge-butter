import ButterSwidgeProtocol from '@butternetwork/wdk-protocol-swidge-butter'

import {
  butterAuthFromEnv,
  envOrDefault,
  printJson,
  requireEnv,
  runExample
} from './shared.js'

runExample(async () => {
  const id = requireEnv('SWIDGE_ID')
  const sourceChainId = envOrDefault('SOURCE_CHAIN_ID', '56')
  const protocol = new ButterSwidgeProtocol(undefined, {
    sourceChainId,
    entrance: envOrDefault('BUTTER_ENTRANCE', 'wdk'),
    ...butterAuthFromEnv(),
    exposeQuoteOnlyChains: true
  })
  const byOrderId = process.env.STATUS_BY_ORDER_ID?.trim().toLowerCase() === 'true'
  const fromChain = process.env.STATUS_FROM_CHAIN?.trim()
  const toChain = process.env.STATUS_TO_CHAIN?.trim()

  const status = await protocol.getSwidgeStatus(id, {
    byOrderId,
    ...(fromChain ? { fromChain } : {}),
    ...(toChain ? { toChain } : {})
  })
  printJson({ id, status })
})
