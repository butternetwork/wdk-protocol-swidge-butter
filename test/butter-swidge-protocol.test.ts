import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  parseAbiParameters,
  zeroHash
} from 'viem'

import ButterSwidgeProtocol, {
  ButterActionRequiredError,
  ButterApiError,
  ButterConfigurationError,
  ButterExactOutUnsupportedError,
  ButterFeeLimitExceededError,
  ButterReadOnlyAccountError,
  ButterTransactionValidationError,
  ButterUnsupportedError,
  parseTokenAmount,
  toButterSlippage
} from '../src/index.ts'
import { createRouterRegistry, routerDeploymentsForChain } from '../src/router-registry.ts'
import { validateSwapTransaction } from '../src/swap-data.ts'

function jsonResponse (body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    async json () {
      return body
    }
  }
}

function makeFetch (routes: Record<string, (url: URL, init: { headers?: Record<string, string> }) => Promise<unknown> | unknown>) {
  const calls: Array<{ url: URL, init: { headers?: Record<string, string> } }> = []
  const fetch = async (url: string, init: { headers?: Record<string, string> } = {}) => {
    const parsed = new URL(url)
    calls.push({ url: parsed, init })
    const handler = routes[parsed.pathname]
    if (!handler) throw new Error(`unexpected request: ${parsed.pathname}`)
    return jsonResponse(await handler(parsed, init))
  }
  return Object.assign(fetch, { calls })
}

function quoteRoute (overrides: Record<string, unknown> = {}) {
  return {
    hash: '0xroute',
    timestamp: 1000,
    hasLiquidity: true,
    timeEstimated: 120,
    contract: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A',
    bridgeFee: {
      amount: '0.25',
      symbol: 'USDT',
      address: '0xfee',
      chainId: '56',
      out: { amount: '0.25', token: { address: '0xfee', decimals: 6, symbol: 'USDT' } }
    },
    gasFee: { amount: '0.0001', symbol: 'BNB' },
    swapFee: { nativeFee: '0', tokenFee: '0.02' },
    minAmountOut: { amount: '9.5', symbol: 'USDT' },
    srcChain: {
      chainId: '56',
      tokenIn: { address: '0xfrom', decimals: 18, symbol: 'BNB' },
      totalAmountIn: '1.5',
      totalAmountOut: '1.5'
    },
    dstChain: {
      chainId: '137',
      tokenOut: { address: '0xto', decimals: 6, symbol: 'USDT' },
      totalAmountOut: '10.25'
    },
    ...overrides
  }
}

const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000'
const ERC20_TOKEN = '0x00000000000000000000000000000000000000aa'
const DEST_TOKEN = '0x00000000000000000000000000000000000000cc'
const VALID_SENDER = '0x0000000000000000000000000000000000000111'
const VALID_RECIPIENT = '0x0000000000000000000000000000000000000222'
const ROUTER = '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A'
const DEFAULT_TOKEN_DECIMALS = { '0xfrom': 18, '0xto': 6 }
const ERC20_TOKEN_DECIMALS = { [ERC20_TOKEN]: 18, [DEST_TOKEN]: 6 }

const routerV3Abi = parseAbi([
  'function swapAndBridge(bytes32 transferId,address initiator,address srcToken,uint256 amount,bytes swapData,bytes bridgeData,bytes permitData,bytes feeData)',
  'function swapAndCall(bytes32 transferId,address initiator,address srcToken,uint256 amount,bytes swapData,bytes callbackData,bytes permitData,bytes feeData)'
])
const swapParamAbi = parseAbiParameters(
  '(address dstToken,address receiver,address leftReceiver,uint256 minAmount,(uint8 dexType,address callTo,address approveTo,uint256 fromAmount,bytes callData)[] swaps)'
)
const bridgeParamAbi = parseAbiParameters('(uint256 toChain,uint256 nativeFee,bytes receiver,bytes data)')
const bridgeAdapterParamAbi = parseAbiParameters('(uint256 gasLimit,bytes refundAddress,bytes swapData)')
const remoteSwapAndCallAbi = parseAbiParameters('bytes swapData,bytes callbackData')

function crossChainSwapData (sourceToken: `0x${string}`, amount: bigint, options: {
  destinationReceiver?: `0x${string}`
  destinationToken?: `0x${string}`
  callbackData?: `0x${string}`
  nativeFee?: bigint
} = {}): `0x${string}` {
  const swapData = encodeAbiParameters(swapParamAbi, [{
    dstToken: DEST_TOKEN,
    receiver: VALID_SENDER,
    leftReceiver: VALID_SENDER,
    minAmount: 1n,
    swaps: []
  }])
  const destinationSwapData = encodeAbiParameters(swapParamAbi, [{
    dstToken: options.destinationToken ?? DEST_TOKEN,
    receiver: options.destinationReceiver ?? VALID_RECIPIENT,
    leftReceiver: options.destinationReceiver ?? VALID_RECIPIENT,
    minAmount: 9500000n,
    swaps: []
  }])
  const remoteSwapAndCall = encodeAbiParameters(remoteSwapAndCallAbi, [
    destinationSwapData,
    options.callbackData ?? '0x'
  ])
  const bridgeAdapterData = encodeAbiParameters(bridgeAdapterParamAbi, [{
    gasLimit: 500000n,
    refundAddress: VALID_SENDER,
    swapData: remoteSwapAndCall
  }])
  const bridgeData = encodeAbiParameters(bridgeParamAbi, [{
    toChain: 137n,
    nativeFee: options.nativeFee ?? 0n,
    receiver: ROUTER,
    data: bridgeAdapterData
  }])
  return encodeFunctionData({
    abi: routerV3Abi,
    functionName: 'swapAndBridge',
    args: [zeroHash, VALID_SENDER, sourceToken, amount, swapData, bridgeData, '0x', '0x']
  })
}

function sourceChainWithToken (address: string, symbol = 'BNB') {
  return {
    chainId: '56',
    tokenIn: { address, decimals: 18, symbol },
    totalAmountIn: '1.5',
    totalAmountOut: '1.5'
  }
}

function sameChainSwapDataFor (sourceToken: `0x${string}`, amount: bigint): `0x${string}` {
  const swapData = encodeAbiParameters(swapParamAbi, [{
    dstToken: DEST_TOKEN,
    receiver: VALID_RECIPIENT,
    leftReceiver: VALID_SENDER,
    minAmount: 9500000n,
    swaps: []
  }])
  return encodeFunctionData({
    abi: routerV3Abi,
    functionName: 'swapAndCall',
    args: [zeroHash, VALID_SENDER, sourceToken, amount, swapData, '0x', '0x', '0x']
  })
}

