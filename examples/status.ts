import ButterSwidgeProtocol, { toEvmPublicClient } from '@butternetwork/wdk-protocol-swidge-butter'
import { createPublicClient, defineChain, http } from 'viem'

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
  // A same-chain status query derives its result from the source transaction's
  // receipt (and attributes it to a Butter Router), so it needs a public client.
  // Set RPC_URL for a numeric EVM SOURCE_CHAIN_ID to enable it.
  const rpcUrl = process.env.RPC_URL?.trim()
  const evm = rpcUrl && /^\d+$/.test(sourceChainId)
    ? {
        publicClient: toEvmPublicClient(createPublicClient({
          chain: defineChain({
            id: Number(sourceChainId),
            name: envOrDefault('SOURCE_CHAIN_NAME', `Chain ${sourceChainId}`),
            nativeCurrency: { name: 'Native token', symbol: 'NATIVE', decimals: 18 },
            rpcUrls: { default: { http: [rpcUrl] } }
          }),
          transport: http(rpcUrl)
        }))
      }
    : undefined
  const protocol = new ButterSwidgeProtocol(undefined, {
    sourceChainId,
    entrance: envOrDefault('BUTTER_ENTRANCE', 'wdk'),
    ...butterAuthFromEnv(),
    ...(evm ? { evm } : {})
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
