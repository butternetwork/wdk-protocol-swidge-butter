import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import ButterSwidgeProtocol, {
  ButterApiError,
  ButterFeeLimitExceededError,
  ButterFeeValuationError,
  type ButterRoute,
  type ButterWarning
} from '../src/index.ts'

const TRON_CHAIN_ID = '728126428'
const SOURCE_TOKEN = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const BRIDGE_TOKEN = '0x00000000000000000000000000000000000000bb'
const DESTINATION_TOKEN = '0x00000000000000000000000000000000000000cc'
const SENDER = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
const RECIPIENT = '0x0000000000000000000000000000000000000111'

function feeRoute (overrides: Partial<ButterRoute> = {}): ButterRoute {
  return {
    hash: 'fee-route',
    timestamp: 1_000,
    hasLiquidity: true,
    timeEstimated: 120,
    totalAmountInUSD: '100',
    srcChain: {
      chainId: TRON_CHAIN_ID,
      tokenIn: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDT' },
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
    gasFee: { amount: '0.001', symbol: 'TRX', inUSD: '1' },
    swapFee: { nativeFee: '0.002', tokenFee: '1', tokenSymbol: 'USDT' },
    minAmountOut: { amount: '99', symbol: 'USDT' },
    ...overrides
  }
}

function jsonResponse (body: unknown) {
  return {
    ok: true,
    status: 200,
    async json () { return body }
  }
}

function fetchForRoute (route: ButterRoute, swapCalls?: string[]) {
  return async (rawUrl: string) => {
    const url = new URL(rawUrl)
    if (url.pathname === '/route') return jsonResponse({ errno: 0, data: [route] })
    if (url.pathname === '/swap') {
      swapCalls?.push(url.pathname)
      return jsonResponse({ errno: 0, data: [{ to: 'tron-router', value: '0', chainId: TRON_CHAIN_ID }] })
    }
    throw new Error(`unexpected request: ${url.pathname}`)
  }
}

function quoteProtocol (route: ButterRoute, onWarning?: (warning: ButterWarning) => void) {
  return new ButterSwidgeProtocol(undefined, {
    sourceChainId: TRON_CHAIN_ID,
    entrance: 'wdk',
    fetch: fetchForRoute(route),
    now: () => 1_000,
    tokenDecimals: { [SOURCE_TOKEN]: 6 },
    nativeTokenDecimals: { [TRON_CHAIN_ID]: 6 },
    ...(onWarning ? { onWarning } : {})
  })
}

function executionProtocol (
  route: ButterRoute,
  limits: { maxNetworkFeeBps?: bigint, maxProtocolFeeBps?: bigint }
) {
  const swapCalls: string[] = []
  const protocol = new ButterSwidgeProtocol({
    getAddress: async () => SENDER,
    sendTransaction: async () => 'tron-source-hash'
  }, {
    sourceChainId: TRON_CHAIN_ID,
    entrance: 'wdk',
    fetch: fetchForRoute(route, swapCalls),
    now: () => 1_000,
    tokenDecimals: { [SOURCE_TOKEN]: 6 },
    nativeTokenDecimals: { [TRON_CHAIN_ID]: 6 },
    transactionAdapters: { [TRON_CHAIN_ID]: (transaction) => transaction },
    maxNativeFee: 0n,
    ...limits
  })
  return { protocol, swapCalls }
}

const options = {
  fromToken: SOURCE_TOKEN,
  toToken: DESTINATION_TOKEN,
  toChain: '137',
  recipient: RECIPIENT,
  fromTokenAmount: 100_000_000n,
  slippage: 0.02
}

describe('Butter fee handling through the public protocol API', () => {
  it('maps every reported fee with its own token decimals', async () => {
    const quote = await quoteProtocol(feeRoute()).quoteSwidge(options)

    assert.deepEqual(quote.fees, [
      {
        type: 'protocol',
        amount: 1_000_000_000_000_000_000n,
        token: BRIDGE_TOKEN,
        chain: '22776',
        included: true,
        description: 'Butter outbound bridge fee'
      },
      {
        type: 'network',
        amount: 1_000n,
        token: 'TRX',
        chain: TRON_CHAIN_ID,
        included: false,
        description: 'Estimated source chain gas fee'
      },
      {
        type: 'protocol',
        amount: 2_000n,
        token: 'TRX',
        chain: TRON_CHAIN_ID,
        included: false,
        description: 'Butter native swap fee'
      },
      {
        type: 'protocol',
        amount: 1_000_000n,
        token: SOURCE_TOKEN,
        chain: TRON_CHAIN_ID,
        included: true,
        description: 'Butter token swap fee'
      }
    ])
  })

  it('warns when protocol fees span multiple token denominations', async () => {
    const warnings: ButterWarning[] = []

    await quoteProtocol(feeRoute(), (warning) => warnings.push(warning)).quoteSwidge(options)

    assert.deepEqual(warnings.map(({ code }) => code), ['mixed-currency-protocol-fees'])
  })

  it('uses the caller input as the denominator for a source-token bridge fee', async () => {
    const route = feeRoute({
      srcChain: { ...feeRoute().srcChain, totalAmountIn: '1000000' },
      bridgeFee: {
        amount: '1',
        address: SOURCE_TOKEN,
        symbol: 'USDT',
        chainId: TRON_CHAIN_ID,
        in: { amount: '1', token: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDT' } }
      },
      gasFee: { amount: '0', symbol: 'TRX', inUSD: '0' },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDT' }
    })
    const { protocol, swapCalls } = executionProtocol(route, { maxProtocolFeeBps: 99n })

    await assert.rejects(protocol.swidge(options), ButterFeeLimitExceededError)
    assert.deepEqual(swapCalls, [])
  })

  it('includes the affiliate component in the protocol fee cap', async () => {
    const route = feeRoute({
      bridgeFee: {
        amount: '2',
        address: SOURCE_TOKEN,
        symbol: 'USDT',
        chainId: TRON_CHAIN_ID,
        affiliate: { amount: '2', token: { address: SOURCE_TOKEN, decimals: 6, symbol: 'USDT' } }
      },
      gasFee: { amount: '0', symbol: 'TRX', inUSD: '0' },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDT' }
    })
    const { protocol, swapCalls } = executionProtocol(route, { maxProtocolFeeBps: 199n })

    await assert.rejects(protocol.swidge(options), ButterFeeLimitExceededError)
    assert.deepEqual(swapCalls, [])
  })

  it('fails closed when a cross-chain fee cap sees only a bridge summary', async () => {
    const route = feeRoute({
      bridgeFee: { amount: '0', address: BRIDGE_TOKEN, symbol: 'WETH', chainId: '22776' },
      gasFee: { amount: '0', symbol: 'TRX', inUSD: '0' },
      swapFee: { nativeFee: '0', tokenFee: '0', tokenSymbol: 'USDT' }
    })
    const { protocol, swapCalls } = executionProtocol(route, { maxProtocolFeeBps: 0n })

    await assert.rejects(protocol.swidge(options), ButterFeeValuationError)
    assert.deepEqual(swapCalls, [])
  })

  it('rejects route source decimals that disagree with locally resolved metadata', async () => {
    const route = feeRoute({
      srcChain: {
        ...feeRoute().srcChain,
        tokenIn: { address: SOURCE_TOKEN, decimals: 0, symbol: 'USDT' }
      }
    })

    await assert.rejects(quoteProtocol(route).quoteSwidge(options), ButterApiError)
  })
})