describe('ButterSwidgeProtocol formal behavior', () => {
  let account: { getAddress: () => Promise<string>, sendTransaction: (tx: unknown) => Promise<{ hash: string, tx: unknown }> }

  beforeEach(() => {
    account = {
      async getAddress () { return VALID_SENDER },
      async sendTransaction (tx) { return { hash: '0xsourcehash', tx } }
    }
  })

  it('quotes through /route with auth headers and maps amounts, fees, and expiry', async () => {
    const fetch = makeFetch({
      '/route': async (url, init) => {
        assert.equal(url.searchParams.get('fromChainId'), '56')
        assert.equal(url.searchParams.get('toChainId'), '137')
        assert.equal(url.searchParams.get('amount'), '1.5')
        assert.equal(url.searchParams.get('tokenInAddress'), '0xfrom')
        assert.equal(url.searchParams.get('tokenOutAddress'), '0xto')
        assert.equal(url.searchParams.get('type'), 'exactIn')
        assert.equal(url.searchParams.get('slippage'), '200')
        assert.equal(url.searchParams.get('receiver'), '0xrecipient')
        assert.equal(url.searchParams.get('entrance'), 'wdk')
        assert.equal(init.headers?.['x-api-key-id'], 'key')
        assert.equal(init.headers?.Authorization, 'Bearer secret')
        return { errno: 0, message: 'success', data: [quoteRoute()] }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS
    })

    const quote = await protocol.quoteSwidge({
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 137,
      recipient: '0xrecipient',
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    })

    assert.equal(quote.fromTokenAmount, 1500000000000000000n)
    assert.equal(quote.toTokenAmount, 10250000n)
    assert.equal(quote.toTokenAmountMin, 9500000n)
    assert.equal(quote.estimatedDuration, 120)
    assert.equal(quote.expiry, 1300)
    assert.deepEqual(quote.fees.map((fee) => fee.type), ['protocol', 'network', 'protocol'])
  })

  it('uses an earlier Butter route timestamp without allowing it to extend the local TTL', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({ timestamp: 900 })]
      })
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS
    })

    const quote = await protocol.quoteSwidge({
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 137,
      recipient: '0xrecipient',
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    })

    assert.equal(quote.expiry, 1200)
  })

  it('caps a future Butter route timestamp to the local quote TTL', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({ timestamp: 999999 })]
      })
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS
    })

    const quote = await protocol.quoteSwidge({
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 137,
      recipient: '0xrecipient',
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    })

    assert.equal(quote.expiry, 1300)
  })

  it('sends the same validated slippage to /route and /swap', async () => {
    const fetch = makeFetch({
      '/route': async (url) => {
        assert.equal(url.searchParams.get('slippage'), '200')
        return {
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            swapFee: { nativeFee: '0.01', tokenFee: '0' },
            srcChain: sourceChainWithToken(NATIVE_TOKEN),
            dstChain: {
              chainId: '137',
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountOut: '10.25'
            }
          })]
        }
      },
      '/swap': async (url) => {
        assert.equal(url.searchParams.get('hash'), '0xroute')
        assert.equal(url.searchParams.get('slippage'), '200')
        assert.equal(url.searchParams.get('from'), VALID_SENDER)
        assert.equal(url.searchParams.get('receiver'), VALID_RECIPIENT)
        return {
          errno: 0,
          message: 'success',
          data: [{
            to: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A',
            value: '1510000000000000000',
            data: crossChainSwapData(NATIVE_TOKEN, 1500000000000000000n, { nativeFee: 10000000000000000n }),
            chainId: '56',
            method: 'swapAndBridge'
          }]
        }
      }
    })
    const sent: unknown[] = []
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000,
      evm: {
        sendTransaction: async (tx) => {
          sent.push(tx)
          return '0xsourcehash'
        }
      }
    })

    const options = {
      fromToken: NATIVE_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }
    await protocol.quoteSwidge(options)
    const result = await protocol.swidge(options)

    assert.equal(result.id, '0xsourcehash')
    assert.deepEqual(result.transactions, [{ hash: '0xsourcehash', chain: '56', type: 'source' }])
    assert.equal(sent.length, 1)
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 1)
  })

  it('executes without requiring a previous quote', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          swapFee: { nativeFee: '0', tokenFee: '0' },
          srcChain: sourceChainWithToken(NATIVE_TOKEN),
          dstChain: {
            chainId: '137',
            tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
            totalAmountOut: '10.25'
          }
        })]
      }),
      '/swap': async () => ({
        errno: 0,
        message: 'success',
        data: [{
          to: ROUTER,
          value: '1500000000000000000',
          data: crossChainSwapData(NATIVE_TOKEN, 1500000000000000000n),
          chainId: '56',
          method: 'swapAndBridge'
        }]
      })
    })
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      evm: { sendTransaction: async () => '0xsourcehash' }
    })

    const result = await protocol.swidge({
      fromToken: NATIVE_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    })

    assert.equal(result.id, '0xsourcehash')
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 1)
  })

  it('executes legacy swap without a previous quote', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          bridgeFee: undefined,
          gasFee: undefined,
          swapFee: undefined,
          srcChain: {
            chainId: '56',
            tokenIn: { address: ERC20_TOKEN, decimals: 18, symbol: 'FROM' },
            tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
            totalAmountIn: '1.5',
            totalAmountOut: '10.25'
          },
          dstChain: undefined
        })]
      }),
      '/swap': async () => ({
        errno: 0,
        message: 'success',
        data: [{
          to: ROUTER,
          value: '0',
          data: sameChainSwapDataFor(ERC20_TOKEN, 1500000000000000000n),
          chainId: '56',
          method: 'swapAndCall'
        }]
      })
    })
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      tokenDecimals: ERC20_TOKEN_DECIMALS,
      evm: {
        publicClient: { readContract: async () => 1500000000000000000n },
        sendTransaction: async () => '0xsourcehash'
      }
    })

    const result = await protocol.swap({
      tokenIn: ERC20_TOKEN,
      tokenOut: DEST_TOKEN,
      tokenInAmount: 1500000000000000000n,
      to: VALID_RECIPIENT
    })

    assert.equal(result.hash, '0xsourcehash')
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 1)
  })

  it('executes legacy bridge without a previous quote', async () => {
    const bitcoinChain = '1360095883558913'
    const fetch = makeFetch({
      '/route': async (url) => {
        assert.equal(url.searchParams.get('slippage'), '300')
        return {
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            bridgeFee: undefined,
            gasFee: undefined,
            swapFee: undefined,
            contract: undefined,
            srcChain: {
              chainId: bitcoinChain,
              tokenIn: { address: 'btc', decimals: 8, symbol: 'BTC' },
              totalAmountIn: '1',
              totalAmountOut: '1'
            },
            dstChain: {
              chainId: '137',
              tokenOut: { address: 'btc', decimals: 8, symbol: 'BTC' },
              totalAmountOut: '1'
            },
            minAmountOut: { amount: '0.99', symbol: 'BTC' }
          })]
        }
      },
      '/swap': async () => ({
        errno: 0,
        message: 'success',
        data: [{ to: 'btc-deposit', value: '0', chainId: bitcoinChain }]
      })
    })
    const protocol = new ButterSwidgeProtocol({
      getAddress: async () => 'btc-sender',
      sendTransaction: async () => 'btc-hash'
    }, {
      sourceChainId: bitcoinChain,
      entrance: 'wdk',
      fetch,
      transactionAdapters: {
        [bitcoinChain]: (tx) => tx
      }
    })

    const result = await protocol.bridge({
      token: 'btc',
      amount: 100000000n,
      targetChain: 137,
      recipient: 'btc-recipient'
    })

    assert.equal(result.hash, 'btc-hash')
  })

  it('refreshes an expired confirmed quote before execution', async () => {
    let now = 1000
    let routeRequests = 0
    const fetch = makeFetch({
      '/route': async () => {
        routeRequests++
        return {
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            hash: `0xroute${routeRequests}`,
            timestamp: now,
            swapFee: { nativeFee: '0', tokenFee: '0' },
            srcChain: sourceChainWithToken(NATIVE_TOKEN),
            dstChain: {
              chainId: '137',
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountOut: '10.25'
            }
          })]
        }
      },
      '/swap': async (url) => {
        assert.equal(url.searchParams.get('hash'), '0xroute2')
        return {
          errno: 0,
          message: 'success',
          data: [{
            to: ROUTER,
            value: '1500000000000000000',
            data: crossChainSwapData(NATIVE_TOKEN, 1500000000000000000n),
            chainId: '56',
            method: 'swapAndBridge'
          }]
        }
      }
    })
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => now,
      evm: { sendTransaction: async () => '0xsourcehash' }
    })
    const options = {
      fromToken: NATIVE_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }

    await protocol.quoteSwidge(options)
    now = 1300

    const result = await protocol.swidge(options)

    assert.equal(result.id, '0xsourcehash')
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 2)
  })

  it('applies per-call fee limits before requesting swap data', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          bridgeFee: undefined,
          gasFee: { amount: '0.1', symbol: 'BNB' },
          swapFee: { nativeFee: '0', tokenFee: '0' },
          srcChain: sourceChainWithToken(NATIVE_TOKEN),
          dstChain: {
            chainId: '137',
            tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
            totalAmountOut: '10.25'
          }
        })]
      })
    })
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      maxNetworkFeeBps: 700,
      evm: { sendTransaction: async () => '0xshould-not-send' }
    })

    await assert.rejects(protocol.swidge({
      fromToken: NATIVE_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }, { maxNetworkFeeBps: 600 }), ButterFeeLimitExceededError)
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/swap').length, 0)
  })

  it('rejects slippage below Butter cross-chain floor instead of silently increasing it', () => {
    assert.throws(() => toButterSlippage(0.01, { crossChain: true }), ButterActionRequiredError)
  })

  it('enforces minAmountOut locally when Butter has no request parameter for it', async () => {
    const fetch = makeFetch({
      '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute()] })
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS
    })

    await assert.rejects(
      protocol.quoteSwidge({
        fromToken: '0xfrom',
        toToken: '0xto',
        toChain: 137,
        recipient: '0xrecipient',
        fromTokenAmount: 1500000000000000000n,
        minAmountOut: 9600000n,
        slippage: 0.02
      }),
      ButterActionRequiredError
    )
  })

  it('rejects malicious swap targets outside the router allowlist before signing', async () => {
    const fetch = makeFetch({
      '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute({ contract: '0x000000000000000000000000000000000000dEaD' })] }),
      '/swap': async () => ({
        errno: 0,
        message: 'success',
        data: [{ to: '0x000000000000000000000000000000000000dEaD', value: '0x0', data: '0xabcdef', chainId: '56', method: 'swapAndBridge' }]
      })
    })
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS,
      evm: {
        publicClient: { async readContract () { return 0n } },
        sendTransaction: async () => '0xshould-not-send'
      }
    })

    const options = {
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 137,
      recipient: '0xrecipient',
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }
    await protocol.quoteSwidge(options)
    await assert.rejects(protocol.swidge(options), ButterApiError)
  })

  it('rejects native swap data whose value exceeds the requested input amount', async () => {
    const fetch = makeFetch({
      '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute({ srcChain: sourceChainWithToken(NATIVE_TOKEN) })] }),
      '/swap': async () => ({
        errno: 0,
        message: 'success',
        data: [{
          to: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A',
          value: '0x29a2241af62c0000',
          data: '0xabcdef',
          chainId: '56',
          method: 'swapAndBridge'
        }]
      })
    })
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000,
      evm: { sendTransaction: async () => '0xsourcehash' }
    })

    const options = {
      fromToken: NATIVE_TOKEN,
      toToken: '0xto',
      toChain: 137,
      recipient: '0xrecipient',
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }
    await protocol.quoteSwidge(options)
    await assert.rejects(protocol.swidge(options), ButterApiError)
  })

  it('rejects route responses that do not match the requested source token', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          srcChain: {
            chainId: '56',
            tokenIn: { address: '0xother', decimals: 18, symbol: 'BNB' },
            totalAmountIn: '1.5',
            totalAmountOut: '1.5'
          }
        })]
      })
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS
    })

    await assert.rejects(
      protocol.quoteSwidge({
        fromToken: '0xfrom',
        toToken: '0xto',
        toChain: 137,
        recipient: '0xrecipient',
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }),
      ButterApiError
    )
  })

  it('rejects authenticated clients configured with non-HTTPS Butter base URLs', () => {
    assert.throws(
      () => new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        routerBaseUrl: 'http://example.test',
        fetch: makeFetch({})
      }),
      ButterConfigurationError
    )
  })

  it('rejects missing required Butter integration metadata at construction time', () => {
    assert.throws(
      () => new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: '',
        authMode: 'optional',
        fetch: makeFetch({})
      }),
      ButterConfigurationError
    )
  })

  it('checks ERC20 allowance, approves exact amount, waits, then swaps', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          swapFee: { nativeFee: '0.01', tokenFee: '0' },
          srcChain: sourceChainWithToken(ERC20_TOKEN),
          dstChain: {
            chainId: '137',
            tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
            totalAmountOut: '10.25'
          }
        })]
      }),
      '/swap': async () => ({
        errno: 0,
        message: 'success',
        data: [{
          to: ROUTER,
          value: '10000000000000000',
          data: crossChainSwapData(ERC20_TOKEN, 1500000000000000000n, { nativeFee: 10000000000000000n }),
          chainId: '56',
          method: 'swapAndBridge'
        }]
      })
    })
    const sent: unknown[] = []
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000,
      tokenDecimals: ERC20_TOKEN_DECIMALS,
      evm: {
        publicClient: {
          async readContract () { return 0n },
          async waitForTransactionReceipt (args) {
            assert.equal(args.hash, '0xapproval')
          }
        },
        sendTransaction: async (tx) => {
          sent.push(tx)
          return sent.length === 1 ? '0xapproval' : '0xsourcehash'
        }
      }
    })

    const options = {
      fromToken: ERC20_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }
    await protocol.quoteSwidge(options)
    const result = await protocol.swidge(options)

    assert.deepEqual(result.transactions, [
      { hash: '0xapproval', chain: '56', type: 'approval' },
      { hash: '0xsourcehash', chain: '56', type: 'source' }
    ])
    assert.equal(sent.length, 2)
    const approval = decodeFunctionData({ abi: erc20Abi, data: (sent[0] as { data: `0x${string}` }).data })
    assert.equal(approval.functionName, 'approve')
    assert.equal(approval.args[1], 1500000000000000000n)
  })

  it('executes ERC20 swidge through a plain WDK account with zero viem configuration', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          swapFee: { nativeFee: '0.01', tokenFee: '0' },
          srcChain: sourceChainWithToken(ERC20_TOKEN),
          dstChain: {
            chainId: '137',
            tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
            totalAmountOut: '10.25'
          }
        })]
      }),
      '/swap': async () => ({
        errno: 0,
        message: 'success',
        data: [{
          to: ROUTER,
          value: '10000000000000000',
          data: crossChainSwapData(ERC20_TOKEN, 1500000000000000000n, { nativeFee: 10000000000000000n }),
          chainId: '56',
          method: 'swapAndBridge'
        }]
      })
    })
    const sent: unknown[] = []
    const receiptQueries: string[] = []
    const accountOnly = {
      async getAddress () { return VALID_SENDER },
      async sendTransaction (tx: unknown) {
        sent.push(tx)
        return { hash: sent.length === 1 ? '0xapproval' : '0xsourcehash', fee: 21000n }
      },
      async getTransactionReceipt (hash: string) {
        receiptQueries.push(hash)
        return { status: 'success' }
      }
    }
    const protocol = new ButterSwidgeProtocol(accountOnly, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000,
      tokenDecimals: ERC20_TOKEN_DECIMALS
    })

    const result = await protocol.swidge({
      fromToken: ERC20_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    })

    // Without a publicClient the allowance read is skipped: an approval is
    // always submitted and confirmed via the account's own receipt lookup.
    assert.deepEqual(result.transactions, [
      { hash: '0xapproval', chain: '56', type: 'approval' },
      { hash: '0xsourcehash', chain: '56', type: 'source' }
    ])
    assert.equal(result.id, '0xsourcehash')
    assert.equal(sent.length, 2)
    assert.deepEqual(receiptQueries, ['0xapproval'])
    const approval = decodeFunctionData({ abi: erc20Abi, data: (sent[0] as { data: `0x${string}` }).data })
    assert.equal(approval.functionName, 'approve')
    assert.deepEqual(approval.args, [ROUTER, 1500000000000000000n])
  })

  it('times out when an account-confirmed approval never lands', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          swapFee: { nativeFee: '0', tokenFee: '0' },
          srcChain: sourceChainWithToken(ERC20_TOKEN),
          dstChain: {
            chainId: '137',
            tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
            totalAmountOut: '10.25'
          }
        })]
      }),
      '/swap': async () => ({
        errno: 0,
        message: 'success',
        data: [{
          to: ROUTER,
          value: '0',
          data: crossChainSwapData(ERC20_TOKEN, 1500000000000000000n),
          chainId: '56',
          method: 'swapAndBridge'
        }]
      })
    })
    const protocol = new ButterSwidgeProtocol({
      async getAddress () { return VALID_SENDER },
      async sendTransaction () { return '0xapproval' },
      async getTransactionReceipt () { return null }
    }, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000,
      tokenDecimals: ERC20_TOKEN_DECIMALS,
      evm: { approvalTimeoutMs: 20 }
    })

    await assert.rejects(protocol.swidge({
      fromToken: ERC20_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }), (error: unknown) => error instanceof ButterConfigurationError && error.message.includes('Timed out'))
  })

  it('resolves missing token decimals through Butter /findToken', async () => {
    const fetch = makeFetch({
      '/findToken': async (url) => {
        assert.equal(url.searchParams.get('chainId'), '56')
        assert.equal(url.searchParams.get('address'), ERC20_TOKEN)
        return { errno: 0, message: 'success', data: [{ chainId: 56, address: ERC20_TOKEN, decimals: 18, symbol: 'FROM' }] }
      },
      '/route': async (url) => {
        assert.equal(url.searchParams.get('amount'), '1.5')
        return {
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            srcChain: sourceChainWithToken(ERC20_TOKEN),
            dstChain: {
              chainId: '137',
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountOut: '10.25'
            }
          })]
        }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000
    })
    const options = {
      fromToken: ERC20_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }

    const quote = await protocol.quoteSwidge(options)

    assert.equal(quote.fromTokenAmount, 1500000000000000000n)
    // The /findToken lookup is cached: a second quote must not re-query it.
    await protocol.quoteSwidge({ ...options, fromTokenAmount: 1500000000000000000n })
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/findToken').length, 1)
  })

  it('still requires configured decimals when Butter does not know the token', async () => {
    const fetch = makeFetch({
      '/findToken': async () => ({ errno: 2002, message: 'The Token not found' })
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch
    })

    await assert.rejects(protocol.quoteSwidge({
      fromToken: ERC20_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      fromTokenAmount: 1n,
      slippage: 0.02
    }), ButterActionRequiredError)
  })

  it('caches a Butter token-not-found miss instead of re-querying /findToken', async () => {
    const fetch = makeFetch({
      '/findToken': async () => ({ errno: 2002, message: 'The Token not found' })
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch
    })
    const options = { fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }

    await assert.rejects(protocol.quoteSwidge(options), ButterActionRequiredError)
    await assert.rejects(protocol.quoteSwidge(options), ButterActionRequiredError)
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/findToken').length, 1)
  })

  it('does not mask a /findToken transport failure as an unknown token', async () => {
    const fetch = makeFetch({
      '/findToken': async () => { throw new Error('network down') }
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch
    })

    await assert.rejects(
      protocol.quoteSwidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }),
      (error: unknown) => error instanceof Error && error.message.includes('network down')
    )
  })

  it('rejects a raw evm.sendTransaction with no address source using a specific error', async () => {
    const fetch = makeFetch({})
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      evm: { sendTransaction: async () => '0xshould-not-send' }
    })

    await assert.rejects(
      protocol.swidge({ fromToken: NATIVE_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }),
      (error: unknown) => error instanceof ButterConfigurationError && /sender address/.test(error.message)
    )
    assert.equal(fetch.calls.length, 0)
  })

  it('rejects when account and evm.walletClient sender addresses diverge', async () => {
    const fetch = makeFetch({
      '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute()] })
    })
    const protocol = new ButterSwidgeProtocol({ getAddress: async () => VALID_SENDER, sendTransaction: async () => '0xhash' }, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS,
      evm: { walletClient: { account: { address: VALID_RECIPIENT }, sendTransaction: async () => '0xhash' } }
    })

    await assert.rejects(
      protocol.swidge({ fromToken: '0xfrom', toToken: '0xto', toChain: 137, fromTokenAmount: 1500000000000000000n, slippage: 0.02 }),
      (error: unknown) => error instanceof ButterConfigurationError && /differ/.test(error.message)
    )
  })

  it('echoes the requested input amount as the quote fromTokenAmount', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          // Butter echoes a slightly different totalAmountIn; the quote must
          // still report exactly what the caller requested.
          srcChain: { chainId: '56', tokenIn: { address: '0xfrom', decimals: 18, symbol: 'BNB' }, totalAmountIn: '1.499', totalAmountOut: '1.5' }
        })]
      })
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS
    })

    const quote = await protocol.quoteSwidge({
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 137,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    })
    assert.equal(quote.fromTokenAmount, 1500000000000000000n)
  })

  it('pins an approved quote by routeHash and skips re-quoting at execution', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          swapFee: { nativeFee: '0', tokenFee: '0' },
          srcChain: sourceChainWithToken(NATIVE_TOKEN),
          dstChain: {
            chainId: '137',
            tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
            totalAmountOut: '10.25'
          }
        })]
      }),
      '/swap': async () => ({
        errno: 0,
        message: 'success',
        data: [{
          to: ROUTER,
          value: '1500000000000000000',
          data: crossChainSwapData(NATIVE_TOKEN, 1500000000000000000n),
          chainId: '56',
          method: 'swapAndBridge'
        }]
      })
    })
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      now: () => 1000,
      evm: { sendTransaction: async () => '0xsourcehash' }
    })
    const options = {
      fromToken: NATIVE_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }

    const quote = await protocol.quoteSwidge(options)
    assert.equal(quote.routeHash, '0xroute')
    const result = await protocol.swidge({ ...options, routeHash: quote.routeHash } as never)

    assert.equal(result.id, '0xsourcehash')
    // Only the quote called /route; the pinned execution reused that route.
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 1)
  })

  it('rejects a stale or unknown pinned routeHash instead of silently re-quoting', async () => {
    const fetch = makeFetch({
      '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute()] })
    })
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      now: () => 1000,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS,
      evm: { sendTransaction: async () => '0xshould-not-send' }
    })

    // No prior quote cached this hash: execution must fail, not re-quote.
    await assert.rejects(
      protocol.swidge({
        fromToken: '0xfrom',
        toToken: '0xto',
        toChain: 137,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02,
        routeHash: '0xunknown'
      } as never),
      ButterActionRequiredError
    )
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 0)
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/swap').length, 0)
  })

  it('rejects a route that omits destination token decimals instead of defaulting to 18', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          dstChain: { chainId: '137', tokenOut: { address: '0xto', symbol: 'USDT' }, totalAmountOut: '10.25' }
        })]
      })
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS
    })

    await assert.rejects(
      protocol.quoteSwidge({ fromToken: '0xfrom', toToken: '0xto', toChain: 137, fromTokenAmount: 1500000000000000000n, slippage: 0.02 }),
      (error: unknown) => error instanceof ButterApiError && /decimals/.test(error.message)
    )
  })

  it('applies the TON strict slippage floor without a prior getSupportedChains call', async () => {
    const fetch = makeFetch({})
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      tokenDecimals: { '0xfrom': 18 }
    })

    await assert.rejects(protocol.quoteSwidge({
      fromToken: '0xfrom',
      toToken: 'ton-usdt',
      toChain: '1360104473493505',
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }), (error: unknown) => error instanceof ButterActionRequiredError && error.message.includes('300 bps'))
    assert.equal(fetch.calls.length, 0)
  })

  it('returns an inspectable quote even when a configured fee cap is exceeded', async () => {
    const fetch = makeFetch({
      // tokenFee 0.02 on 1.5 input is ~133 bps, above the 1 bps cap below.
      '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute({ bridgeFee: { amount: '0' } })] })
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS,
      maxProtocolFeeBps: 1
    })

    // A quote is a non-binding estimate: it must surface the fees, not throw.
    const quote = await protocol.quoteSwidge({
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 137,
      recipient: '0xrecipient',
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    })
    assert.equal(quote.fromTokenAmount, 1500000000000000000n)
    assert.ok(quote.fees.some((fee) => fee.type === 'protocol'))
  })

  it('rejects exact-out before requesting a route or sending a transaction', async () => {
    const fetch = makeFetch({})
    const sent: unknown[] = []
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      evm: {
        sendTransaction: async (tx) => {
          sent.push(tx)
          return '0xshould-not-send'
        }
      }
    })

    await assert.rejects(
      protocol.quoteSwidge({
        fromToken: ERC20_TOKEN,
        toToken: '0xto',
        toChain: 137,
        recipient: '0xrecipient',
        toTokenAmount: 10250000n,
        slippage: 0.02
      }),
      ButterExactOutUnsupportedError
    )
    assert.equal(fetch.calls.length, 0)
    assert.equal(sent.length, 0)
  })

  it('rejects zero and unsafe numeric exact-in amounts before requesting a route', async () => {
    const fetch = makeFetch({})
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS
    })
    const base = {
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 137,
      recipient: '0xrecipient',
      slippage: 0.02
    }

    await assert.rejects(protocol.quoteSwidge({ ...base, fromTokenAmount: 0n }), ButterUnsupportedError)
    await assert.rejects(
      protocol.quoteSwidge({ ...base, fromTokenAmount: Number.MAX_SAFE_INTEGER + 1 } as never),
      ButterUnsupportedError
    )
    assert.equal(fetch.calls.length, 0)
  })

  it('allows quote discovery for Tron without a transaction adapter', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          bridgeFee: undefined,
          gasFee: undefined,
          swapFee: undefined,
          srcChain: {
            chainId: '728126428',
            tokenIn: { address: 'trx', decimals: 6, symbol: 'TRX' },
            totalAmountIn: '0.000001',
            totalAmountOut: '0.000001'
          }
        })]
      })
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: '728126428',
      entrance: 'wdk',
      fetch
    })

    const quote = await protocol.quoteSwidge({
      fromToken: 'trx',
      toToken: '0xto',
      toChain: 137,
      recipient: '0xrecipient',
      fromTokenAmount: 1n,
      slippage: 0.02
    })

    assert.equal(quote.fromTokenAmount, 1n)
  })

  it('rejects read-only execution before requesting a route', async () => {
    const fetch = makeFetch({})
    const protocol = new ButterSwidgeProtocol({ getAddress: async () => VALID_SENDER }, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch
    })

    await assert.rejects(protocol.swidge({
      fromToken: NATIVE_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      fromTokenAmount: 1n,
      slippage: 0.02
    }), ButterReadOnlyAccountError)
    assert.equal(fetch.calls.length, 0)
  })

  it('allows refundAddress for quotes but rejects an unsupported execution refund recipient', async () => {
    const quoteFetch = makeFetch({
      '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute()] })
    })
    const quoteProtocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch: quoteFetch,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS
    })
    await quoteProtocol.quoteSwidge({
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 137,
      fromTokenAmount: 1500000000000000000n,
      refundAddress: VALID_RECIPIENT,
      slippage: 0.02
    })

    const executionFetch = makeFetch({})
    const executionProtocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch: executionFetch,
      evm: { sendTransaction: async () => '0xshould-not-send' }
    })
    await assert.rejects(executionProtocol.swidge({
      fromToken: NATIVE_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      fromTokenAmount: 1n,
      refundAddress: VALID_RECIPIENT,
      slippage: 0.02
    }), ButterUnsupportedError)
    assert.equal(executionFetch.calls.length, 0)
  })

  it('executes non-EVM swap data through the configured adapter without EVM router validation', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          contract: undefined,
          srcChain: {
            chainId: '1360095883558913',
            tokenIn: { address: 'btc', decimals: 8, symbol: 'BTC' },
            totalAmountIn: '1.5',
            totalAmountOut: '1.5'
          }
        })]
      }),
      '/swap': async () => ({
        errno: 0,
        message: 'success',
        data: [{ to: 'btc-address', value: '1000', memo: 'memo', chainId: '1360095883558913' }]
      })
    })
    const sent: unknown[] = []
    const protocol = new ButterSwidgeProtocol({
      async getAddress () { return 'btc-sender' },
      async sendTransaction (tx) {
        sent.push(tx)
        return { hash: 'btc-tx' }
      }
    }, {
      sourceChainId: '1360095883558913',
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000,
      transactionAdapters: {
        '1360095883558913': (swapTx) => ({
          to: swapTx.to,
          value: BigInt(swapTx.value),
          memo: swapTx.memo
        })
      }
    })

    const options = {
      fromToken: 'btc',
      toToken: '0xto',
      toChain: 137,
      recipient: '0xrecipient',
      fromTokenAmount: 150000000n,
      slippage: 0.04
    }
    await protocol.quoteSwidge(options)
    const result = await protocol.swidge(options)

    assert.deepEqual(sent, [{ to: 'btc-address', value: 1000n, memo: 'memo' }])
    assert.equal(result.id, 'btc-tx')
  })

  it('paginates token discovery with the chain key from queryChainList', async () => {
    const fetch = makeFetch({
      '/supportedChainInfo': async () => ({ errno: 0, message: 'success', data: [{ id: '56', type: 'EVM', name: 'BNB Chain' }] }),
      '/api/queryChainList': async () => ({
        code: 200,
        message: 'success',
        data: {
          chains: [{
            chainId: '56',
            chainType: 'EVM',
            name: 'BNB Chain',
            key: 'binance-smart-chain',
            nativeToken: '{"symbol":"BNB","address":"0x0000000000000000000000000000000000000000","decimals":18,"name":"BNB"}'
          }]
        }
      }),
      '/api/queryTokenList': async (url) => {
        assert.equal(url.searchParams.get('network'), 'binance-smart-chain')
        assert.equal(url.searchParams.get('pageSize'), '100')
        if (url.searchParams.get('pageNo') === '1') {
          return {
            code: 200,
            message: 'success',
            data: {
              count: 101,
              results: Array.from({ length: 100 }, (_, index) => ({
                chainId: '56',
                address: `0xtoken${index}`,
                decimals: 18,
                symbol: `T${index}`,
                name: `Token ${index}`
              }))
            }
          }
        }
        return {
          code: 200,
          message: 'success',
          data: {
            count: 101,
            results: [{ chainId: '56', address: '0xtoken100', decimals: 18, symbol: 'T100', name: 'Token 100' }]
          }
        }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch
    })

    const chains = await protocol.getSupportedChains()
    const tokens = await protocol.getSupportedTokens({ fromChain: 56 })

    assert.equal(chains[0]?.nativeToken, 'BNB')
    assert.equal((chains[0] as { execution?: string })?.execution, 'native')
    assert.equal(tokens.length, 101)
  })

  it('reports supported chains without a local executor as quote-only', async () => {
    const fetch = makeFetch({
      '/supportedChainInfo': async () => ({ errno: 0, message: 'success', data: [{ id: '999', type: 'TON', name: 'TON' }] }),
      '/api/queryChainList': async () => ({ code: 200, message: 'success', data: { chains: [] } }),
      '/route': async (url) => {
        assert.equal(url.searchParams.get('slippage'), '300')
        return {
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            bridgeFee: undefined,
            gasFee: undefined,
            swapFee: undefined,
            srcChain: sourceChainWithToken('0xfrom'),
            dstChain: {
              chainId: '999',
              tokenOut: { address: '0xto', decimals: 6, symbol: 'TON' },
              totalAmountOut: '10.25'
            }
          })]
        }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS
    })

    const chains = await protocol.getSupportedChains()
    await protocol.quoteSwidge({
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 999,
      fromTokenAmount: 1500000000000000000n
    })

    assert.equal((chains[0] as { execution?: string }).execution, 'quote-only')
  })

  it('continues token pagination without count while pages remain full', async () => {
    const fetch = makeFetch({
      '/supportedChainInfo': async () => ({ errno: 0, message: 'success', data: [{ id: '56', type: 'EVM', name: 'BNB' }] }),
      '/api/queryChainList': async () => ({ code: 200, message: 'success', data: { chains: [{ chainId: '56', key: 'bsc' }] } }),
      '/api/queryTokenList': async (url) => ({
        code: 200,
        message: 'success',
        data: {
          results: url.searchParams.get('pageNo') === '1'
            ? Array.from({ length: 100 }, (_, index) => ({ chainId: '56', address: `0x${index}`, decimals: 18, symbol: `T${index}` }))
            : [{ chainId: '56', address: '0x100', decimals: 18, symbol: 'T100' }]
        }
      })
    })
    const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })

    const tokens = await protocol.getSupportedTokens({ fromChain: 56 })

    assert.equal(tokens.length, 101)
  })

  it('stops token pagination when an advertised page makes no progress', async () => {
    let tokenRequests = 0
    const fetch = makeFetch({
      '/supportedChainInfo': async () => ({ errno: 0, message: 'success', data: [{ id: '56', type: 'EVM', name: 'BNB' }] }),
      '/api/queryChainList': async () => ({ code: 200, message: 'success', data: { chains: [{ chainId: '56', key: 'bsc' }] } }),
      '/api/queryTokenList': async () => {
        tokenRequests++
        return { code: 200, message: 'success', data: { count: 2, results: [] } }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })

    await assert.rejects(protocol.getSupportedTokens({ fromChain: 56 }), ButterApiError)
    assert.equal(tokenRequests, 1)
  })

  it('maps and validates source-hash status responses', async () => {
    const fetch = makeFetch({
      '/api/queryBridgeInfoBySourceHash': async (url) => {
        assert.equal(url.searchParams.get('hash'), '0xsourcehash')
        return {
          code: 200,
          message: 'success',
          data: {
            info: {
              state: 1,
              sourceHash: '0xsourcehash',
              toHash: '0xdesthash',
              fromChain: { chainId: '56' },
              toChain: { chainId: '137' }
            }
          }
        }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch
    })

    const status = await protocol.getSwidgeStatus('0xsourcehash', { fromChain: 56, toChain: 137 })

    assert.equal(status.status, 'completed')
    assert.deepEqual(status.transactions, [
      { hash: '0xsourcehash', chain: '56', type: 'source' },
      { hash: '0xdesthash', chain: '137', type: 'destination' }
    ])
  })

  it('maps order-id status responses without treating the order id as a source hash', async () => {
    const fetch = makeFetch({
      '/api/queryCrossInfoByOrderId': async (url) => {
        assert.equal(url.searchParams.get('orderId'), 'order-1')
        return {
          code: 200,
          message: 'success',
          data: {
            info: {
              state: 1,
              sourceHash: '0xsourcehash',
              toHash: '0xdesthash',
              fromChain: { chainId: '56' },
              toChain: { chainId: '137' }
            }
          }
        }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch
    })

    const status = await protocol.getSwidgeStatus('order-1', { byOrderId: true, fromChain: 56, toChain: 137 })

    assert.equal(status.status, 'completed')
    assert.deepEqual(status.transactions, [
      { hash: '0xsourcehash', chain: '56', type: 'source' },
      { hash: '0xdesthash', chain: '137', type: 'destination' }
    ])
  })

  it('maps documented Butter states and conservatively treats unknown states as pending', async () => {
    const cases: Array<[unknown, string]> = [
      [0, 'pending'],
      ['crossing', 'pending'],
      [1, 'completed'],
      [6, 'refunded'],
      // Undocumented/intermediate codes must not be reported as terminal: an
      // in-flight relaying state (2) or any unknown code stays pending.
      [2, 'pending'],
      [3, 'pending'],
      [99, 'pending'],
      ['weird-state', 'pending']
    ]
    for (const [state, expected] of cases) {
      const fetch = makeFetch({
        '/api/queryBridgeInfoBySourceHash': async () => ({
          code: 200,
          message: 'success',
          data: { info: { state, sourceHash: '0xsourcehash' } }
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch
      })

      assert.equal((await protocol.getSwidgeStatus('0xsourcehash')).status, expected)
    }
  })

  it('rejects a status response with no swidge info or state', async () => {
    for (const data of [{}, { info: {} }, { info: { sourceHash: '0xsourcehash' } }]) {
      const fetch = makeFetch({
        '/api/queryBridgeInfoBySourceHash': async () => ({ code: 200, message: 'success', data })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch
      })

      await assert.rejects(protocol.getSwidgeStatus('0xsourcehash'), ButterApiError)
    }
  })

  it('does not fabricate a source transaction from an order id when Butter omits the source hash', async () => {
    const fetch = makeFetch({
      '/api/queryCrossInfoByOrderId': async (url) => {
        assert.equal(url.searchParams.get('orderId'), 'order-123')
        return { code: 200, message: 'success', data: { info: { state: 0 } } }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })

    const result = await protocol.getSwidgeStatus('order-123', { byOrderId: true })
    assert.equal(result.status, 'pending')
    // The order id must not be surfaced as a (fake) source transaction hash.
    assert.deepEqual(result.transactions, [])
  })

  it('uses the queried source hash when Butter omits it on a bySourceHash lookup', async () => {
    const fetch = makeFetch({
      '/api/queryBridgeInfoBySourceHash': async () => ({ code: 200, message: 'success', data: { info: { state: 1 } } })
    })
    const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })

    const result = await protocol.getSwidgeStatus('0xsourcehash')
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.transactions, [{ hash: '0xsourcehash', chain: undefined, type: 'source' }])
  })

  it('parses an array-shaped status response and a scalar chain id', async () => {
    const fetch = makeFetch({
      '/api/queryBridgeInfoBySourceHash': async () => ({
        code: 200,
        message: 'success',
        // Array shape + fromChain/toChain as bare scalars rather than objects.
        data: [{ state: 1, sourceHash: '0xsourcehash', toHash: '0xdest', fromChain: 56, toChain: 137 }]
      })
    })
    const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })

    const result = await protocol.getSwidgeStatus('0xsourcehash')
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.transactions, [
      { hash: '0xsourcehash', chain: '56', type: 'source' },
      { hash: '0xdest', chain: '137', type: 'destination' }
    ])
  })

  it('maps all canonical WDK status strings and rejects an empty id', async () => {
    const states = ['pending', 'action-required', 'completed', 'failed', 'refund-pending', 'refunded', 'cancelled', 'expired', 'partial'] as const
    let index = 0
    const fetch = makeFetch({
      '/api/queryBridgeInfoBySourceHash': async () => ({
        code: 200,
        message: 'success',
        data: { info: { state: states[index++], sourceHash: `id-${index}` } }
      })
    })
    const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })

    for (const expected of states) {
      assert.equal((await protocol.getSwidgeStatus(`id-${index + 1}`)).status, expected)
    }
    await assert.rejects(protocol.getSwidgeStatus(''), ButterApiError)
    assert.equal(fetch.calls.length, states.length)
  })

  it('defaults authentication to optional and rejects partial credentials', async () => {
    const fetch = makeFetch({
      '/route': async (_url, init) => {
        assert.deepEqual(init.headers, {})
        return { errno: 0, message: 'success', data: [quoteRoute()] }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS
    })

    await protocol.quoteSwidge({
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 137,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    })
    assert.throws(() => new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'partial',
      fetch
    }), ButterConfigurationError)
  })

  it('rejects malformed successful Butter envelopes', async () => {
    const fetch = makeFetch({
      '/route': async () => ({ message: 'success', data: [quoteRoute()] })
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS
    })

    await assert.rejects(protocol.quoteSwidge({
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 137,
      recipient: '0xrecipient',
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }), ButterApiError)
  })
})

