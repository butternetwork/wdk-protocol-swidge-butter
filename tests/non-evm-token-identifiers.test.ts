import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import ButterSwidgeProtocol, {
  ButterApiError,
  ButterConfigurationError,
  type ButterRoute
} from '../src/index.ts'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const SOLANA_CHAIN_ID = '1360108768460801'
const TRON_CHAIN_ID = '728126428'
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TRON_USDT_HEX = '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c'

describe('@butternetwork/wdk-protocol-swidge-butter', () => {
  it('rejects conflicting configured decimals across equivalent Tron forms', () => {
    assert.throws(
      () => new ButterSwidgeProtocol(undefined, {
        sourceChainId: TRON_CHAIN_ID,
        entrance: 'wdk',
        fetch: async () => jsonResponse({ errno: 0, data: [] }),
        tokenDecimals: { [TRON_USDT]: 6, [TRON_USDT_HEX]: 18 }
      }),
      { name: 'ButterConfigurationError', message: 'tokenDecimals has conflicting entries for the same token' }
    )
  })

})

describe('@butternetwork/wdk-protocol-swidge-butter', () => {
  it('sends Butter the canonical Solana native identifier', async () => {
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: SOLANA_CHAIN_ID,
      entrance: 'wdk',
      now: () => 1_000,
      fetch: async (rawUrl: string) => {
        const url = new URL(rawUrl)
        assert.equal(url.pathname, '/route')
        assert.equal(url.searchParams.get('tokenInAddress'), SOL_MINT)
        assert.equal(url.searchParams.get('amount'), '0.01')
        return jsonResponse({ errno: 0, data: solanaRoute() })
      }
    })

    const quote = await protocol.quoteSwidge({
      fromToken: 'sol',
      toToken: ZERO_ADDRESS,
      toChain: '56',
      fromTokenAmount: 10_000_000n,
      slippage: 0.02,
      recipient: '0x1111111111111111111111111111111111111111'
    })

    assert.equal(quote.fromTokenAmount, 10_000_000n)
    assert.deepEqual(quote.fees, [{
      type: 'network',
      amount: 5_000n,
      token: 'SOL',
      chain: SOLANA_CHAIN_ID,
      included: false,
      description: 'Estimated source chain gas fee'
    }])
  })

  it('accepts Tron hex decimals metadata for a Base58Check request', async () => {
    let findTokenCalls = 0
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: TRON_CHAIN_ID,
      entrance: 'wdk',
      now: () => 1_000,
      fetch: async (rawUrl: string) => {
        const url = new URL(rawUrl)
        if (url.pathname === '/findToken') {
          findTokenCalls += 1
          return jsonResponse({
            errno: 0,
            data: [{ chainId: TRON_CHAIN_ID, address: TRON_USDT_HEX, decimals: 6 }]
          })
        }
        if (url.pathname === '/route') {
          return jsonResponse({ errno: 0, data: tronRoute(TRON_USDT_HEX) })
        }
        throw new Error(`unexpected request: ${url.pathname}`)
      }
    })

    await protocol.quoteSwidge({
      fromToken: TRON_USDT,
      toToken: ZERO_ADDRESS,
      toChain: '137',
      fromTokenAmount: 1_000_000n,
      slippage: 0.02
    })

    assert.equal(findTokenCalls, 1)
  })

  it('rejects conflicting decimals for canonical-equal supported tokens', async () => {
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: TRON_CHAIN_ID,
      entrance: 'wdk',
      fetch: async () => jsonResponse({
        errno: 0,
        data: [{
          chainId: TRON_CHAIN_ID,
          tokens: [
            { chainId: TRON_CHAIN_ID, address: TRON_USDT, decimals: 6, symbol: 'USDT' },
            { chainId: TRON_CHAIN_ID, address: TRON_USDT_HEX, decimals: 18, symbol: 'USDT' }
          ]
        }]
      })
    })

    await assert.rejects(protocol.getSupportedTokens(), { name: 'ButterApiError', message: 'Butter supported-token list returned conflicting decimals for the same token' })
  })
})

function tronRoute (sourceToken: string): ButterRoute {
  return {
    hash: 'tron-route',
    timestamp: 1_000,
    hasLiquidity: true,
    timeEstimated: 120,
    srcChain: {
      chainId: TRON_CHAIN_ID,
      tokenIn: { address: sourceToken, decimals: 6, symbol: 'USDT' },
      totalAmountIn: '1',
      totalAmountOut: '1'
    },
    dstChain: {
      chainId: '137',
      tokenOut: { address: ZERO_ADDRESS, decimals: 18, symbol: 'POL' },
      totalAmountOut: '0.1'
    },
    minAmountOut: { amount: '0.09', symbol: 'POL' },
    swapFee: { nativeFee: '0', tokenFee: '0' },
    gasFee: { amount: '0', symbol: 'TRX', inUSD: '0' }
  }
}

function solanaRoute (): ButterRoute {
  return {
    hash: 'solana-route',
    timestamp: 1_000,
    hasLiquidity: true,
    timeEstimated: 120,
    srcChain: {
      chainId: SOLANA_CHAIN_ID,
      tokenIn: { address: SOL_MINT, decimals: 9, symbol: 'SOL' },
      totalAmountIn: '0.01',
      totalAmountOut: '0.01'
    },
    dstChain: {
      chainId: '56',
      tokenOut: { address: ZERO_ADDRESS, decimals: 18, symbol: 'BNB' },
      totalAmountOut: '0.001'
    },
    minAmountOut: { amount: '0.0009', symbol: 'BNB' },
    swapFee: { nativeFee: '0', tokenFee: '0' },
    gasFee: { amount: '0.000005', symbol: 'SOL', inUSD: '0' }
  }
}

function jsonResponse (body: unknown) {
  return {
    ok: true,
    status: 200,
    async json () { return body }
  }
}
