import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  ButterApiError,
  ButterConfigurationError,
  ButterFeeLimitExceededError,
  ButterFeeValuationError
} from '../src/errors.ts'
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
      // Deliberately NOT equal to `out.amount`. The components are authoritative;
      // making the summary match them is what previously hid the fact that this
      // top-level figure was the only thing being read.
      amount: '999',
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
    // A network fee is gas, always paid in the native token — never in the input
    // token, which here is USDC.
    assert.equal(fees[0]?.token, 'native')
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

  it('reports each bridge fee component separately with its own token', () => {
    // in and out can sit on different chains in different tokens. Collapsing them
    // into one entry forced a guess about which token to report.
    const route = feeRoute({
      bridgeFee: {
        amount: '999',
        address: BRIDGE_TOKEN,
        symbol: 'WETH',
        chainId: '22776',
        in: { amount: '2', token: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDC' } },
        out: { amount: '1', token: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' } }
      },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })

    const fees = mapRouteFees(route, context)

    assert.deepEqual(fees.map(({ type, amount, token }) => ({ type, amount, token })), [
      { type: 'protocol', amount: 2000000n, token: SOURCE_TOKEN },
      { type: 'protocol', amount: 1000000000000000000n, token: BRIDGE_TOKEN }
    ])
    // The 999 summary is never surfaced as an amount.
    assert.ok(!fees.some(({ amount }) => amount === 999000000000000000000n))
  })

  it('falls back to the top-level bridge fee when it reports no components', () => {
    const route = feeRoute({
      bridgeFee: { amount: '1', address: BRIDGE_TOKEN, symbol: 'WETH', chainId: '22776' },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })

    const fees = mapRouteFees(route, context)

    assert.deepEqual(fees.map(({ type, amount, token }) => ({ type, amount, token })), [
      { type: 'protocol', amount: 1000000000000000000n, token: BRIDGE_TOKEN }
    ])
  })

  it('fails closed when a bridge fee component matches no route leg in its token', () => {
    // Dividing by an amount in a different currency yields a meaningless ratio, so
    // there is deliberately no cross-currency fallback.
    const route = feeRoute({
      bridgeFee: {
        amount: '1',
        address: BRIDGE_TOKEN,
        symbol: 'WETH',
        chainId: '22776',
        out: { amount: '1', token: { address: '0x00000000000000000000000000000000000000dd', decimals: 18, symbol: 'MYSTERY' } }
      },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' }
    })

    assert.throws(
      () => enforceFeeLimits(route, context, { maxProtocolFeeBps: 10000n }),
      ButterFeeValuationError
    )
  })

  it('counts a proportional feeConfig rate toward the protocol fee cap', () => {
    // The bypass: declare a fat proportional feeConfig, report no swapFee, pass any
    // cap, then execute calldata carrying the fee — validateFeeData accepts it
    // precisely because it matches the feeConfig.
    const route = feeRoute({
      feeConfig: { feeType: 1, referrer: '0x0000000000000000000000000000000000000111', rateOrNativeFee: 5000 },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      bridgeFee: { amount: '0', address: BRIDGE_TOKEN, symbol: 'WETH', chainId: '22776' },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })

    assert.throws(
      () => enforceFeeLimits(route, context, { maxProtocolFeeBps: 1n }),
      ButterFeeLimitExceededError
    )
    // 5000 bps is exactly the declared rate, so the cap is pinning the valuation
    // rather than rejecting unconditionally. Note this needs no route-reported
    // amount at all: a bps rate of the input is its own ratio.
    assert.doesNotThrow(() => enforceFeeLimits(route, context, { maxProtocolFeeBps: 5000n }))
  })

  it('counts a fixed native feeConfig fee toward the protocol fee cap', () => {
    // feeType 0 is a fixed fee in source-chain native base units, valued exactly
    // like swapFee.nativeFee. 0.002 native against this fixture is 200 bps.
    const route = feeRoute({
      feeConfig: { feeType: 0, referrer: '0x0000000000000000000000000000000000000111', rateOrNativeFee: '2000000000000000' },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      bridgeFee: { amount: '0', address: BRIDGE_TOKEN, symbol: 'WETH', chainId: '22776' }
    })

    assert.throws(
      () => enforceFeeLimits(route, context, { maxProtocolFeeBps: 199n }),
      ButterFeeLimitExceededError
    )
    assert.doesNotThrow(() => enforceFeeLimits(route, context, { maxProtocolFeeBps: 200n }))
  })

  it('does not double count a feeConfig fee that swapFee already reports', () => {
    // feeConfig and swapFee are two views of one fee: 1 USDC of 100 is 100 bps, and
    // so is a 100 bps rate. Summing them would report 200.
    const route = feeRoute({
      feeConfig: { feeType: 1, referrer: '0x0000000000000000000000000000000000000111', rateOrNativeFee: 100 },
      swapFee: { nativeFee: '0', tokenFee: '1', tokenSymbol: 'USDC' },
      bridgeFee: { amount: '0', address: BRIDGE_TOKEN, symbol: 'WETH', chainId: '22776' },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })

    assert.doesNotThrow(() => enforceFeeLimits(route, context, { maxProtocolFeeBps: 100n }))
    assert.throws(
      () => enforceFeeLimits(route, context, { maxProtocolFeeBps: 99n }),
      ButterFeeLimitExceededError
    )
  })

  it('fails closed on a feeConfig feeType it does not model', () => {
    const route = feeRoute({
      feeConfig: { feeType: 7, referrer: '0x0000000000000000000000000000000000000111', rateOrNativeFee: 5 }
    })

    assert.throws(
      () => enforceFeeLimits(route, context, { maxProtocolFeeBps: 10000n }),
      ButterFeeValuationError
    )
  })

  it('warns when feeConfig charges a fee swapFee does not report', () => {
    const warnings: ButterWarning[] = []
    const route = feeRoute({
      feeConfig: { feeType: 1, referrer: '0x0000000000000000000000000000000000000111', rateOrNativeFee: 50 },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' }
    })

    // The quote cannot show this fee as an amount (a rate is not an amount), so the
    // warning is the only signal that fees[] understates the cost.
    enforceFeeLimits(route, { ...context, onWarning: (warning) => warnings.push(warning) }, { maxProtocolFeeBps: 10000n })

    assert.deepEqual(warnings.map(({ code }) => code), ['undeclared-integrator-fee'])
  })

  it('values a source-token bridge fee against the caller input, not the route', () => {
    // The bypass this closes: the bridge fee is charged in the SOURCE token, and the
    // route inflates its self-reported input so the ratio slips under the cap.
    // 10 USDC fee on the caller's real 100 USDC input is 1000 bps, over a 500 bps cap.
    const route = feeRoute({
      bridgeFee: {
        amount: '10',
        address: SOURCE_TOKEN,
        symbol: 'USDC',
        chainId: '56',
        out: { amount: '10', token: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDC' } }
      },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      srcChain: {
        chainId: '56',
        tokenIn: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDC' },
        tokenOut: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' },
        // Inflated 100x. Using this as the denominator would report 10 bps.
        totalAmountIn: '10000',
        totalAmountOut: '10000',
        totalAmountOutUSD: '10000'
      }
    })

    assert.throws(
      () => enforceFeeLimits(route, context, { maxProtocolFeeBps: 500n }),
      ButterFeeLimitExceededError
    )
    // Sanity: the same fee against a cap above the true ratio still passes, so the
    // test is pinning the denominator rather than an unconditional rejection.
    assert.doesNotThrow(() => enforceFeeLimits(route, context, { maxProtocolFeeBps: 1000n }))
  })

  it('fails closed on a fee cap when the route omits the metadata entirely', () => {
    // Absent is not zero. Scoring an unreported fee as free would let Butter pass any
    // cap simply by omitting the field.
    const noGas = feeRoute()
    delete noGas.gasFee
    const noBridge = feeRoute()
    delete noBridge.bridgeFee

    assert.throws(() => enforceFeeLimits(noGas, context, { maxNetworkFeeBps: 100n }), ButterFeeValuationError)
    assert.throws(() => enforceFeeLimits(noBridge, context, { maxProtocolFeeBps: 100n }), ButterFeeValuationError)
    // An explicit zero is a real answer and passes.
    const zeroGas = feeRoute({ gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' } })
    assert.doesNotThrow(() => enforceFeeLimits(zeroGas, context, { maxNetworkFeeBps: 100n }))
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
