import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ButterApiError, ButterConfigurationError, ButterFeeLimitExceededError } from '../src/errors.ts'
import { enforceFeeLimits, mapRouteFees, resolveFeeLimits } from '../src/fees.ts'
import type { ButterRoute, ButterWarning } from '../src/types.ts'

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
  nativeTokenDecimals: { 56: 18 },
  // The caller's exact input (100 USDC, 6 decimals) — the source-fee denominator.
  requestedAmountIn: 100000000n
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

  it('warns that the protocol fee group spans multiple tokens', () => {
    const warnings: ButterWarning[] = []

    // The default fixture charges the bridge fee in WETH, the native swap fee in
    // BNB, and the token swap fee in USDC — so the legacy `bridgeFee` scalar adds
    // three currencies together. The warning is the only way a caller sees this.
    mapRouteFees(feeRoute(), { ...context, onWarning: (warning) => warnings.push(warning) })

    assert.deepEqual(warnings.map(({ code }) => code), ['mixed-currency-protocol-fees'])
    assert.deepEqual(
      (warnings[0]?.details as { tokens: string[] }).tokens.sort(),
      [BRIDGE_TOKEN, SOURCE_TOKEN, 'BNB'].sort()
    )
  })

  it('does not warn when every protocol fee shares one token', () => {
    const warnings: ButterWarning[] = []
    const route = feeRoute({
      bridgeFee: {
        amount: '1',
        address: SOURCE_TOKEN,
        symbol: 'USDC',
        chainId: '56',
        out: { amount: '1', token: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDC' } }
      },
      swapFee: { nativeFee: '0', tokenFee: '1', tokenSymbol: 'USDC' }
    })

    mapRouteFees(route, { ...context, onWarning: (warning) => warnings.push(warning) })

    assert.deepEqual(warnings, [])
  })

  it('returns a populated fee array when Butter reports no fees', () => {
    const warnings: ButterWarning[] = []
    const route = feeRoute()
    delete route.bridgeFee
    delete route.gasFee
    delete route.swapFee

    const fees = mapRouteFees(route, { ...context, onWarning: (warning) => warnings.push(warning) })

    // The WDK guide requires a populated array, and an empty one reads as "free"
    // rather than "Butter told us nothing".
    assert.equal(fees.length, 1)
    assert.equal(fees[0]?.amount, 0n)
    assert.equal(fees[0]?.type, 'network')
    assert.deepEqual(warnings.map(({ code }) => code), ['no-fees-reported'])
  })

  it('rounds a reported fee down instead of rejecting extra decimals', () => {
    // USDC carries 6 decimals; Butter reporting 8 used to reject the whole quote
    // over a formatting artifact. These amounts are displayed, not enforced, so
    // under-reporting by one base unit is the safe direction.
    const route = feeRoute({ swapFee: { nativeFee: '0.002', tokenFee: '1.23456789', tokenSymbol: 'USDC' } })

    const fees = mapRouteFees(route, context)

    assert.equal(fees.find(({ token }) => token === SOURCE_TOKEN)?.amount, 1234567n)
  })

  it('still rejects extra decimals where the fee drives a cap decision', () => {
    // enforceFeeLimits parses the same field with rounding 'reject', because a
    // silently truncated fee could slip under a bps cap.
    const route = feeRoute({ swapFee: { nativeFee: '0', tokenFee: '1.23456789', tokenSymbol: 'USDC' } })

    assert.throws(() => enforceFeeLimits(route, context, { maxProtocolFeeBps: 500n }), ButterApiError)
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
    const route = feeRoute({ gasFee: { amount: '0.001', symbol: 'BNB' } })
    // Butter omitted the USD metadata entirely: the key is absent, not set to
    // undefined, which is what a parsed response actually looks like.
    delete route.totalAmountInUSD

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
