import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ButterApiError, ButterConfigurationError, ButterFeeLimitExceededError } from '../src/errors.ts'
import { enforceFeeLimits, mapRouteFees, resolveFeeLimits } from '../src/fees.ts'
import type { ButterRoute } from '../src/types.ts'

const SOURCE_TOKEN = '0x00000000000000000000000000000000000000aa'
const BRIDGE_TOKEN = '0x00000000000000000000000000000000000000bb'

function feeRoute (overrides: Partial<ButterRoute> = {}): ButterRoute {
  return {
    hash: 'route',
    totalAmountInUSD: '100',
    srcChain: {
      chainId: '56',
      tokenIn: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDC' },
      tokenOut: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' },
      totalAmountIn: '100',
      totalAmountOut: '100',
      totalAmountOutUSD: '100'
    },
    bridgeChain: {
      chainId: '22776',
      tokenIn: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' },
      tokenOut: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' },
      totalAmountIn: '100',
      totalAmountOut: '99'
    },
    dstChain: {
      chainId: '137',
      tokenOut: { address: '0xout', decimals: 6, symbol: 'USDT' },
      totalAmountOut: '99'
    },
    bridgeFee: {
      amount: '1',
      address: BRIDGE_TOKEN,
      symbol: 'WETH',
      chainId: '22776',
      out: { amount: '1', token: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' } }
    },
    gasFee: { amount: '0.001', symbol: 'BNB', inUSD: '1' },
    swapFee: { nativeFee: '0.002', tokenFee: '1', tokenSymbol: 'USDC' },
    minAmountOut: { amount: '99', symbol: 'USDT' },
    ...overrides
  }
}

const context = {
  sourceChainId: '56',
  sourceToken: SOURCE_TOKEN,
  nativeTokenDecimals: { 56: 18 }
}

describe('Butter fee handling', () => {
  it('maps each fee with its own token decimals and a non-empty token identifier', () => {
    const fees = mapRouteFees(feeRoute(), context)

    assert.deepEqual(fees.map(({ type, amount, token }) => ({ type, amount, token })), [
      { type: 'protocol', amount: 1000000000000000000n, token: BRIDGE_TOKEN },
      { type: 'network', amount: 1000000000000000n, token: 'BNB' },
      { type: 'protocol', amount: 2000000000000000n, token: 'BNB' },
      { type: 'protocol', amount: 1000000n, token: SOURCE_TOKEN }
    ])
  })

  it('enforces aggregated protocol and USD-denominated network fee limits at the boundary', () => {
    const route = feeRoute({ swapFee: { nativeFee: '0', tokenFee: '1', tokenSymbol: 'USDC' } })

    assert.doesNotThrow(() => enforceFeeLimits(route, context, {
      maxNetworkFeeBps: 100n,
      maxProtocolFeeBps: 200n
    }))
    assert.throws(() => enforceFeeLimits(route, context, {
      maxProtocolFeeBps: 199n
    }), ButterFeeLimitExceededError)
    assert.throws(() => enforceFeeLimits(route, context, {
      maxNetworkFeeBps: 99n
    }), ButterFeeLimitExceededError)
  })

  it('fails closed when a configured cap cannot value a nonzero cross-token fee', () => {
    const route = feeRoute({
      totalAmountInUSD: undefined,
      gasFee: { amount: '0.001', symbol: 'BNB' }
    })

    assert.doesNotThrow(() => enforceFeeLimits(route, context, {}))
    assert.throws(() => enforceFeeLimits(route, context, { maxNetworkFeeBps: 100n }), ButterApiError)
  })

  it('uses per-call limits before constructor limits and validates integer inputs', () => {
    assert.deepEqual(resolveFeeLimits(
      { maxNetworkFeeBps: 100, maxProtocolFeeBps: 200n },
      { maxNetworkFeeBps: 50n }
    ), {
      maxNetworkFeeBps: 50n,
      maxProtocolFeeBps: 200n
    })
    assert.throws(() => resolveFeeLimits({ maxNetworkFeeBps: -1 }, {}), ButterConfigurationError)
    assert.throws(() => resolveFeeLimits({}, { maxProtocolFeeBps: 1.5 }), ButterConfigurationError)
  })
})