describe('helpers', () => {
  const routerAbi = parseAbi([
    'function swapAndCall(bytes32 transferId,address initiator,address srcToken,uint256 amount,bytes swapData,bytes callbackData,bytes permitData,bytes feeData)'
  ])
  const swapParam = parseAbiParameters(
    '(address dstToken,address receiver,address leftReceiver,uint256 minAmount,(uint8 dexType,address callTo,address approveTo,uint256 fromAmount,bytes callData)[] swaps)'
  )

  function sameChainSwapData (overrides: {
    initiator?: `0x${string}`
    srcToken?: `0x${string}`
    amount?: bigint
    dstToken?: `0x${string}`
    receiver?: `0x${string}`
    leftReceiver?: `0x${string}`
    minAmount?: bigint
    callbackData?: `0x${string}`
    permitData?: `0x${string}`
  } = {}) {
    const encodedSwapParam = encodeAbiParameters(swapParam, [{
      dstToken: overrides.dstToken ?? DEST_TOKEN,
      receiver: overrides.receiver ?? VALID_RECIPIENT,
      leftReceiver: overrides.leftReceiver ?? VALID_SENDER,
      minAmount: overrides.minAmount ?? 950n,
      swaps: []
    }])
    return encodeFunctionData({
      abi: routerAbi,
      functionName: 'swapAndCall',
      args: [
        zeroHash,
        overrides.initiator ?? VALID_SENDER,
        overrides.srcToken ?? ERC20_TOKEN,
        overrides.amount ?? 1000n,
        encodedSwapParam,
        overrides.callbackData ?? '0x',
        overrides.permitData ?? '0x',
        '0x'
      ]
    })
  }

  function validationContext () {
    return {
      sourceChainId: '56',
      destinationChainId: '56',
      route: quoteRoute({
        srcChain: {
          chainId: '56',
          tokenIn: { address: ERC20_TOKEN, decimals: 18 },
          tokenOut: { address: DEST_TOKEN, decimals: 6 }
        },
        dstChain: undefined
      }),
      routerRegistry: createRouterRegistry(),
      nativeSource: false,
      requestedAmountIn: 1000n,
      minimumAmountOut: 950n,
      sender: VALID_SENDER,
      receiver: VALID_RECIPIENT,
      sourceToken: ERC20_TOKEN,
      destinationToken: DEST_TOKEN,
      requireRouterAllowlist: true
    }
  }

  it('accepts Router V3 same-chain calldata only when it matches the quoted intent', () => {
    const tx = validateSwapTransaction({
      to: ROUTER,
      value: '0x0',
      chainId: '56',
      method: 'swapAndCall',
      data: sameChainSwapData()
    }, validationContext())

    assert.equal(tx.to, ROUTER)
  })

  it('rejects Router V3 calldata with a mismatched amount, token, recipient, or minimum output', () => {
    const mutations = [
      sameChainSwapData({ amount: 999n }),
      sameChainSwapData({ srcToken: DEST_TOKEN }),
      sameChainSwapData({ receiver: VALID_SENDER }),
      sameChainSwapData({ minAmount: 949n })
    ]

    for (const data of mutations) {
      assert.throws(
        () => validateSwapTransaction({ to: ROUTER, value: '0x0', chainId: '56', data }, validationContext()),
        ButterTransactionValidationError
      )
    }
  })

  it('rejects callback, permit, malformed selector, and misleading method metadata', () => {
    const transactions = [
      { data: sameChainSwapData({ callbackData: '0x01' }) },
      { data: sameChainSwapData({ permitData: '0x01' }) },
      { data: '0xabcdef' },
      { data: sameChainSwapData(), method: 'swapAndBridge' }
    ]

    for (const tx of transactions) {
      assert.throws(
        () => validateSwapTransaction({ to: ROUTER, value: '0x0', chainId: '56', ...tx }, validationContext()),
        ButterTransactionValidationError
      )
    }
  })

  it('rejects a cross-chain payload that changes the final recipient', () => {
    const context = {
      ...validationContext(),
      destinationChainId: '137',
      minimumAmountOut: 950n
    }
    const data = crossChainSwapData(ERC20_TOKEN, 1000n, { destinationReceiver: VALID_SENDER })

    assert.throws(
      () => validateSwapTransaction({ to: ROUTER, value: '0x0', chainId: '56', data }, context),
      ButterTransactionValidationError
    )
  })

  it('accepts cross-chain native fees for ERC20 and native inputs', () => {
    const erc20Context = {
      ...validationContext(),
      destinationChainId: '137',
      quotedNativeFee: 10n
    }
    const nativeContext = {
      ...erc20Context,
      nativeSource: true,
      sourceToken: NATIVE_TOKEN,
      requestedAmountIn: 1000n
    }

    assert.doesNotThrow(() => validateSwapTransaction({
      to: ROUTER,
      value: '10',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n })
    }, erc20Context))
    assert.doesNotThrow(() => validateSwapTransaction({
      to: ROUTER,
      value: '1010',
      chainId: '56',
      data: crossChainSwapData(NATIVE_TOKEN, 1000n, { nativeFee: 10n })
    }, nativeContext))
  })

  it('rejects cross-chain native fees that differ from the quoted fee or transaction value', () => {
    const context = {
      ...validationContext(),
      destinationChainId: '137',
      quotedNativeFee: 10n
    }

    assert.throws(() => validateSwapTransaction({
      to: ROUTER,
      value: '11',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 11n })
    }, context), ButterTransactionValidationError)
    assert.throws(() => validateSwapTransaction({
      to: ROUTER,
      value: '9',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n })
    }, context), ButterTransactionValidationError)
  })

  it('uses built-in versioned router deployments by default', () => {
    const deployments = routerDeploymentsForChain(createRouterRegistry(), '56')

    assert.ok(deployments.length > 0)
    assert.ok(deployments.every(({ version }) => version === 'v3'))
  })

  it('replaces built-in routers for a configured chain and allows disabling it', () => {
    const customAddress = '0x00000000000000000000000000000000000000bb'
    const configured = createRouterRegistry({
      56: [{ address: customAddress, version: 'v3' }]
    })
    const disabled = createRouterRegistry({ 56: [] })

    assert.deepEqual(routerDeploymentsForChain(configured, '56'), [{ address: customAddress, version: 'v3' }])
    assert.deepEqual(routerDeploymentsForChain(disabled, '56'), [])
  })

  it('rejects invalid router addresses and validator versions', () => {
    assert.throws(
      () => createRouterRegistry({ 56: [{ address: 'not-an-address', version: 'v3' }] }),
      ButterConfigurationError
    )
    assert.throws(
      () => createRouterRegistry({
        56: [{ address: '0x00000000000000000000000000000000000000bb', version: 'v4' as never }]
      }),
      ButterConfigurationError
    )
  })

  it('parses decimal token amounts into base units without floating point drift', () => {
    assert.equal(parseTokenAmount('10.25', 6), 10250000n)
    assert.equal(parseTokenAmount('1', 18), 1000000000000000000n)
    assert.equal(parseTokenAmount('0.000000000000000001', 18), 1n)
  })

  it('rejects token amounts that would lose numeric or decimal precision', () => {
    assert.throws(() => parseTokenAmount(Number.MAX_SAFE_INTEGER + 1, 6), ButterApiError)
    assert.throws(() => parseTokenAmount('1.0000001', 6), ButterApiError)
    assert.equal(parseTokenAmount('1.0000000', 6), 1000000n)
  })

  it('rejects invalid Butter slippage values', () => {
    assert.throws(() => toButterSlippage(0.51), ButterUnsupportedError)
    assert.throws(() => toButterSlippage(0.01, { crossChain: true }), ButterActionRequiredError)
    assert.equal(toButterSlippage(0.02, { crossChain: true }), 200)
    assert.equal(toButterSlippage(undefined, { crossChain: true, toChainId: 'ton' }), 300)
    assert.throws(() => toButterSlippage(0.02, { crossChain: true, toChainId: 'ton' }), ButterActionRequiredError)
  })
})
