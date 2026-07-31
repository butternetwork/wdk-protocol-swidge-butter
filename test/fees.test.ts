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
      // Live responses satisfy `amount = in + out + affiliate`; this fixture mirrors
      // that so the summary and the components stay mutually consistent. It is
      // deliberately NOT read for pricing — the components are authoritative — and
      // an earlier fixture that made summary and component identical is exactly what
      // hid the fact that only the summary was being used.
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

/**
 * A bridge fee that charges nothing, stated through a real component.
 *
 * A bare `{ amount: '0' }` summary is deliberately NOT equivalent: the summary is
 * untrusted, so it cannot certify a zero any more than it can be priced.
 */
const ZERO_BRIDGE_FEE = {
  amount: '0',
  address: BRIDGE_TOKEN,
  symbol: 'WETH',
  chainId: '22776',
  out: { amount: '0', token: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' } }
}

const context = {
  sourceChainId: '56',
  sourceToken: SOURCE_TOKEN,
  nativeTokenDecimals: { 56: 18 },
  // The caller's exact input (100 USDC, 6 decimals) — the source-fee denominator.
  requestedAmountIn: 100000000n,
  // Resolved by this package when building the request, NOT read from the route.
  sourceTokenDecimals: 6
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

  it('counts the affiliate share toward the protocol fee cap', () => {
    // WDK has no affiliate cap, and an unset config.affiliate means Butter takes the
    // cut with its own wallet — so maxProtocolFeeBps is the only bound available.
    // 1 USDC of the caller's 100 input is 100 bps.
    const route = feeRoute({
      bridgeFee: {
        amount: '1',
        address: SOURCE_TOKEN,
        symbol: 'USDC',
        chainId: '56',
        affiliate: { amount: '1', token: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDC' } }
      },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })

    assert.throws(
      () => enforceFeeLimits(route, context, { maxProtocolFeeBps: 99n }),
      ButterFeeLimitExceededError
    )
    assert.doesNotThrow(() => enforceFeeLimits(route, context, { maxProtocolFeeBps: 100n }))
    // It keeps WDK's own fee type in the itemised list; only the cap aggregates it.
    const fees = mapRouteFees(route, context)
    assert.deepEqual(fees.map(({ type }) => type), ['affiliate'])
  })

  it('never prices the bridge fee summary, even alongside a component', () => {
    // The summary includes the affiliate share, so pricing it next to the affiliate
    // entry would charge that share twice. More basically, it is one figure with one
    // token for a fee that can span three tokens — an untrusted response could omit
    // the real components and offer a small, conveniently-denominated summary.
    const route = feeRoute({
      bridgeFee: {
        amount: '3',
        address: SOURCE_TOKEN,
        symbol: 'USDC',
        chainId: '56',
        affiliate: { amount: '1', token: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDC' } }
      },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })

    const fees = mapRouteFees(route, context)

    assert.deepEqual(fees.map(({ type, amount }) => ({ type, amount })), [
      { type: 'affiliate', amount: 1000000n }
    ])
  })

  it('refuses a fee cap when only a bridge fee summary is reported', () => {
    const warnings: ButterWarning[] = []
    // No in, out or affiliate: nothing attributable to price, and the summary is not
    // a substitute for them.
    const route = feeRoute({
      bridgeFee: { amount: '3', address: SOURCE_TOKEN, symbol: 'USDC', chainId: '56' },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })

    const fees = mapRouteFees(route, { ...context, onWarning: (warning) => warnings.push(warning) })

    // Omitting the summary leaves nothing to report, so the never-empty rule adds its
    // zero placeholder and its own warning. The pair is the honest description: we
    // know of a fee, and we refuse to put a number on it.
    assert.deepEqual(warnings.map(({ code }) => code), ['bridge-fee-components-missing', 'no-fees-reported'])
    assert.deepEqual(fees.map(({ type, amount }) => ({ type, amount })), [{ type: 'network', amount: 0n }])
    assert.throws(
      () => enforceFeeLimits(route, context, { maxProtocolFeeBps: 10000n }),
      ButterFeeValuationError
    )
  })

  /**
   * Whether a bridge fee component counts as the caller's source token has now been
   * wrong in three different directions across three reviews: too strict (a
   * symbol-only BTC component pushed into the route-controlled denominator), then too
   * loose (a symbol overriding a declared address), then too loose again (any
   * component naming the source address in its `symbol`). Each fix was right about
   * the case it was shown. So the whole matrix is pinned here rather than the latest
   * case, asserted through observable behaviour rather than the private predicate.
   *
   * `sourceDenominated` — valued against the caller's input, so a route inflating its
   * reported amounts cannot move the ratio. `routeDenominated` — valued against a
   * matching leg, the documented concession for a genuinely different currency.
   * `refused` — unidentifiable, so not valued at all.
   */
  const SOURCE_TOKEN_MATRIX: Array<{
    name: string
    sourceToken: string
    component: { address?: string, symbol?: string }
    expect: 'sourceDenominated' | 'routeDenominated' | 'refused'
  }> = [
    // Base58 encodes information in each character's case, so two casings of a
    // Solana mint are two different tokens. Lowercasing both merged them, handing a
    // fee in an unrelated mint the caller's own input as its denominator.
    { name: 'Base58 source, same mint', sourceToken: 'AbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGHJK', component: { address: 'AbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGHJK', symbol: 'SOL' }, expect: 'sourceDenominated' },
    // Not the source token, and no leg carries that address either, so it is refused
    // rather than silently valued against the caller's input.
    { name: 'Base58 source, mint differing only by case', sourceToken: 'AbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGHJK', component: { address: 'abcdefghjklmnpqrstuvwxyz123456789abcdefghjk', symbol: 'SOL' }, expect: 'refused' },
    // An EVM source is identified by address, so only an address can match it.
    { name: 'EVM source, address differing only by case', sourceToken: SOURCE_TOKEN, component: { address: SOURCE_TOKEN.toUpperCase().replace('0X', '0x'), symbol: 'USDC' }, expect: 'sourceDenominated' },
    { name: 'EVM source, same address', sourceToken: SOURCE_TOKEN, component: { address: SOURCE_TOKEN, symbol: 'USDC' }, expect: 'sourceDenominated' },
    { name: 'EVM source, different address', sourceToken: SOURCE_TOKEN, component: { address: BRIDGE_TOKEN, symbol: 'WETH' }, expect: 'routeDenominated' },
    { name: 'EVM source, address hidden in symbol', sourceToken: SOURCE_TOKEN, component: { symbol: SOURCE_TOKEN }, expect: 'refused' },
    { name: 'EVM source, unrelated symbol only', sourceToken: SOURCE_TOKEN, component: { symbol: 'USDC' }, expect: 'refused' },
    // A symbolic source ('btc') has no address to compare, so a symbol may confirm it.
    { name: 'symbolic source, matching symbol only', sourceToken: 'btc', component: { symbol: 'BTC' }, expect: 'sourceDenominated' },
    { name: 'symbolic source, declared foreign address', sourceToken: 'btc', component: { address: BRIDGE_TOKEN, symbol: 'BTC' }, expect: 'routeDenominated' },
    { name: 'symbolic source, no identifier at all', sourceToken: 'btc', component: { decimals: 8 } as { symbol?: string }, expect: 'refused' }
  ]

  for (const { name, sourceToken, component, expect } of SOURCE_TOKEN_MATRIX) {
    it(`identifies a bridge fee component: ${name}`, () => {
      const token = { ...component, decimals: 6 }
      const matrixContext = { ...context, sourceToken, sourceTokenDecimals: 6 }
      const route = feeRoute({
        // The only leg that can serve as a route denominator, matched by address.
        bridgeChain: {
          chainId: '22776',
          tokenIn: { address: BRIDGE_TOKEN, decimals: 6, symbol: 'WETH' },
          tokenOut: { address: BRIDGE_TOKEN, decimals: 6, symbol: 'WETH' },
          totalAmountIn: '100',
          totalAmountOut: '100'
        },
        bridgeFee: { amount: '1', chainId: '22776', out: { amount: '1', token } },
        swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
        gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
      })

      if (expect === 'refused') {
        // `ButterApiError` rather than `ButterFeeValuationError` (which extends it):
        // refusal legitimately arrives from either guard — a component with no
        // identifier at all is rejected while the components are built, before
        // anything tries to value it.
        assert.throws(
          () => enforceFeeLimits(route, matrixContext, { maxProtocolFeeBps: 10000n }),
          ButterApiError
        )
        return
      }
      // 1 of the caller's 100 is 100 bps either way here, so what the assertion pins
      // is that a denominator was found at all — and which one, via the guard above.
      assert.doesNotThrow(() => enforceFeeLimits(route, matrixContext, { maxProtocolFeeBps: 100n }))
      assert.throws(
        () => enforceFeeLimits(route, matrixContext, { maxProtocolFeeBps: 99n }),
        ButterFeeLimitExceededError
      )
    })
  }

  it('values a symbol-only source token bridge fee against the caller input', () => {
    // On a non-EVM source `sourceToken` is 'btc', not an address, and the fee token
    // carries only a symbol. Requiring an address to recognize the source token sent
    // this component down the cross-denominated path, where the denominator comes
    // from the route — so inflating the reported input hid the real ratio.
    const btcContext = {
      sourceChainId: '1360095883558913',
      sourceToken: 'btc',
      nativeTokenDecimals: { 56: 18 },
      // The caller really is spending 100 BTC.
      requestedAmountIn: 10000000000n,
      sourceTokenDecimals: 8
    }
    const route = feeRoute({
      srcChain: {
        chainId: '1360095883558913',
        tokenIn: { symbol: 'BTC', decimals: 8 },
        tokenOut: { symbol: 'BTC', decimals: 8 },
        // Inflated 100x: 10 BTC of fee reads as 10 bps against this, not 1000.
        totalAmountIn: '10000',
        totalAmountOut: '10000',
        totalAmountOutUSD: '10000'
      },
      bridgeChain: {
        chainId: '22776',
        tokenIn: { symbol: 'BTC', decimals: 8 },
        tokenOut: { symbol: 'BTC', decimals: 8 },
        totalAmountIn: '10000',
        totalAmountOut: '10000'
      },
      bridgeFee: {
        amount: '10',
        symbol: 'BTC',
        chainId: '22776',
        out: { amount: '10', token: { symbol: 'BTC', decimals: 8 } }
      },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'BTC' },
      gasFee: { amount: '0', symbol: 'BTC', inUSD: '0' }
    })

    assert.throws(
      () => enforceFeeLimits(route, btcContext, { maxProtocolFeeBps: 10n }),
      ButterFeeLimitExceededError
    )
    // 10 of 100 really is 1000 bps, so the cap is pinning the denominator rather
    // than rejecting unconditionally.
    assert.doesNotThrow(() => enforceFeeLimits(route, btcContext, { maxProtocolFeeBps: 1000n }))
  })

  it('does not treat a different address as the source token because the symbol matches', () => {
    // The other end of the same rule. `{ address: '0x…ee', symbol: 'BTC' }` is not the
    // caller's BTC however its ticker reads, and dividing its fee by the caller's BTC
    // input is the cross-currency division this module forbids elsewhere — it
    // understates without limit whenever that token's own leg is small.
    const impostor = '0x00000000000000000000000000000000000000ee'
    const btcContext = {
      sourceChainId: '1360095883558913',
      sourceToken: 'btc',
      nativeTokenDecimals: { 56: 18 },
      requestedAmountIn: 10000000000n, // 100 BTC at 8 decimals
      sourceTokenDecimals: 8
    }
    const route = feeRoute({
      srcChain: {
        chainId: '1360095883558913',
        tokenIn: { symbol: 'BTC', decimals: 8 },
        tokenOut: { address: impostor, decimals: 8, symbol: 'BTC' },
        totalAmountIn: '100',
        totalAmountOut: '0.01',
        totalAmountOutUSD: '100'
      },
      bridgeChain: {
        chainId: '22776',
        tokenIn: { address: impostor, decimals: 8, symbol: 'BTC' },
        tokenOut: { address: impostor, decimals: 8, symbol: 'BTC' },
        totalAmountIn: '0.01',
        totalAmountOut: '0.01'
      },
      bridgeFee: {
        amount: '0.01',
        address: impostor,
        symbol: 'BTC',
        chainId: '22776',
        out: { amount: '0.01', token: { address: impostor, decimals: 8, symbol: 'BTC' } }
      },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'BTC' },
      gasFee: { amount: '0', symbol: 'BTC', inUSD: '0' }
    })

    // 0.01 of the 0.01 leaving the bridge is 10000 bps. Measured against the caller's
    // 100 BTC it would read as 1 bp and sail under any cap.
    assert.throws(
      () => enforceFeeLimits(route, btcContext, { maxProtocolFeeBps: 100n }),
      ButterFeeLimitExceededError
    )
  })

  it('refuses a cross-denominated bridge fee component that names no address', () => {
    // A symbol is not a stable identifier — the same ticker exists on many chains —
    // so it cannot be used to pick which route amount the fee is measured against.
    const route = feeRoute({
      bridgeFee: {
        amount: '1',
        symbol: 'WETH',
        chainId: '22776',
        out: { amount: '1', token: { symbol: 'WETH', decimals: 18 } }
      },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })

    assert.throws(
      () => enforceFeeLimits(route, context, { maxProtocolFeeBps: 10000n }),
      ButterFeeValuationError
    )
  })

  it('refuses a cross-chain fee cap when only a zero bridge fee summary is reported', () => {
    // The summary is untrusted enough that this package refuses to price it — so it
    // is equally unfit to attest that the fee is zero. Accepting `{ amount: "0" }` as
    // proof let a cross-chain route satisfy even maxProtocolFeeBps: 0 while reporting
    // nothing valuable, which is a cheaper forgery than inventing a small summary.
    // Deliberately a bare summary, not ZERO_BRIDGE_FEE: that is the whole subject.
    const route = feeRoute({
      bridgeFee: { amount: '0', address: BRIDGE_TOKEN, symbol: 'WETH', chainId: '22776' },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })

    assert.throws(
      () => enforceFeeLimits(route, context, { maxProtocolFeeBps: 0n }),
      ButterFeeValuationError
    )
  })

  it('warns about an unattributable bridge fee summary even when it is zero', () => {
    const warnings: ButterWarning[] = []
    const route = feeRoute({
      bridgeFee: { amount: '0', address: BRIDGE_TOKEN, symbol: 'WETH', chainId: '22776' },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })

    // The documented contract is "a summary arrived with no components", not "a
    // non-zero one did" — gating the warning on non-zero silently narrowed it.
    mapRouteFees(route, { ...context, onWarning: (warning) => warnings.push(warning) })

    assert.ok(warnings.some(({ code }) => code === 'bridge-fee-components-missing'))
  })

  it('does not refuse a same-chain fee cap over a zero unattributable summary', () => {
    // Warning and refusing are separate questions: a zero summary charges nothing, so
    // there is nothing for a cap to bound. Cross-chain is covered regardless by the
    // separate "reports a real component" requirement.
    const route = feeRoute({
      bridgeFee: { amount: '0', address: BRIDGE_TOKEN, symbol: 'WETH', chainId: '22776' },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })
    // Same-chain: the key is absent, as a parsed response would have it.
    delete route.dstChain

    assert.doesNotThrow(() => enforceFeeLimits(route, context, { maxProtocolFeeBps: 0n }))
  })

  it('accepts an explicitly zero bridge fee component', () => {
    // What was tightened is the summary, not the concept of zero: a component saying
    // "this leg charges nothing" is a real answer from a real field.
    const route = feeRoute({
      bridgeFee: {
        amount: '0',
        address: BRIDGE_TOKEN,
        symbol: 'WETH',
        chainId: '22776',
        out: { amount: '0', token: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' } }
      },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })

    assert.doesNotThrow(() => enforceFeeLimits(route, context, { maxProtocolFeeBps: 0n }))
  })

  it('maps source-token fees with the resolved decimals, not the route-declared ones', () => {
    // A quote needs no cap configured, so an understated scale here is read and acted
    // on silently. USDC is 6 decimals; the route claims 0.
    const declaresZeroDecimals = {
      chainId: '56',
      tokenIn: { address: SOURCE_TOKEN, decimals: 0, symbol: 'USDC' },
      tokenOut: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' },
      totalAmountIn: '100',
      totalAmountOut: '100',
      totalAmountOutUSD: '100'
    }
    const route = feeRoute({
      srcChain: declaresZeroDecimals,
      swapFee: { nativeFee: '0', tokenFee: '10', tokenSymbol: 'USDC' },
      bridgeFee: {
        amount: '10',
        address: SOURCE_TOKEN,
        symbol: 'USDC',
        chainId: '56',
        out: { amount: '10', token: { address: SOURCE_TOKEN, decimals: 0, symbol: 'USDC' } }
      },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })

    // 10 USDC is 10000000n, never 10n — for the bridge component as well as swapFee.
    assert.throws(() => mapRouteFees(route, context), ButterFeeValuationError)
    const honest = feeRoute({
      swapFee: { nativeFee: '0', tokenFee: '10', tokenSymbol: 'USDC' },
      bridgeFee: {
        amount: '10',
        address: SOURCE_TOKEN,
        symbol: 'USDC',
        chainId: '56',
        out: { amount: '10', token: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDC' } }
      },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })
    assert.deepEqual(
      mapRouteFees(honest, context).map(({ amount, token }) => ({ amount, token })),
      [
        { amount: 10000000n, token: SOURCE_TOKEN },
        { amount: 10000000n, token: SOURCE_TOKEN }
      ]
    )
  })

  it('accepts a cross-chain route whose only bridge fee is the affiliate share', () => {
    // An affiliate-only bridge fee is a legitimate response; the cross-chain
    // "reports a bridge fee" test used to ignore the affiliate field and rejected it.
    const route = feeRoute({
      bridgeFee: {
        address: SOURCE_TOKEN,
        symbol: 'USDC',
        chainId: '56',
        affiliate: { amount: '1', token: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDC' } }
      },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })

    assert.doesNotThrow(() => enforceFeeLimits(route, context, { maxProtocolFeeBps: 100n }))
  })

  it('values an outbound bridge fee against the outbound leg, not the inbound one', () => {
    // in and out are the same token here, which is the case a shared candidate order
    // got wrong: both matched totalAmountIn (100) first, understating the outbound
    // fee that should be measured against totalAmountOut (99).
    const route = feeRoute({
      bridgeFee: {
        amount: '2',
        address: BRIDGE_TOKEN,
        symbol: 'WETH',
        chainId: '22776',
        in: { amount: '1', token: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' } },
        out: { amount: '1', token: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' } }
      },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })

    // 1/100 + 1/99 = 199/9900 = 201.0101... bps, not 2/100 = 200 bps.
    assert.doesNotThrow(() => enforceFeeLimits(route, context, { maxProtocolFeeBps: 202n }))
    assert.throws(
      () => enforceFeeLimits(route, context, { maxProtocolFeeBps: 201n }),
      ButterFeeLimitExceededError
    )
  })

  it('rejects a source token fee whose decimals disagree with the resolved ones', () => {
    // The bypass: the denominator is the caller's real base units, so understating
    // the token's decimals shrinks the numerator by a power of ten. 10 USDC declared
    // at decimals 0 parses to 10n instead of 10000000n — 1000 bps read as 0.001.
    // route.ts only ever checked the token's address, never its decimals.
    const route = feeRoute({
      swapFee: { nativeFee: '0', tokenFee: '10', tokenSymbol: 'USDC' },
      bridgeFee: ZERO_BRIDGE_FEE,
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' },
      srcChain: {
        chainId: '56',
        tokenIn: { address: SOURCE_TOKEN, decimals: 0, symbol: 'USDC' },
        tokenOut: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' },
        totalAmountIn: '100',
        totalAmountOut: '100',
        totalAmountOutUSD: '100'
      }
    })

    assert.throws(
      () => enforceFeeLimits(route, context, { maxProtocolFeeBps: 1n }),
      ButterFeeValuationError
    )
    // With honest decimals the same fee is valued at its true 1000 bps and rejected
    // on merit, confirming the guard pins the scale rather than the outcome.
    const honest = feeRoute({
      swapFee: { nativeFee: '0', tokenFee: '10', tokenSymbol: 'USDC' },
      bridgeFee: ZERO_BRIDGE_FEE,
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' }
    })
    assert.throws(
      () => enforceFeeLimits(honest, context, { maxProtocolFeeBps: 999n }),
      ButterFeeLimitExceededError
    )
    assert.doesNotThrow(() => enforceFeeLimits(honest, context, { maxProtocolFeeBps: 1000n }))
  })

  it('rejects a malformed or negative feeConfig instead of leaking a raw error', () => {
    const malformed = feeRoute({ feeConfig: { feeType: 1, referrer: '0x0000000000000000000000000000000000000111', rateOrNativeFee: '12abc' } })
    const negative = feeRoute({ feeConfig: { feeType: 1, referrer: '0x0000000000000000000000000000000000000111', rateOrNativeFee: -100 } })

    // BigInt('12abc') used to escape quoteSwidge as a raw SyntaxError, and a negative
    // rate produced a negative SwidgeFee.amount plus a cap numerator that subtracted
    // from the total, letting a genuine fee through.
    assert.throws(() => mapRouteFees(malformed, context), ButterFeeValuationError)
    assert.throws(() => mapRouteFees(negative, context), ButterFeeValuationError)
    assert.throws(
      () => enforceFeeLimits(negative, context, { maxProtocolFeeBps: 10000n }),
      ButterFeeValuationError
    )
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
      bridgeFee: ZERO_BRIDGE_FEE,
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
      bridgeFee: ZERO_BRIDGE_FEE
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
      bridgeFee: ZERO_BRIDGE_FEE,
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

    // Fires from the fee MAPPING, so every quote sees it — not only an execution
    // that happens to have configured a cap.
    const fees = mapRouteFees(route, { ...context, onWarning: (warning) => warnings.push(warning) })

    // Also warns about mixed currencies, since the integrator fee is in USDC while
    // the bridge fee is in WETH.
    assert.ok(warnings.some(({ code }) => code === 'undeclared-integrator-fee'))
    // And the fee is shown as a real amount: 50 bps of the caller's 100 USDC input.
    assert.deepEqual(
      fees.filter(({ description }) => description?.startsWith('Butter integrator fee'))
        .map(({ amount, token }) => ({ amount, token })),
      [{ amount: 500000n, token: SOURCE_TOKEN }]
    )
  })

  it('omits the integrator fee amount but still warns without a requested input', () => {
    const warnings: ButterWarning[] = []
    const route = feeRoute({
      feeConfig: { feeType: 1, referrer: '0x0000000000000000000000000000000000000111', rateOrNativeFee: 50 },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' }
    })
    const { requestedAmountIn: _omitted, ...noInput } = context

    // A rate is not an amount: without the input there is nothing to multiply, so
    // the warning carries the signal on its own.
    const fees = mapRouteFees(route, { ...noInput, onWarning: (warning) => warnings.push(warning) })

    assert.deepEqual(warnings.map(({ code }) => code), ['undeclared-integrator-fee'])
    assert.ok(!fees.some(({ description }) => description?.startsWith('Butter integrator fee')))
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

    // 1 USDC of the caller's 100 = 100 bps, plus 1 WETH of the 99 leaving the bridge
    // = 1/99. Total 199/9900, i.e. 201.0101... bps. The outbound fee is measured
    // against totalAmountOut (99), not totalAmountIn (100) — that is the whole point
    // of tracking the component's role.
    assert.doesNotThrow(() => enforceFeeLimits(route, context, {
      maxNetworkFeeBps: 100n,
      maxProtocolFeeBps: 202n
    }))
    assert.throws(() => enforceFeeLimits(route, context, {
      maxProtocolFeeBps: 201n
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
