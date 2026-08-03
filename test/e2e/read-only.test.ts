import assert from 'node:assert/strict'
import { test } from 'node:test'

import ButterSwidgeProtocol from '@butternetwork/wdk-protocol-swidge-butter'

import {
  NoBroadcastSender,
  assertReadOnlySendBlocked,
  createEphemeralEvmAddress,
  parseNonNegativeBigInt,
  parseNonNegativeSafeInteger,
  parsePositiveBigInt,
  parseRequiredString
} from './harness.js'

const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000'

test('live Butter discovery, quote, and swap assembly stop before broadcast', { timeout: 60_000 }, async () => {
  const readOnlyAddress = createEphemeralEvmAddress()
  const sourceChainId = envOrDefault('E2E_READ_SOURCE_CHAIN_ID', '56')
  const destinationChainId = envOrDefault('E2E_READ_DESTINATION_CHAIN_ID', '137')
  const fromToken = envOrDefault('E2E_READ_FROM_TOKEN', NATIVE_TOKEN)
  const toToken = envOrDefault('E2E_READ_TO_TOKEN', NATIVE_TOKEN)
  const amount = parsePositiveBigInt(withDefault('E2E_READ_AMOUNT', '1000000000000000'), 'E2E_READ_AMOUNT')
  const maxNativeFee = parseNonNegativeBigInt(process.env, 'E2E_READ_MAX_NATIVE_FEE')
  const maxNetworkFeeBps = parseNonNegativeSafeInteger(
    withDefault('E2E_READ_MAX_NETWORK_FEE_BPS', '1000'),
    'E2E_READ_MAX_NETWORK_FEE_BPS'
  )
  const maxProtocolFeeBps = parseNonNegativeSafeInteger(
    withDefault('E2E_READ_MAX_PROTOCOL_FEE_BPS', '1000'),
    'E2E_READ_MAX_PROTOCOL_FEE_BPS'
  )
  const entrance = parseRequiredString(process.env, 'BUTTER_E2E_ENTRANCE')
  const auth = optionalAuth()
  const sender = new NoBroadcastSender(readOnlyAddress)
  let wdkAccountSendCalls = 0
  const account = {
    getAddress: async () => readOnlyAddress,
    sendTransaction: async (): Promise<never> => {
      wdkAccountSendCalls += 1
      throw new Error('WDK account sender must not carry EVM calldata')
    }
  }
  const protocol = new ButterSwidgeProtocol(account, {
    sourceChainId,
    entrance,
    ...auth,
    maxNativeFee,
    maxNetworkFeeBps,
    maxProtocolFeeBps,
    requestTimeoutMs: 30_000,
    evm: { walletClient: sender }
  })

  const chains = await protocol.getSupportedChains()
  assert.ok(chains.length > 0, 'Butter returned no supported chains')
  assert.ok(chains.some((chain) => String(chain.id) === sourceChainId), 'source chain is not supported')
  for (const chain of chains) {
    assert.ok(String(chain.id).length > 0)
    assert.ok(chain.name.length > 0)
    assert.ok(chain.type.length > 0)
    assert.ok(chain.nativeToken.length > 0)
  }

  const tokens = await protocol.getSupportedTokens({ fromChain: sourceChainId })
  assert.ok(tokens.length > 0, 'Butter returned no supported source-chain tokens')
  assert.ok(tokens.some((token) => sameIdentifier(token.token, fromToken)), 'configured source token was not discovered')

  const options = {
    fromToken,
    toToken,
    toChain: destinationChainId,
    fromTokenAmount: amount,
    slippage: 0.02,
    recipient: readOnlyAddress
  }
  const quote = await protocol.quoteSwidge(options)
  assert.equal(quote.fromTokenAmount, amount)
  assert.ok(quote.toTokenAmount > 0n)
  assert.ok(quote.toTokenAmountMin > 0n)
  assert.ok(quote.toTokenAmount >= quote.toTokenAmountMin)
  assert.ok(quote.routeHash.trim().length > 0)
  assert.ok(quote.expiry != null && quote.expiry > Math.floor(Date.now() / 1000))
  assert.ok(quote.fees.length > 0)

  let cause: unknown
  try {
    await protocol.swidge({ ...options, routeHash: quote.routeHash })
  } catch (error) {
    cause = error
  }
  assertReadOnlySendBlocked(cause, sender, wdkAccountSendCalls)

  const transaction = sender.attempts[0]
  assert.ok(typeof transaction === 'object' && transaction != null)
  const request = transaction as Record<string, unknown>
  assert.equal(request.chainId, Number(sourceChainId))
  assert.match(String(request.to), /^0x[0-9a-f]{40}$/i)
  assert.match(String(request.data), /^0x[0-9a-f]+$/i)
  assert.equal(typeof request.value, 'bigint')
})

function optionalAuth (): {
  apiKeyId?: string
  apiSecret?: string
  authMode: 'required' | 'optional'
} {
  const apiKeyId = process.env.BUTTER_API_KEY_ID?.trim()
  const apiSecret = process.env.BUTTER_API_SECRET?.trim()
  if (Boolean(apiKeyId) !== Boolean(apiSecret)) {
    throw new Error('BUTTER_API_KEY_ID and BUTTER_API_SECRET must be provided together')
  }
  if (!apiKeyId || !apiSecret) return { authMode: 'optional' }
  return { apiKeyId, apiSecret, authMode: 'required' }
}

function envOrDefault (name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback
}

function withDefault (name: string, fallback: string): NodeJS.ProcessEnv {
  return { ...process.env, [name]: envOrDefault(name, fallback) }
}

function sameIdentifier (left: string, right: string): boolean {
  if (/^0x[0-9a-f]+$/i.test(left) && /^0x[0-9a-f]+$/i.test(right)) {
    return left.toLowerCase() === right.toLowerCase()
  }
  return left === right
}
