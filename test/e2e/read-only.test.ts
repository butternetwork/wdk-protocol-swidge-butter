import assert from 'node:assert/strict'
import { test } from 'node:test'

import ButterSwidgeProtocol from '@butternetwork/wdk-protocol-swidge-butter'

import {
  NoBroadcastSender,
  ReadOnlySendBlockedError,
  assertReadOnlySendBlocked,
  createEphemeralEvmAddress,
  parseNonNegativeBigInt,
  parseNonNegativeSafeInteger,
  parsePositiveBigInt,
  parseRequiredString
} from './harness.js'

const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000'
const TRON_CHAIN_ID = '728126428'
const TRON_READ_ONLY_SENDER = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'

test('live Butter discovery, quote, and swap assembly stop before broadcast', { timeout: 60_000 }, async () => {
  const sourceChainId = envOrDefault('E2E_READ_SOURCE_CHAIN_ID', '56')
  const destinationChainId = envOrDefault('E2E_READ_DESTINATION_CHAIN_ID', '137')
  const isTronSource = sourceChainId === TRON_CHAIN_ID
  const readOnlyAddress = envOrDefault(
    'E2E_READ_SENDER',
    isTronSource ? TRON_READ_ONLY_SENDER : createEphemeralEvmAddress()
  )
  const recipient = isTronSource ? createEphemeralEvmAddress() : readOnlyAddress
  const fromToken = envOrDefault('E2E_READ_FROM_TOKEN', NATIVE_TOKEN)
  const toToken = envOrDefault('E2E_READ_TO_TOKEN', NATIVE_TOKEN)
  const amount = parsePositiveBigInt(withDefault('E2E_READ_AMOUNT', '10000000000000000'), 'E2E_READ_AMOUNT')
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
  const sender = isTronSource ? undefined : new NoBroadcastSender(readOnlyAddress)
  let wdkAccountSendCalls = 0
  let wdkAccountAttempt: unknown
  const account = {
    getAddress: async () => readOnlyAddress,
    sendTransaction: async (transaction: unknown): Promise<never> => {
      wdkAccountSendCalls += 1
      wdkAccountAttempt = transaction
      if (isTronSource) throw new ReadOnlySendBlockedError()
      throw new Error('WDK account sender must not carry EVM calldata')
    }
  }
  const protocol = new ButterSwidgeProtocol(account, {
    sourceChainId,
    entrance,
    authMode: 'optional',
    maxNativeFee,
    maxNetworkFeeBps,
    maxProtocolFeeBps,
    requestTimeoutMs: 30_000,
    ...(sender ? { evm: { walletClient: sender } } : {}),
    ...(isTronSource
      ? {
          transactionAdapters: {
            [sourceChainId]: (transaction: unknown) => ({ transaction, type: 'source' as const })
          }
        }
      : {})
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
  assert.ok(tokens.length > 0, 'Butter returned no advertised source-chain tokens')
  for (const token of tokens) {
    assert.equal(token.chain, sourceChainId)
    assert.ok(token.token.trim().length > 0)
    assert.ok(Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 255)
  }

  const options = {
    fromToken,
    toToken,
    toChain: destinationChainId,
    fromTokenAmount: amount,
    slippage: 0.02,
    recipient
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
  if (isTronSource) {
    assert.ok(cause instanceof ReadOnlySendBlockedError)
    assert.equal(wdkAccountSendCalls, 1)
  } else {
    assert.ok(sender)
    assertReadOnlySendBlocked(cause, sender, wdkAccountSendCalls)
  }

  const transaction = isTronSource ? wdkAccountAttempt : sender?.attempts[0]
  assert.ok(typeof transaction === 'object' && transaction != null)
  const request = transaction as Record<string, unknown>
  assert.equal(String(request.chainId), sourceChainId)
  assert.ok(String(request.to).trim().length > 0)
  assert.ok(String(request.data).trim().length > 0)
  if (!isTronSource) {
    assert.match(String(request.to), /^0x[0-9a-f]{40}$/i)
    assert.match(String(request.data), /^0x[0-9a-f]+$/i)
    assert.equal(typeof request.value, 'bigint')
  }
})

function envOrDefault (name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback
}

function withDefault (name: string, fallback: string): NodeJS.ProcessEnv {
  return { ...process.env, [name]: envOrDefault(name, fallback) }
}
