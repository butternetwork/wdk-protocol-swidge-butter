import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import ButterSwidgeProtocol, {
  type ButterRoute,
  type ButterSwidgeProtocolConfig,
  type ButterWarning
} from '../src/index.ts'

const SOURCE_TOKEN = '0x00000000000000000000000000000000000000aa'
const BRIDGE_TOKEN = '0x00000000000000000000000000000000000000bb'
const DESTINATION_TOKEN = '0x00000000000000000000000000000000000000cc'
const SOLANA_CHAIN_ID = '1360108768460801'
const SOLANA_MINT = 'So11111111111111111111111111111111111111112'
const SOLANA_OTHER_MINT = 'so11111111111111111111111111111111111111112'
const BITCOIN_CHAIN_ID = '1360095883558913'
const RECIPIENT = 'destination-recipient'

function feeRoute (overrides: Partial<ButterRoute> = {}): ButterRoute {
  return {
    hash: 'fee-route',
    timestamp: 1_000,
    hasLiquidity: true,
    timeEstimated: 120,
    totalAmountInUSD: '100',
    srcChain: {
      chainId: '56',
      tokenIn: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDC' },
      tokenOut: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' },
      totalAmountIn: '100',
      totalAmountOut: '100'
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
      tokenOut: { address: DESTINATION_TOKEN, decimals: 6, symbol: 'USDT' },
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

interface ProtocolFixture {
  protocol: ButterSwidgeProtocol
  options: {
    fromToken: string
    toToken: string
    toChain: string
    recipient: string
    fromTokenAmount: bigint
    slippage: number
    maxNativeFee: bigint
  }
  calls: string[]
  sent: unknown[]
}

function protocolFixture (
  route: ButterRoute,
  overrides: Partial<ButterSwidgeProtocolConfig> = {}
): ProtocolFixture {
  const sourceChainId = String(route.srcChain?.chainId ?? '56')
  const sourceToken = route.srcChain?.tokenIn?.address ?? SOURCE_TOKEN
  const destinationChainId = String(route.dstChain?.chainId ?? sourceChainId)
  const destinationToken = route.dstChain?.tokenOut?.address ?? route.srcChain?.tokenOut?.address ?? DESTINATION_TOKEN
  const calls: string[] = []
  const sent: unknown[] = []
  const account = {
    async getAddress () { return 'source-sender' },
    async sendTransaction (transaction: unknown) {
      sent.push(transaction)
      return { hash: 'source-hash', fee: 7n }
    }
  }
  const config: ButterSwidgeProtocolConfig = {
    sourceChainId,
    entrance: 'wdk',
    now: () => 1_000,
    tokenDecimals: { [sourceToken]: 6 },
    nativeTokenDecimals: { [sourceChainId]: 6 },
    routerContracts: { [Number(sourceChainId)]: [] },
    transactionAdapters: { [sourceChainId]: (transaction) => transaction },
    fetch: async (rawUrl: string) => {
      const url = new URL(rawUrl)
      calls.push(url.pathname)
      if (url.pathname === '/route') return jsonResponse({ errno: 0, data: [route] })
      if (url.pathname === '/swap') {
        return jsonResponse({ errno: 0, data: [{ to: 'adapter-destination', value: '0', chainId: sourceChainId }] })
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    },
    ...overrides
  }
  return {
    protocol: new ButterSwidgeProtocol(account, config),
    options: {
      fromToken: sourceToken,
      toToken: destinationToken,
      toChain: destinationChainId,
      recipient: RECIPIENT,
      fromTokenAmount: 100_000_000n,
      slippage: 0.03,
      maxNativeFee: 0n
    },
    calls,
    sent
  }
}

function jsonResponse (body: unknown) {
  return {
    ok: true,
    status: 200,
    async json () { return body }
  }
}

describe('Butter fee handling through the public API', () => {
  it('maps each fee with its own token decimals and identifier', async () => {
    const { protocol, options } = protocolFixture(feeRoute())

    const quote = await protocol.quoteSwidge(options)

    assert.deepEqual(quote.fees.map(({ type, amount, token }) => ({ type, amount, token })), [
      { type: 'protocol', amount: 1_000_000_000_000_000_000n, token: BRIDGE_TOKEN },
      { type: 'network', amount: 1_000n, token: 'BNB' },
      { type: 'protocol', amount: 2_000n, token: 'BNB' },
      { type: 'protocol', amount: 1_000_000n, token: SOURCE_TOKEN }
    ])
  })

  it('reports mixed-currency protocol fees with exact warning details', async () => {
    const warnings: ButterWarning[] = []
    const { protocol, options } = protocolFixture(feeRoute(), {
      onWarning: (warning) => warnings.push(warning)
    })

    await protocol.quoteSwidge(options)

    assert.deepEqual(warnings, [{
      code: 'mixed-currency-protocol-fees',
      message: 'Butter protocol fees span multiple tokens; the WDK legacy bridgeFee scalar sums across denominations and is not meaningful — read fees[]',
      details: { tokens: [BRIDGE_TOKEN, 'BNB', SOURCE_TOKEN] }
    }])
  })

  it('returns the documented native placeholder when Butter reports no fees', async () => {
    const warnings: ButterWarning[] = []
    const route = feeRoute()
    delete route.bridgeFee
    delete route.gasFee
    delete route.swapFee
    const { protocol, options } = protocolFixture(route, {
      onWarning: (warning) => warnings.push(warning)
    })

    const quote = await protocol.quoteSwidge(options)

    assert.deepEqual(quote.fees, [{
      type: 'network',
      amount: 0n,
      token: 'native',
      chain: '56',
      included: false,
      description: 'Butter reported no fees for this route'
    }])
    assert.deepEqual(warnings, [{
      code: 'no-fees-reported',
      message: 'Butter reported no fees for this route; fees[] carries a zero-amount placeholder'
    }])
  })

  it('reports bridge components separately and never prices the forged summary', async () => {
    const route = feeRoute({
      bridgeFee: {
        amount: '999',
        address: BRIDGE_TOKEN,
        symbol: 'WETH',
        chainId: '22776',
        in: { amount: '2', token: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDC' } },
        out: { amount: '1', token: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' } }
      },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' }
    })
    const { protocol, options } = protocolFixture(route)

    const quote = await protocol.quoteSwidge(options)

    assert.deepEqual(quote.fees.map(({ type, amount, token }) => ({ type, amount, token })), [
      { type: 'protocol', amount: 2_000_000n, token: SOURCE_TOKEN },
      { type: 'protocol', amount: 1_000_000_000_000_000_000n, token: BRIDGE_TOKEN }
    ])
  })

  it('rounds display-only fees down but rejects the same precision in a cap decision', async () => {
    const route = feeRoute({
      bridgeFee: { amount: '0', out: { amount: '0', token: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' } } },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' },
      swapFee: { nativeFee: '0', tokenFee: '1.23456789', tokenSymbol: 'USDC' }
    })
    const quoteFixture = protocolFixture(route)
    const quote = await quoteFixture.protocol.quoteSwidge(quoteFixture.options)
    assert.equal(quote.fees.find(({ token }) => token === SOURCE_TOKEN)?.amount, 1_234_567n)

    const executionFixture = protocolFixture(route, { maxProtocolFeeBps: 500 })
    await assert.rejects(executionFixture.protocol.swidge(executionFixture.options), {
      name: 'ButterApiError',
      message: 'Token amount exceeds 6 decimal places: 1.23456789'
    })
    assert.deepEqual(executionFixture.calls, ['/route'])
    assert.deepEqual(executionFixture.sent, [])
  })

  it('counts affiliate fees toward the protocol cap while preserving their public type', async () => {
    const route = feeRoute({
      bridgeFee: {
        amount: '1',
        address: SOURCE_TOKEN,
        symbol: 'USDC',
        chainId: '56',
        affiliate: { amount: '1', token: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDC' } }
      },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDC' }
    })
    const quoteFixture = protocolFixture(route)
    const quote = await quoteFixture.protocol.quoteSwidge(quoteFixture.options)
    assert.deepEqual(quote.fees.map(({ type, amount }) => ({ type, amount })), [
      { type: 'affiliate', amount: 1_000_000n }
    ])

    const executionFixture = protocolFixture(route, { maxProtocolFeeBps: 99 })
    await assert.rejects(executionFixture.protocol.swidge(executionFixture.options), {
      name: 'ButterFeeLimitExceededError',
      message: 'Butter protocol fee exceeds the configured limit'
    })
    assert.deepEqual(executionFixture.calls, ['/route'])
    assert.deepEqual(executionFixture.sent, [])
  })

  it('fails closed when capped fee metadata is absent', async () => {
    const noGas = feeRoute()
    delete noGas.gasFee
    const networkFixture = protocolFixture(noGas, { maxNetworkFeeBps: 100 })
    await assert.rejects(networkFixture.protocol.swidge(networkFixture.options), {
      name: 'ButterFeeValuationError',
      message: 'Cannot enforce the Butter network fee cap: the route reports no gas fee amount'
    })

    const noBridgeComponents = feeRoute({
      bridgeFee: { amount: '0', address: BRIDGE_TOKEN, symbol: 'WETH' },
      swapFee: { nativeFee: '0', tokenFee: '0' }
    })
    const protocolFixtureWithoutBridge = protocolFixture(noBridgeComponents, { maxProtocolFeeBps: 100 })
    await assert.rejects(protocolFixtureWithoutBridge.protocol.swidge(protocolFixtureWithoutBridge.options), {
      name: 'ButterFeeValuationError',
      message: 'Cannot enforce the Butter protocol fee cap: the cross-chain route reports no in/out/affiliate bridge fee amount'
    })
    assert.deepEqual(networkFixture.sent, [])
    assert.deepEqual(protocolFixtureWithoutBridge.sent, [])
  })

  it('uses the per-call fee cap instead of the construction default', async () => {
    const route = feeRoute({
      bridgeFee: { amount: '0', out: { amount: '0', token: { address: BRIDGE_TOKEN, decimals: 18, symbol: 'WETH' } } },
      gasFee: { amount: '0', symbol: 'BNB', inUSD: '0' },
      swapFee: { nativeFee: '0', tokenFee: '1', tokenSymbol: 'USDC' }
    })
    const fixture = protocolFixture(route, { maxProtocolFeeBps: 200 })

    await assert.rejects(fixture.protocol.swidge(fixture.options, { maxProtocolFeeBps: 99 }), {
      name: 'ButterFeeLimitExceededError',
      message: 'Butter protocol fee exceeds the configured limit'
    })
    assert.deepEqual(fixture.calls, ['/route'])
    assert.deepEqual(fixture.sent, [])
  })
})

type SourceExpectation = 'source' | 'route' | 'refused-without-address' | 'refused-without-route-leg'

const SOURCE_TOKEN_MATRIX: readonly {
  name: string
  sourceChainId: string
  sourceToken: string
  componentToken: { address?: string, symbol?: string }
  expectation: SourceExpectation
}[] = [
  {
    name: 'matching Solana mint address',
    sourceChainId: SOLANA_CHAIN_ID,
    sourceToken: SOLANA_MINT,
    componentToken: { address: SOLANA_MINT, symbol: 'SOL' },
    expectation: 'source'
  },
  {
    name: 'differently cased Solana mint',
    sourceChainId: SOLANA_CHAIN_ID,
    sourceToken: SOLANA_MINT,
    componentToken: { address: SOLANA_OTHER_MINT, symbol: 'SOL' },
    expectation: 'refused-without-route-leg'
  },
  {
    name: 'symbol-only Solana native identifier',
    sourceChainId: SOLANA_CHAIN_ID,
    sourceToken: 'sol',
    componentToken: { symbol: 'SOL' },
    expectation: 'source'
  },
  {
    name: 'symbol-only Solana address source',
    sourceChainId: SOLANA_CHAIN_ID,
    sourceToken: SOLANA_MINT,
    componentToken: { symbol: 'SOL' },
    expectation: 'refused-without-address'
  },
  {
    name: 'matching EVM address with different case',
    sourceChainId: '56',
    sourceToken: SOURCE_TOKEN,
    componentToken: { address: `0x${SOURCE_TOKEN.slice(2).toUpperCase()}`, symbol: 'USDC' },
    expectation: 'source'
  },
  {
    name: 'foreign EVM address with a source symbol',
    sourceChainId: '56',
    sourceToken: SOURCE_TOKEN,
    componentToken: { address: BRIDGE_TOKEN, symbol: 'USDC' },
    expectation: 'route'
  },
  {
    name: 'symbol-only EVM source',
    sourceChainId: '56',
    sourceToken: SOURCE_TOKEN,
    componentToken: { symbol: 'USDC' },
    expectation: 'refused-without-address'
  },
  {
    name: 'symbol-only Bitcoin native identifier',
    sourceChainId: BITCOIN_CHAIN_ID,
    sourceToken: 'btc',
    componentToken: { symbol: 'BTC' },
    expectation: 'source'
  },
  {
    name: 'declared foreign address beats Bitcoin symbol',
    sourceChainId: BITCOIN_CHAIN_ID,
    sourceToken: 'btc',
    componentToken: { address: BRIDGE_TOKEN, symbol: 'BTC' },
    expectation: 'route'
  },
  {
    name: 'Solana symbol is not native on an EVM chain',
    sourceChainId: '56',
    sourceToken: 'sol',
    componentToken: { symbol: 'SOL' },
    expectation: 'refused-without-address'
  },
  {
    name: 'foreign token address cannot claim the source denominator by symbol',
    sourceChainId: SOLANA_CHAIN_ID,
    sourceToken: SOLANA_MINT,
    componentToken: { address: BRIDGE_TOKEN, symbol: 'SOL' },
    expectation: 'route'
  }
]

describe('source-token bridge fee identification through swidge', () => {
  for (const testCase of SOURCE_TOKEN_MATRIX) {
    it(testCase.name, async () => {
      const sourceTokenSymbol = testCase.sourceToken === 'btc'
        ? 'BTC'
        : testCase.sourceToken === 'sol' || testCase.sourceToken === SOLANA_MINT
          ? 'SOL'
          : 'USDC'
      const route = feeRoute({
        srcChain: {
          chainId: testCase.sourceChainId,
          tokenIn: { address: testCase.sourceToken, decimals: 6, symbol: sourceTokenSymbol },
          tokenOut: { address: BRIDGE_TOKEN, decimals: 6, symbol: 'BRIDGE' },
          totalAmountIn: '100',
          totalAmountOut: '200'
        },
        bridgeChain: {
          chainId: '22776',
          tokenIn: { address: BRIDGE_TOKEN, decimals: 6, symbol: 'BRIDGE' },
          tokenOut: { address: BRIDGE_TOKEN, decimals: 6, symbol: 'BRIDGE' },
          totalAmountIn: '200',
          totalAmountOut: '200'
        },
        bridgeFee: {
          amount: '1',
          chainId: '22776',
          out: { amount: '1', token: { ...testCase.componentToken, decimals: 6 } }
        },
        gasFee: { amount: '0', symbol: sourceTokenSymbol, inUSD: '0' },
        swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: sourceTokenSymbol }
      })
      const fixture = protocolFixture(route, { maxProtocolFeeBps: 75 })

      if (testCase.expectation === 'source') {
        await assert.rejects(fixture.protocol.swidge(fixture.options), {
          name: 'ButterFeeLimitExceededError',
          message: 'Butter protocol fee exceeds the configured limit'
        })
        assert.deepEqual(fixture.calls, ['/route'])
        assert.deepEqual(fixture.sent, [])
        return
      }

      if (testCase.expectation === 'route') {
        const result = await fixture.protocol.swidge(fixture.options)
        assert.equal(result.id, 'source-hash')
        assert.deepEqual(fixture.calls, ['/route', '/swap'])
        assert.deepEqual(fixture.sent, [{ to: 'adapter-destination', value: '0', chainId: testCase.sourceChainId }])
        return
      }

      const message = testCase.expectation === 'refused-without-address'
        ? 'Cannot value a Butter bridge fee component that names no token address and is not the source token'
        : 'Cannot value a Butter bridge fee component against a route amount in the same token'
      await assert.rejects(fixture.protocol.swidge(fixture.options), {
        name: 'ButterFeeValuationError',
        message
      })
      assert.deepEqual(fixture.calls, ['/route'])
      assert.deepEqual(fixture.sent, [])
    })
  }
})
