import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import ButterSwidgeProtocol, { type ButterRoute } from '../../src/index.ts'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const TRON_CHAIN_ID = '728126428'
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TRON_USDT_HEX = '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c'

describe('@butternetwork/wdk-protocol-swidge-butter', () => {
  it('reuses discovered Tron token decimals when quoting an equivalent hex route', async () => {
    let findTokenCalls = 0
    const fetch = async (rawUrl: string) => {
      const url = new URL(rawUrl)
      if (url.pathname === '/supportedTokenList') {
        return jsonResponse({
          errno: 0,
          data: [{
            chainId: TRON_CHAIN_ID,
            tokens: [{ chainId: TRON_CHAIN_ID, address: TRON_USDT, decimals: 6, symbol: 'USDT' }]
          }]
        })
      }
      if (url.pathname === '/findToken') {
        findTokenCalls += 1
        return jsonResponse({ errno: 2002, message: 'The Token not found' })
      }
      if (url.pathname === '/route') {
        assert.equal(url.searchParams.get('amount'), '1')
        assert.equal(url.searchParams.get('tokenInAddress'), TRON_USDT)
        return jsonResponse({ errno: 0, data: tronRoute() })
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    }
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: TRON_CHAIN_ID,
      entrance: 'wdk',
      fetch,
      now: () => 1_000
    })

    const tokens = await protocol.getSupportedTokens()
    assert.deepEqual(tokens, [{
      token: TRON_USDT,
      chain: TRON_CHAIN_ID,
      symbol: 'USDT',
      decimals: 6,
      address: TRON_USDT
    }])
    const quote = await protocol.quoteSwidge({
      fromToken: TRON_USDT,
      toToken: ZERO_ADDRESS,
      toChain: '137',
      fromTokenAmount: 1_000_000n,
      slippage: 0.02
    })

    assert.equal(findTokenCalls, 0)
    assert.equal(quote.fromTokenAmount, 1_000_000n)
  })
})

function tronRoute (): ButterRoute {
  return {
    hash: 'tron-route',
    timestamp: 1_000,
    hasLiquidity: true,
    timeEstimated: 120,
    srcChain: {
      chainId: TRON_CHAIN_ID,
      tokenIn: { address: TRON_USDT_HEX, decimals: 6, symbol: 'USDT' },
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

function jsonResponse (body: unknown) {
  return {
    ok: true,
    status: 200,
    async json () { return body }
  }
}
