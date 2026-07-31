import assert from 'node:assert/strict'
import { test } from 'node:test'

import ButterSwidgeProtocol, { toEvmPublicClient } from '@butternetwork/wdk-protocol-swidge-butter'
import { createPublicClient, defineChain, http } from 'viem'

import {
  parseNonNegativeSafeInteger,
  parseRequiredString,
  pollSwidgeStatus,
  writeE2eResult
} from './harness.js'

test('resumes status polling for an existing EVM source transaction', { timeout: 48 * 60_000 }, async () => {
  const sourceHash = parseRequiredString(process.env, 'E2E_STATUS_SOURCE_HASH')
  assert.match(sourceHash, /^0x[0-9a-f]{64}$/i, 'E2E_STATUS_SOURCE_HASH must be an EVM transaction hash')
  const sourceChainId = positiveInteger('E2E_STATUS_SOURCE_CHAIN_ID')
  const destinationChainId = positiveInteger('E2E_STATUS_DESTINATION_CHAIN_ID')
  const rpcUrl = parseRequiredString(process.env, 'E2E_STATUS_SOURCE_RPC_URL')
  const chain = defineChain({
    id: sourceChainId,
    name: `E2E Chain ${sourceChainId}`,
    nativeCurrency: { name: 'Native token', symbol: 'NATIVE', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  })
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const actualChainId = await publicClient.getChainId()
  assert.equal(actualChainId, sourceChainId, 'status RPC chain does not match E2E_STATUS_SOURCE_CHAIN_ID')
  const protocol = new ButterSwidgeProtocol(undefined, {
    sourceChainId,
    entrance: parseRequiredString(process.env, 'BUTTER_ENTRANCE'),
    apiKeyId: parseRequiredString(process.env, 'BUTTER_API_KEY_ID'),
    apiSecret: parseRequiredString(process.env, 'BUTTER_API_SECRET'),
    authMode: 'required',
    evm: { publicClient: toEvmPublicClient(publicClient) }
  })
  const crossChain = sourceChainId !== destinationChainId
  const status = await pollSwidgeStatus({
    query: async () => await protocol.getSwidgeStatus(sourceHash, {
      fromChain: sourceChainId,
      toChain: destinationChainId
    }),
    intervalMs: crossChain ? 15_000 : 3_000,
    timeoutMs: crossChain ? 45 * 60_000 : 3 * 60_000
  })

  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  await writeE2eResult('.e2e-results', `status-${timestamp}.json`, {
    sourceHash,
    sourceChainId,
    destinationChainId,
    status
  })
})

function positiveInteger (name: string): number {
  const value = parseNonNegativeSafeInteger(process.env, name)
  if (value <= 0) throw new Error(`${name} must be a positive safe integer`)
  return value
}
