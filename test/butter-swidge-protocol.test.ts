import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  isAddress,
  parseAbi,
  parseAbiParameters,
  stringToHex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  zeroHash
} from 'viem'

import ButterSwidgeProtocol, {
  ButterActionRequiredError,
  ButterApiError,
  ButterConfigurationError,
  ButterExactOutUnsupportedError,
  ButterFeeLimitExceededError,
  ButterPartialExecutionError,
  ButterReadOnlyAccountError,
  ButterTransactionValidationError,
  ButterUnsupportedError,
  parseTokenAmount,
  toButterSlippage,
  toEvmWalletClient,
  toEvmPublicClient
} from '../src/index.ts'
import { SOLANA_CHAIN_ID } from '../src/constants.ts'
import { routeNativeFee } from '../src/fees.ts'
import { RouteManager } from '../src/route.ts'
import type { ButterRoute } from '../src/types.ts'
import { createRouterRegistry, routerDeploymentsForChain } from '../src/router-registry.ts'
import { validateSwapTransaction, validateSwapTransactions } from '../src/swap-data.ts'

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

/** Builds an EvmWalletClient (bound account) from a send function, for the EVM sender. */
function evmWallet (
  sendTransaction: (tx: unknown) => Promise<string | { hash?: string, fee?: bigint }>,
  address: string = VALID_SENDER
) {
  return { account: { address }, sendTransaction }
}

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
  feeData?: `0x${string}`
  /** Refund destination encoded in the nested bridge payload. */
  refundAddress?: string
  /** Replaces the whole nested payload, e.g. '0x' or bytes that do not decode. */
  bridgePayload?: `0x${string}`
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
  const refundAddress = options.refundAddress ?? VALID_SENDER
  const bridgeAdapterData = options.bridgePayload ?? encodeAbiParameters(bridgeAdapterParamAbi, [{
    gasLimit: 500000n,
    // An EVM refund destination travels as the raw 20 bytes; anything else (base58,
    // bech32, TON) travels as UTF-8 text, exactly as the validator reads it.
    refundAddress: isAddress(refundAddress, { strict: false })
      ? refundAddress as `0x${string}`
      : stringToHex(refundAddress),
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
    args: [zeroHash, VALID_SENDER, sourceToken, amount, swapData, bridgeData, '0x', options.feeData ?? '0x']
  })
}

const feeParamAbi = parseAbiParameters('(uint8 feeType,address referrer,uint256 rateOrNativeFee)')
function encodeFeeData (feeType: number, referrer: `0x${string}`, rateOrNativeFee: bigint): `0x${string}` {
  return encodeAbiParameters(feeParamAbi, [{ feeType, referrer, rateOrNativeFee }])
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
        // Unconfigured affiliate/referrer are omitted entirely, so an existing
        // integrator's outgoing query and route cache key are unchanged.
        assert.equal(url.searchParams.get('affiliate'), null)
        assert.equal(url.searchParams.get('referrer'), null)
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

  it('sends the configured affiliate and referrer to /route', async () => {
    const fetch = makeFetch({
      '/route': async (url) => {
        // Surrounding whitespace is trimmed rather than forwarded verbatim.
        assert.equal(url.searchParams.get('affiliate'), 'butter-wdk:10')
        assert.equal(url.searchParams.get('referrer'), '0xreferrer')
        return { errno: 0, message: 'success', data: [quoteRoute()] }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      now: () => 1000,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS,
      affiliate: ' butter-wdk:10 ',
      referrer: ' 0xreferrer '
    })

    await protocol.quoteSwidge({
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 137,
      recipient: '0xrecipient',
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    })

    assert.equal(fetch.calls.length, 1)
  })

  it('does not reuse a cached route when the affiliate changes', async () => {
    // `affiliate` is construction-time config, so two affiliates always mean two
    // protocol instances with separate caches — the collision this guards against
    // is not reachable through `quoteSwidge`. What it locks is the invariant that
    // makes it unreachable: the affiliate travels in the route *request*, and
    // `stableRouteKey` derives the cache key from that request. Someone narrowing
    // that key to a hand-picked field list would silently serve a route quoted for
    // a different revenue share.
    const requests: Array<Record<string, unknown>> = []
    const context = {
      sourceChainId: '56',
      entrance: 'wdk',
      now: () => 1000,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS,
      nativeTokenDecimals: {},
      strictSlippageChainIds: new Set<string>(),
      affiliate: 'first',
      requestRoute: async (params: Record<string, unknown>) => {
        requests.push(params)
        return [quoteRoute()] as unknown as ButterRoute[]
      }
    }
    const routes = new RouteManager(context)
    const options = {
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 137,
      recipient: '0xrecipient',
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }

    await routes.getRoute(options)
    await routes.getRoute(options)
    assert.equal(requests.length, 1, 'an unchanged request reuses the cached route')

    context.affiliate = 'second'
    await routes.getRoute(options)

    assert.deepEqual(requests.map((request) => request.affiliate), ['first', 'second'])
  })

  it('rejects a Solana same-chain route without a referrer', async () => {
    // Butter documents `referrer` as mandatory here, so the request could never be
    // valid; `makeFetch` throws on any request, proving none was attempted.
    const fetch = makeFetch({})
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: SOLANA_CHAIN_ID,
      entrance: 'wdk',
      fetch,
      now: () => 1000
    })

    await assert.rejects(
      protocol.quoteSwidge({
        fromToken: 'sol',
        toToken: 'So11111111111111111111111111111111111111112',
        toChain: SOLANA_CHAIN_ID,
        recipient: 'GsbwXfJraMomNxBcjK9jSDLo6Uc3ByBcpUckuFqVjhWH',
        fromTokenAmount: 1000000000n,
        slippage: 0.02
      }),
      ButterConfigurationError
    )
    assert.equal(fetch.calls.length, 0)
  })

  it('rejects a malformed affiliate at construction', () => {
    const fetch = makeFetch({})
    const config = { sourceChainId: 56, entrance: 'wdk', fetch } as const

    // Butter substitutes its own default affiliate wallet whenever the parameter
    // is unusable, so a malformed value would otherwise hand the integrator's
    // share away on a successful swap, with no error to notice.
    for (const affiliate of [':10', 'butter:', 'butter:abc', 'butter:-1', 'butter wdk', 'a:1:2']) {
      assert.throws(
        () => new ButterSwidgeProtocol(undefined, { ...config, affiliate }),
        ButterConfigurationError,
        `expected ${JSON.stringify(affiliate)} to be rejected`
      )
    }

    // A blank value means "unset", not malformed, and the rate stays optional.
    for (const affiliate of ['', '   ', 'butter', 'butter:10', 'butter:0.5']) {
      assert.doesNotThrow(
        () => new ButterSwidgeProtocol(undefined, { ...config, affiliate }),
        `expected ${JSON.stringify(affiliate)} to be accepted`
      )
    }
  })

  it('does not surface priceImpact from per-leg data (unit/aggregation unconfirmed)', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          dstChain: {
            chainId: '137',
            tokenOut: { address: '0xto', decimals: 6, symbol: 'USDT' },
            totalAmountOut: '10.25',
            // Per-leg impacts on both ends: no authoritative aggregate, so we do
            // not surface an arbitrary leg's value.
            route: [{ priceImpact: '0.0123' }, { priceImpact: '0.02' }]
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

    assert.equal(quote.priceImpact, undefined)
  })

  it('does not resolve the sender address when quoting a non-Solana route', async () => {
    let getAddressCalls = 0
    const localAccount = {
      async getAddress () { getAddressCalls++; return VALID_SENDER },
      async sendTransaction () { return '0xhash' }
    }
    const fetch = makeFetch({ '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute()] }) })
    const protocol = new ButterSwidgeProtocol(localAccount, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      now: () => 1000,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS
    })

    await protocol.quoteSwidge({
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 137,
      recipient: '0xrecipient',
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    })

    assert.equal(getAddressCalls, 0)
  })

  it('rejects a cross-chain route that is missing dstChain', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          // Cross-chain request but a same-chain-shaped route (no dstChain).
          dstChain: undefined,
          srcChain: {
            chainId: '56',
            tokenIn: { address: '0xfrom', decimals: 18, symbol: 'BNB' },
            tokenOut: { address: '0xto', decimals: 6, symbol: 'USDT' },
            totalAmountIn: '1.5',
            totalAmountOut: '10.25'
          }
        })]
      })
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      now: () => 1000,
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
            // input 1.5e18 + routerFee 0.01e18 (swapFee.nativeFee) + bridgeFee 0.01e18
            value: '1520000000000000000',
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
      maxNativeFee: 100000000000000000n,
      evm: {
        walletClient: evmWallet(async (tx) => {
          sent.push(tx)
          return '0xsourcehash'
        })
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
      maxNativeFee: 0n,
      evm: { walletClient: evmWallet(async () => '0xsourcehash') }
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

  // input 1.5e18 + routerFee 0.01e18 (swapFee.nativeFee) + bridgeFee 0.01e18,
  // i.e. a native fee part of exactly 0.02e18 for the maxNativeFee cases below.
  const NATIVE_FEE_PART = 20000000000000000n

  function nativeFeeFetch () {
    return makeFetch({
      '/route': async () => ({
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
      }),
      '/swap': async () => ({
        errno: 0,
        message: 'success',
        data: [{
          to: ROUTER,
          value: String(1500000000000000000n + NATIVE_FEE_PART),
          data: crossChainSwapData(NATIVE_TOKEN, 1500000000000000000n, { nativeFee: 10000000000000000n }),
          chainId: '56',
          method: 'swapAndBridge'
        }]
      })
    })
  }

  function nativeFeeOptions (maxNativeFee?: bigint) {
    return {
      fromToken: NATIVE_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02,
      ...(maxNativeFee != null ? { maxNativeFee } : {})
    }
  }

  it('prefers a per-call maxNativeFee over the configured one', async () => {
    // Both directions: a per-call cap must be able to loosen a configured one and
    // to tighten it. A single construction-time value cannot fit every trade size,
    // so an override that only ever tightened would not solve the problem.
    for (const [configured, perCall, expected] of [
      [0n, NATIVE_FEE_PART, 'accepted'],
      [NATIVE_FEE_PART, NATIVE_FEE_PART - 1n, 'rejected']
    ] as const) {
      const fetch = nativeFeeFetch()
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        maxNativeFee: configured,
        evm: { walletClient: evmWallet(async () => '0xsourcehash') }
      })

      if (expected === 'accepted') {
        const result = await protocol.swidge(nativeFeeOptions(perCall))
        assert.equal(result.id, '0xsourcehash')
      } else {
        await assert.rejects(protocol.swidge(nativeFeeOptions(perCall)), ButterTransactionValidationError)
      }
    }
  })

  it('falls back to the configured maxNativeFee when the call omits it', async () => {
    const fetch = nativeFeeFetch()
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      // One wei below the fee the calldata spends, so a call that silently ignored
      // the configured cap would succeed here instead of failing.
      maxNativeFee: NATIVE_FEE_PART - 1n,
      evm: { walletClient: evmWallet(async () => '0xsourcehash') }
    })

    await assert.rejects(protocol.swidge(nativeFeeOptions()), ButterTransactionValidationError)
  })

  it('rejects a cross-VM swidge without an explicit recipient', async () => {
    // The WDK default (recipient = the account address) would send an EVM address
    // as the Solana destination receiver. `makeFetch` throws on any request, so
    // this also proves the rejection happens before /route.
    const fetch = makeFetch({})
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      maxNativeFee: 0n,
      evm: { walletClient: evmWallet(async () => '0xsourcehash') }
    })

    await assert.rejects(
      protocol.swidge({
        fromToken: NATIVE_TOKEN,
        toToken: 'So11111111111111111111111111111111111111112',
        toChain: SOLANA_CHAIN_ID,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }),
      ButterActionRequiredError
    )
    assert.equal(fetch.calls.length, 0)
  })

  it('defaults the recipient to the sender for a same-family cross-chain swidge', async () => {
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
      '/swap': async (url) => {
        // EVM -> EVM keeps the WDK default documented in the integration guide.
        assert.equal(url.searchParams.get('receiver'), VALID_SENDER)
        return {
          errno: 0,
          message: 'success',
          data: [{
            to: ROUTER,
            value: '1500000000000000000',
            data: crossChainSwapData(NATIVE_TOKEN, 1500000000000000000n, { destinationReceiver: VALID_SENDER }),
            chainId: '56',
            method: 'swapAndBridge'
          }]
        }
      }
    })
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      maxNativeFee: 0n,
      evm: { walletClient: evmWallet(async () => '0xsourcehash') }
    })

    const result = await protocol.swidge({
      fromToken: NATIVE_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    })

    assert.equal(result.id, '0xsourcehash')
  })

  it('quotes a cross-VM route without requiring a recipient', async () => {
    // A quote is non-binding and asking a price without a destination address is
    // the normal first step, so the cross-VM requirement is execution-only.
    const solanaToken = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const fetch = makeFetch({
      '/route': async (url) => {
        assert.equal(url.searchParams.get('receiver'), null)
        return {
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            swapFee: { nativeFee: '0', tokenFee: '0' },
            srcChain: sourceChainWithToken(NATIVE_TOKEN),
            dstChain: {
              chainId: SOLANA_CHAIN_ID,
              tokenOut: { address: solanaToken, decimals: 6, symbol: 'USDC' },
              totalAmountOut: '10.25'
            }
          })]
        }
      }
    })
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      now: () => 1000
    })

    const quote = await protocol.quoteSwidge({
      fromToken: NATIVE_TOKEN,
      toToken: solanaToken,
      toChain: SOLANA_CHAIN_ID,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    })

    assert.equal(quote.toTokenAmount, 10250000n)
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
        walletClient: evmWallet(async () => '0xsourcehash')
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

  function multiTxAdapterFetch (bitcoinChain: string) {
    return makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          bridgeFee: undefined,
          gasFee: undefined,
          swapFee: undefined,
          contract: undefined,
          srcChain: { chainId: bitcoinChain, tokenIn: { address: 'btc', decimals: 8, symbol: 'BTC' }, totalAmountIn: '1', totalAmountOut: '1' },
          dstChain: { chainId: '137', tokenOut: { address: 'btc', decimals: 8, symbol: 'BTC' }, totalAmountOut: '1' },
          minAmountOut: { amount: '0.99', symbol: 'BTC' }
        })]
      }),
      '/swap': async () => ({
        errno: 0,
        message: 'success',
        data: [
          { to: 'btc-prep', value: '0', chainId: bitcoinChain },
          { to: 'btc-deposit', value: '0', chainId: bitcoinChain }
        ]
      })
    })
  }

  it('rejects a multi-transaction adapter result that does not classify each transaction, broadcasting nothing', async () => {
    const bitcoinChain = '1360095883558913'
    let n = 0
    const protocol = new ButterSwidgeProtocol({
      getAddress: async () => 'btc-sender',
      sendTransaction: async () => `btc-hash-${++n}`
    }, {
      sourceChainId: bitcoinChain,
      entrance: 'wdk',
      fetch: multiTxAdapterFetch(bitcoinChain),
      transactionAdapters: { [bitcoinChain]: (tx) => tx } // bare, untyped
    })

    await assert.rejects(
      protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
      ButterUnsupportedError
    )
    // Classification runs before any send, so a rejected result leaves nothing
    // broadcast — a retry cannot double-execute an already-sent leg.
    assert.equal(n, 0)
  })

  it('rejects a multi-transaction adapter that declares more than one source, broadcasting nothing', async () => {
    const bitcoinChain = '1360095883558913'
    let n = 0
    const protocol = new ButterSwidgeProtocol({
      getAddress: async () => 'btc-sender',
      sendTransaction: async () => `btc-hash-${++n}`
    }, {
      sourceChainId: bitcoinChain,
      entrance: 'wdk',
      fetch: multiTxAdapterFetch(bitcoinChain),
      // Every leg claims to be the primary source: ambiguous, must be rejected.
      transactionAdapters: { [bitcoinChain]: (tx) => ({ transaction: tx, type: 'source' as const }) }
    })

    await assert.rejects(
      protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
      ButterUnsupportedError
    )
    assert.equal(n, 0)
  })

  it('rejects an adapter that declares an illegal transaction type, broadcasting nothing', async () => {
    const bitcoinChain = '1360095883558913'
    let n = 0
    const protocol = new ButterSwidgeProtocol({
      getAddress: async () => 'btc-sender',
      sendTransaction: async () => `btc-hash-${++n}`
    }, {
      sourceChainId: bitcoinChain,
      entrance: 'wdk',
      fetch: multiTxAdapterFetch(bitcoinChain),
      transactionAdapters: {
        [bitcoinChain]: (tx) => tx.to === 'btc-deposit'
          ? { transaction: tx, type: 'source' as const }
          : { transaction: tx, type: 'primary' as never } // not a SwidgeTransaction role
      }
    })

    await assert.rejects(
      protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
      ButterUnsupportedError
    )
    assert.equal(n, 0)
  })

  it('uses the adapter-declared primary (source) transaction as the swidge id', async () => {
    const bitcoinChain = '1360095883558913'
    let n = 0
    const protocol = new ButterSwidgeProtocol({
      getAddress: async () => 'btc-sender',
      sendTransaction: async () => `btc-hash-${++n}`
    }, {
      sourceChainId: bitcoinChain,
      entrance: 'wdk',
      fetch: multiTxAdapterFetch(bitcoinChain),
      transactionAdapters: {
        [bitcoinChain]: (tx) => tx.to === 'btc-deposit'
          ? { transaction: tx, type: 'source' as const }
          : { transaction: tx, type: 'other' as const }
      }
    })

    const result = await protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n })
    // The deposit (source) is the second send → 'btc-hash-2', and is the id.
    assert.equal(result.id, 'btc-hash-2')
    assert.deepEqual(result.transactions?.map((tx) => tx.type), ['other', 'source'])
  })

  it('reports the broadcast adapter transaction when it reports an unusable fee', async () => {
    const bitcoinChain = '1360095883558913'
    let n = 0
    const protocol = new ButterSwidgeProtocol({
      getAddress: async () => 'btc-sender',
      // A number fee passes `< 0n` and would poison the bigint total with a raw
      // TypeError raised outside the loop, discarding every broadcast hash.
      sendTransaction: async () => ({ hash: `btc-hash-${++n}`, fee: 1 as unknown as bigint })
    }, {
      sourceChainId: bitcoinChain,
      entrance: 'wdk',
      fetch: multiTxAdapterFetch(bitcoinChain),
      transactionAdapters: {
        [bitcoinChain]: (tx) => tx.to === 'btc-deposit'
          ? { transaction: tx, type: 'source' as const }
          : { transaction: tx, type: 'other' as const }
      }
    })

    await assert.rejects(
      protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
      (error: unknown) => {
        assert.ok(error instanceof ButterPartialExecutionError)
        assert.deepEqual(error.transactions, [{ hash: 'btc-hash-1', chain: bitcoinChain, type: 'other' }])
        assert.ok(error.cause instanceof ButterApiError)
        assert.match(error.cause.message, /non-bigint fee/)
        return true
      }
    )
    // The second leg must not go out after the first one failed validation.
    assert.equal(n, 1)
  })

  it('reports the first adapter leg when a later one returns an illegal hash', async () => {
    const bitcoinChain = '1360095883558913'
    let n = 0
    const protocol = new ButterSwidgeProtocol({
      getAddress: async () => 'btc-sender',
      // An adapter is host-supplied too, so the declared string hash is not a
      // runtime guarantee; the already-broadcast first leg must survive it.
      sendTransaction: async () => ++n === 1 ? 'btc-hash-1' : { hash: 123 as unknown as string }
    }, {
      sourceChainId: bitcoinChain,
      entrance: 'wdk',
      fetch: multiTxAdapterFetch(bitcoinChain),
      transactionAdapters: {
        [bitcoinChain]: (tx) => tx.to === 'btc-deposit'
          ? { transaction: tx, type: 'source' as const }
          : { transaction: tx, type: 'other' as const }
      }
    })

    await assert.rejects(
      protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
      (error: unknown) => {
        assert.ok(error instanceof ButterPartialExecutionError)
        assert.deepEqual(error.transactions, [{ hash: 'btc-hash-1', chain: bitcoinChain, type: 'other' }])
        assert.ok(error.cause instanceof ButterConfigurationError)
        assert.ok(!(error.cause instanceof TypeError))
        return true
      }
    )
    assert.equal(n, 2)
  })

  /** Three-leg adapter output (approval → source → follow-up) on one chain. */
  function threeTxAdapterFetch (bitcoinChain: string, toChainId: string) {
    const sameChain = toChainId === bitcoinChain
    const btc = { address: 'btc', decimals: 8, symbol: 'BTC' }
    return makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          bridgeFee: undefined,
          gasFee: undefined,
          swapFee: undefined,
          contract: undefined,
          srcChain: {
            chainId: bitcoinChain,
            tokenIn: btc,
            ...(sameChain ? { tokenOut: btc } : {}),
            totalAmountIn: '1',
            totalAmountOut: '1'
          },
          dstChain: sameChain ? undefined : { chainId: toChainId, tokenOut: btc, totalAmountOut: '1' },
          minAmountOut: { amount: '0.99', symbol: 'BTC' }
        })]
      }),
      '/swap': async () => ({
        errno: 0,
        message: 'success',
        data: [
          { to: 'btc-approval', value: '0', chainId: bitcoinChain },
          { to: 'btc-deposit', value: '0', chainId: bitcoinChain },
          { to: 'btc-followup', value: '0', chainId: bitcoinChain }
        ]
      })
    })
  }

  /** Classifies the three legs of {@link threeTxAdapterFetch} by destination. */
  function threeTxAdapter (tx: { to: string }) {
    if (tx.to === 'btc-approval') return { transaction: tx, type: 'approval' as const }
    if (tx.to === 'btc-deposit') return { transaction: tx, type: 'source' as const }
    return { transaction: tx, type: 'other' as const }
  }

  it('reports the already-broadcast transactions when an adapter send fails mid-sequence', async () => {
    const bitcoinChain = '1360095883558913'
    const attempted: string[] = []
    const rejected = new Error('wallet rejected the deposit')
    const protocol = new ButterSwidgeProtocol({
      getAddress: async () => 'btc-sender',
      async sendTransaction (tx) {
        const to = (tx as { to: string }).to
        attempted.push(to)
        if (to === 'btc-deposit') throw rejected
        return `hash-${to}`
      }
    }, {
      sourceChainId: bitcoinChain,
      entrance: 'wdk',
      fetch: threeTxAdapterFetch(bitcoinChain, '137'),
      transactionAdapters: { [bitcoinChain]: threeTxAdapter }
    })

    await assert.rejects(
      protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
      (error: unknown) => {
        assert.ok(error instanceof ButterPartialExecutionError)
        // The first leg is already on-chain; its hash must survive the failure so
        // the caller can inspect it instead of retrying into a double execution.
        assert.deepEqual(error.transactions, [{ hash: 'hash-btc-approval', chain: bitcoinChain, type: 'approval' }])
        assert.equal(error.cause, rejected)
        assert.equal(error.failedType, 'source')
        return true
      }
    )
    // Execution stops at the failure: the follow-up leg is never attempted.
    assert.deepEqual(attempted, ['btc-approval', 'btc-deposit'])
  })

  it('propagates the original error unwrapped when the first adapter send fails', async () => {
    const bitcoinChain = '1360095883558913'
    const rejected = new ButterConfigurationError('wallet is locked')
    const protocol = new ButterSwidgeProtocol({
      getAddress: async () => 'btc-sender',
      async sendTransaction () { throw rejected }
    }, {
      sourceChainId: bitcoinChain,
      entrance: 'wdk',
      fetch: threeTxAdapterFetch(bitcoinChain, '137'),
      transactionAdapters: { [bitcoinChain]: threeTxAdapter }
    })

    await assert.rejects(
      protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
      (error: unknown) => {
        // Nothing was broadcast, so this is an ordinary failure — wrapping it as
        // partial execution would tell the caller to inspect a chain state that
        // does not exist, and would break callers matching the underlying type.
        assert.equal(error, rejected)
        assert.ok(!(error instanceof ButterPartialExecutionError))
        return true
      }
    )
  })

  it('still resolves swidge status for a source transaction broadcast before a partial failure', async () => {
    const bitcoinChain = '1360095883558913'
    // makeFetch throws on any unregistered path, so falling back to the
    // cross-chain status API instead of the receipt would fail this test loudly.
    const fetch = threeTxAdapterFetch(bitcoinChain, bitcoinChain)
    const protocol = new ButterSwidgeProtocol({
      getAddress: async () => 'btc-sender',
      async sendTransaction (tx) {
        const to = (tx as { to: string }).to
        if (to === 'btc-followup') throw new Error('follow-up rejected')
        return `hash-${to}`
      },
      async getTransactionReceipt (hash) {
        assert.equal(hash, 'hash-btc-deposit')
        return { status: 'success' }
      }
    }, {
      sourceChainId: bitcoinChain,
      entrance: 'wdk',
      fetch,
      transactionAdapters: { [bitcoinChain]: threeTxAdapter }
    })

    await assert.rejects(
      protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: bitcoinChain, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
      ButterPartialExecutionError
    )

    // The swidge is in flight even though swidge() threw, so its kind must have
    // been recorded before the throw for later status routing.
    const callsBefore = fetch.calls.length
    const status = await protocol.getSwidgeStatus('hash-btc-deposit')
    assert.equal(status.status, 'completed')
    assert.equal(fetch.calls.length, callsBefore)
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
      maxNativeFee: 0n,
      evm: { walletClient: evmWallet(async () => '0xsourcehash') }
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

  it('re-fetches a route on the execution path when it expires within the execution margin', async () => {
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
        // The nearly-stale route must not be the one /swap is asked to build.
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
      fetch,
      now: () => now,
      maxNativeFee: 0n,
      evm: { walletClient: evmWallet(async () => '0xsourcehash') }
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
    // The route lives until 1300, so 20s remain: not expired, but nowhere near
    // enough to survive the /swap round-trip and the approval wait that follow.
    now = 1280

    const result = await protocol.swidge(options)

    assert.equal(result.id, '0xsourcehash')
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 2)
  })

  it('reuses a route on the quote path when it expires within the execution margin', async () => {
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
      }
    })
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      now: () => now,
      evm: { walletClient: evmWallet(async () => '0xsourcehash') }
    })
    const options = {
      fromToken: NATIVE_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }

    const first = await protocol.quoteSwidge(options)
    // 30s remain: inside the 45s execution margin but outside the 15s quote
    // margin. A quote is non-binding, so it does not need the larger margin.
    now = 1270
    const second = await protocol.quoteSwidge(options)

    assert.equal(second.routeHash, first.routeHash)
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 1)
  })

  it('rejects a pinned routeHash that expires within the execution margin', async () => {
    let now = 1000
    const fetch = makeFetch({
      // No /swap handler: makeFetch throws on unregistered paths, so any attempt
      // to execute the nearly-stale pin fails this test loudly.
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          timestamp: now,
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
      fetch,
      now: () => now,
      maxNativeFee: 0n,
      evm: { walletClient: evmWallet(async () => '0xshould-not-send') }
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
    now = 1280

    // A pin is the price the caller already approved, so it is never silently
    // re-fetched the way an unpinned execution is — the caller must re-quote.
    await assert.rejects(
      protocol.swidge({ ...options, routeHash: quote.routeHash }),
      ButterActionRequiredError
    )
    assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 1)
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
      evm: { walletClient: evmWallet(async () => '0xshould-not-send') }
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

  it('enforces the network fee cap against the caller amount, not a route-inflated input', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          // Route CLAIMS input 100 (=> gas 1/100 = 100 bps), but the user requests 1.
          gasFee: { amount: '1', symbol: 'BNB', inUSD: '1' },
          swapFee: { nativeFee: '0', tokenFee: '0' },
          bridgeFee: undefined,
          srcChain: { chainId: '56', tokenIn: { address: NATIVE_TOKEN, decimals: 18, symbol: 'BNB' }, totalAmountIn: '100', totalAmountOut: '100' },
          dstChain: undefined,
          totalAmountInUSD: '100'
        })]
      })
    })
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000,
      maxNetworkFeeBps: 100,
      evm: { walletClient: evmWallet(async () => '0xshould-not-send') }
    })

    // Real ratio is gas 1 / input 1 = 10000 bps, which must exceed the 100 bps cap.
    await assert.rejects(protocol.swidge({
      fromToken: NATIVE_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 56,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1000000000000000000n
    }), ButterFeeLimitExceededError)
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
        walletClient: evmWallet(async () => '0xshould-not-send')
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
      evm: { walletClient: evmWallet(async () => '0xsourcehash') }
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

  it('rejects a negative or non-integer maxNativeFee at construction time', () => {
    for (const maxNativeFee of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch: makeFetch({}), maxNativeFee }),
        ButterConfigurationError
      )
    }
    // A valid bigint cap constructs fine.
    assert.doesNotThrow(() => new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch: makeFetch({}), maxNativeFee: 100000000000000000n }))
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
          // ERC20 input (no native) + routerFee 0.01e18 + bridgeFee 0.01e18
          value: '20000000000000000',
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
      maxNativeFee: 100000000000000000n,
      evm: {
        publicClient: {
          async readContract () { return 0n },
          async waitForTransactionReceipt (args) {
            assert.equal(args.hash, '0xapproval')
            return { status: 'success' }
          }
        },
        walletClient: evmWallet(async (tx) => {
          sent.push(tx)
          return sent.length === 1 ? '0xapproval' : '0xsourcehash'
        })
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

  it('reduces an oversized ERC20 allowance to the exact input via approve(0) then approve(amount)', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          gasFee: undefined,
          bridgeFee: undefined,
          swapFee: { nativeFee: '0', tokenFee: '0' },
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
        data: [{ to: ROUTER, value: '0', data: sameChainSwapDataFor(ERC20_TOKEN, 1500000000000000000n), chainId: '56', method: 'swapAndCall' }]
      })
    })
    const sent: Array<{ data: `0x${string}` }> = []
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      now: () => 1000,
      tokenDecimals: ERC20_TOKEN_DECIMALS,
      evm: {
        publicClient: {
          // Existing allowance (2e18) exceeds the input (1.5e18).
          async readContract () { return 2000000000000000000n },
          async waitForTransactionReceipt () { return { status: 'success' } }
        },
        walletClient: evmWallet(async (tx) => { sent.push(tx as { data: `0x${string}` }); return '0x' + sent.length })
      }
    })

    const result = await protocol.swidge({
      fromToken: ERC20_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 56,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n
    })

    // Reset to 0, set to exact input, then swap.
    assert.equal(sent.length, 3)
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: sent[0].data }).args, [ROUTER, 0n])
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: sent[1].data }).args, [ROUTER, 1500000000000000000n])
    assert.deepEqual((result.transactions ?? []).map((tx) => tx.type), ['approval', 'approval', 'source'])
  })

  /** Same-chain ERC20 swap fixture whose allowance forces approve(0)+approve(amount). */
  function oversizedAllowanceFetch () {
    return makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          gasFee: undefined,
          bridgeFee: undefined,
          swapFee: { nativeFee: '0', tokenFee: '0' },
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
        data: [{ to: ROUTER, value: '0', data: sameChainSwapDataFor(ERC20_TOKEN, 1500000000000000000n), chainId: '56', method: 'swapAndCall' }]
      })
    })
  }

  /** Builds a protocol whose Nth EVM send (1-based) rejects with `rejected`. */
  function protocolFailingOnSend (account: unknown, failAt: number, rejected: Error) {
    let sends = 0
    return new ButterSwidgeProtocol(account as never, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch: oversizedAllowanceFetch(),
      now: () => 1000,
      tokenDecimals: ERC20_TOKEN_DECIMALS,
      evm: {
        publicClient: {
          // Existing allowance (2e18) exceeds the input (1.5e18).
          async readContract () { return 2000000000000000000n },
          async waitForTransactionReceipt () { return { status: 'success' } }
        },
        walletClient: evmWallet(async () => {
          sends++
          if (sends === failAt) throw rejected
          return `0xsend${sends}`
        })
      }
    })
  }

  const sameChainErc20Options = {
    fromToken: ERC20_TOKEN,
    toToken: DEST_TOKEN,
    toChain: 56,
    recipient: VALID_RECIPIENT,
    fromTokenAmount: 1500000000000000000n
  }

  it('reports both broadcast approvals when the EVM swap send fails after them', async () => {
    const rejected = new Error('swap send rejected')
    const protocol = protocolFailingOnSend(account, 3, rejected)

    await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
      assert.ok(error instanceof ButterPartialExecutionError)
      assert.deepEqual(error.transactions, [
        { hash: '0xsend1', chain: '56', type: 'approval' },
        { hash: '0xsend2', chain: '56', type: 'approval' }
      ])
      assert.equal(error.cause, rejected)
      assert.equal(error.failedType, 'source')
      return true
    })
  })

  it('reports the broadcast approve(0) when the follow-up approve(amount) fails', async () => {
    const rejected = new Error('second approval rejected')
    const protocol = protocolFailingOnSend(account, 2, rejected)

    await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
      assert.ok(error instanceof ButterPartialExecutionError)
      // The allowance is now 0 on-chain: the caller must see that leg, or a
      // retry would re-run approve(0) against state it does not know about.
      assert.deepEqual(error.transactions, [{ hash: '0xsend1', chain: '56', type: 'approval' }])
      assert.equal(error.cause, rejected)
      // The failure was in the approval stage, not the swap — preserved end to end.
      assert.equal(error.failedType, 'approval')
      return true
    })
  })

  it('propagates the original error unwrapped when the first EVM approval fails', async () => {
    const rejected = new ButterConfigurationError('wallet is locked')
    const protocol = protocolFailingOnSend(account, 1, rejected)

    await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
      // Nothing reached the chain, so this stays an ordinary failure.
      assert.equal(error, rejected)
      assert.ok(!(error instanceof ButterPartialExecutionError))
      return true
    })
  })

  it('refuses ERC20 execution when no receipt source can confirm the approval', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          gasFee: undefined,
          bridgeFee: undefined,
          swapFee: { nativeFee: '0', tokenFee: '0' },
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
        data: [{ to: ROUTER, value: '0', data: sameChainSwapDataFor(ERC20_TOKEN, 1500000000000000000n), chainId: '56', method: 'swapAndCall' }]
      })
    })
    const sent: unknown[] = []
    // account (beforeEach) has no getTransactionReceipt; publicClient has no
    // waitForTransactionReceipt → the approval could not be confirmed.
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      now: () => 1000,
      tokenDecimals: ERC20_TOKEN_DECIMALS,
      evm: {
        publicClient: { async readContract () { return 0n } },
        walletClient: evmWallet(async (tx) => { sent.push(tx); return '0x' + sent.length })
      }
    })

    await assert.rejects(
      protocol.swidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 56, recipient: VALID_RECIPIENT, fromTokenAmount: 1500000000000000000n }),
      ButterConfigurationError
    )
    // Nothing was submitted — no fire-and-forget approval.
    assert.equal(sent.length, 0)
  })

  it('rejects built-in EVM execution without an explicit EVM sender', async () => {
    // A bare WDK account cannot carry swap calldata: its Transaction type is only
    // { to, value }. EVM Router execution requires evm.walletClient/evm.sendTransaction.
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch: makeFetch({}),
      tokenDecimals: ERC20_TOKEN_DECIMALS
    })
    await assert.rejects(
      protocol.swidge({
        fromToken: ERC20_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 56,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n
      }),
      ButterReadOnlyAccountError
    )
  })

  it('rejects EVM execution without a full WDK account even when an EVM sender is present', async () => {
    // WDK contract: swidge() must throw without a full (send-capable) account,
    // regardless of a configured EVM sender.
    const evm = { walletClient: evmWallet(async () => '0xhash') }
    const options = { fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 56, recipient: VALID_RECIPIENT, fromTokenAmount: 1500000000000000000n }

    const noAccount = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56, entrance: 'wdk', fetch: makeFetch({}), tokenDecimals: ERC20_TOKEN_DECIMALS, evm
    })
    await assert.rejects(noAccount.swidge(options), ButterReadOnlyAccountError)

    const readOnlyAccount = new ButterSwidgeProtocol({ async getAddress () { return VALID_SENDER } }, {
      sourceChainId: 56, entrance: 'wdk', fetch: makeFetch({}), tokenDecimals: ERC20_TOKEN_DECIMALS, evm
    })
    await assert.rejects(readOnlyAccount.swidge(options), ButterReadOnlyAccountError)
  })

  it('executes with the example-style config: full WDK account + toEvmWalletClient', async () => {
    // Mirrors examples/swap.ts: a full WDK account (address + receipts) plus a
    // viem wallet client adapted via toEvmWalletClient. Guards against the example
    // regressing past the full-account execution precheck.
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          gasFee: undefined,
          bridgeFee: undefined,
          swapFee: { nativeFee: '0', tokenFee: '0' },
          srcChain: {
            chainId: '56',
            tokenIn: { address: NATIVE_TOKEN, decimals: 18, symbol: 'BNB' },
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
        data: [{ to: ROUTER, value: '1500000000000000000', data: sameChainSwapDataFor(NATIVE_TOKEN, 1500000000000000000n), chainId: '56', method: 'swapAndCall' }]
      })
    })
    const wdkAccount = {
      async getAddress () { return VALID_SENDER },
      async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') },
      async getTransactionReceipt () { return { status: 'success' } }
    }
    const protocol = new ButterSwidgeProtocol(wdkAccount, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      now: () => 1000,
      evm: {
        walletClient: toEvmWalletClient({ account: { address: VALID_SENDER }, sendTransaction: async () => '0xsourcehash' as `0x${string}` })
      }
    })

    const result = await protocol.swidge({
      fromToken: NATIVE_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 56,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n
    })
    assert.equal(result.id, '0xsourcehash')
  })

  it('executes ERC20 swidge with an explicit EVM sender, confirming approval via the account receipt', async () => {
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
          // ERC20 input (no native) + routerFee 0.01e18 + bridgeFee 0.01e18
          value: '20000000000000000',
          data: crossChainSwapData(ERC20_TOKEN, 1500000000000000000n, { nativeFee: 10000000000000000n }),
          chainId: '56',
          method: 'swapAndBridge'
        }]
      })
    })
    const sent: unknown[] = []
    const receiptQueries: string[] = []
    // A full account (WDK-required) supplies the address and confirms the approval
    // receipt; the explicit EVM sender carries the calldata. account.sendTransaction
    // must never be used for EVM calldata.
    const accountOnly = {
      async getAddress () { return VALID_SENDER },
      async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') },
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
      tokenDecimals: ERC20_TOKEN_DECIMALS,
      maxNativeFee: 100000000000000000n,
      evm: {
        walletClient: evmWallet(async (tx) => {
          sent.push(tx)
          return sent.length === 1 ? '0xapproval' : '0xsourcehash'
        })
      }
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

  it('reports the measured source gas fee when the EVM sender returns per-tx fees', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          gasFee: { amount: '0.0001', symbol: 'BNB' },
          swapFee: { nativeFee: '0', tokenFee: '0' },
          bridgeFee: undefined,
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
        data: [{ to: ROUTER, value: '0', data: sameChainSwapDataFor(ERC20_TOKEN, 1500000000000000000n), chainId: '56', method: 'swapAndCall' }]
      })
    })
    let sends = 0
    const localAccount = {
      async getAddress () { return VALID_SENDER },
      async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') },
      async getTransactionReceipt () { return { status: 'success' } }
    }
    const protocol = new ButterSwidgeProtocol(localAccount, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      tokenDecimals: ERC20_TOKEN_DECIMALS,
      evm: {
        walletClient: evmWallet(async () => {
          sends++
          return sends === 1 ? { hash: '0xapproval', fee: 21000n } : { hash: '0xsourcehash', fee: 50000n }
        })
      }
    })

    const result = await protocol.swidge({
      fromToken: ERC20_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 56,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n
    })

    // The estimated gas fee (0.0001e18) is replaced by the measured total
    // (approval 21000 + source 50000).
    const network = result.fees.find((fee) => fee.type === 'network')
    assert.equal(network?.amount, 71000n)
  })

  function sameChainErc20Fetch () {
    return makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          gasFee: { amount: '0.0001', symbol: 'BNB' },
          swapFee: { nativeFee: '0', tokenFee: '0' },
          bridgeFee: undefined,
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
        data: [{ to: ROUTER, value: '0', data: sameChainSwapDataFor(ERC20_TOKEN, 1500000000000000000n), chainId: '56', method: 'swapAndCall' }]
      })
    })
  }

  it('keeps the route gas estimate when only some sends report a fee', async () => {
    let sends = 0
    const localAccount = {
      async getAddress () { return VALID_SENDER },
      async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') },
      async getTransactionReceipt () { return { status: 'success' } }
    }
    const protocol = new ButterSwidgeProtocol(localAccount, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch: sameChainErc20Fetch(),
      tokenDecimals: ERC20_TOKEN_DECIMALS,
      evm: {
        walletClient: evmWallet(async () => {
          sends++
          // Approval reports a fee; the source send returns only a hash.
          return sends === 1 ? { hash: '0xapproval', fee: 21000n } : '0xsourcehash'
        })
      }
    })

    const result = await protocol.swidge({
      fromToken: ERC20_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 56,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n
    })

    // Not every send was measured, so the network fee stays the route estimate
    // (0.0001e18), never a partial 21000.
    const network = result.fees.find((fee) => fee.type === 'network')
    assert.equal(network?.amount, 100000000000000n)
  })

  /** Same-chain ERC20 protocol driven by `send`; approvals self-confirm. */
  function erc20FeeProtocol (send: (tx: unknown) => Promise<string | { hash?: string, fee?: bigint }>) {
    return new ButterSwidgeProtocol({
      async getAddress () { return VALID_SENDER },
      async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') },
      async getTransactionReceipt () { return { status: 'success' } }
    }, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch: sameChainErc20Fetch(),
      tokenDecimals: ERC20_TOKEN_DECIMALS,
      evm: { walletClient: evmWallet(send) }
    })
  }

  it('reports the broadcast approval when the sender returns a negative gas fee', async () => {
    const protocol = erc20FeeProtocol(async () => ({ hash: '0xapproval', fee: -1n }))

    await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
      // The fee is unusable but the approval is already on-chain: the hash is
      // what the caller needs, so it must not be lost to the fee check.
      assert.ok(error instanceof ButterPartialExecutionError)
      assert.deepEqual(error.transactions, [{ hash: '0xapproval', chain: '56', type: 'approval' }])
      assert.equal(error.failedType, 'approval')
      assert.ok(error.cause instanceof ButterApiError)
      assert.match(error.cause.message, /negative fee/)
      return true
    })
  })

  it('reports the broadcast approval when the sender returns a non-bigint gas fee', async () => {
    // A host wallet client is plain JS at runtime, so `fee` can be a number; it
    // slips past a bare `< 0n` test and would otherwise surface as a TypeError
    // from the bigint sum, with no transactions attached.
    const protocol = erc20FeeProtocol(async () => ({ hash: '0xapproval', fee: 1 as unknown as bigint }))

    await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
      assert.ok(error instanceof ButterPartialExecutionError)
      assert.deepEqual(error.transactions, [{ hash: '0xapproval', chain: '56', type: 'approval' }])
      assert.ok(error.cause instanceof ButterApiError)
      assert.match(error.cause.message, /non-bigint fee/)
      assert.ok(!(error.cause instanceof TypeError))
      return true
    })
  })

  it('reports both legs when the source send reports an unusable fee', async () => {
    let sends = 0
    const protocol = erc20FeeProtocol(async () => {
      sends++
      return sends === 1 ? { hash: '0xapproval', fee: 21000n } : { hash: '0xsource', fee: -1n }
    })

    await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
      assert.ok(error instanceof ButterPartialExecutionError)
      assert.deepEqual(error.transactions, [
        { hash: '0xapproval', chain: '56', type: 'approval' },
        { hash: '0xsource', chain: '56', type: 'source' }
      ])
      assert.equal(error.failedType, 'source')
      return true
    })
  })

  it('propagates unwrapped when the sender returns no hash at all', async () => {
    // Broadcast, but unidentifiable — there is no hash to report, so this stays
    // an ordinary configuration failure rather than a partial execution.
    const protocol = erc20FeeProtocol(async () => ({ fee: 21000n }))

    await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
      assert.ok(error instanceof ButterConfigurationError)
      assert.ok(!(error instanceof ButterPartialExecutionError))
      assert.match(error.message, /did not return a hash/)
      return true
    })
  })

  it('rejects an empty transaction hash instead of executing with an empty id', async () => {
    // An empty string is truthy-adjacent enough to slip through a bare `!hash`
    // test, and `''.toLowerCase()` never throws — so this used to resolve
    // successfully with an unusable `id: ''`.
    const protocol = erc20FeeProtocol(async () => '')

    await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
      assert.ok(error instanceof ButterConfigurationError)
      assert.ok(!(error instanceof ButterPartialExecutionError))
      assert.match(error.message, /empty transaction hash/)
      return true
    })
  })

  it('rejects a non-string transaction hash rather than failing later on toLowerCase', async () => {
    // A host wallet client is plain JS at runtime, so `hash` can be a number. It
    // used to be recorded as-is and then blow up in rememberOperationKind — and
    // because the partial-execution reporter calls that too, the report itself
    // threw and the caller got a bare TypeError.
    const protocol = erc20FeeProtocol(async () => ({ hash: 123 as unknown as string, fee: 1n }))

    await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
      assert.ok(error instanceof ButterConfigurationError)
      assert.ok(!(error instanceof TypeError))
      assert.match(error.message, /did not return a hash/)
      return true
    })
  })

  it('reports the broadcast approval when the source send returns an illegal hash', async () => {
    let sends = 0
    const protocol = erc20FeeProtocol(async () => {
      sends++
      return sends === 1 ? { hash: '0xapproval', fee: 21000n } : { hash: 123 as unknown as string }
    })

    await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
      // The approval is on-chain and identifiable; only the source hash is
      // unusable, so the caller still gets what was broadcast.
      assert.ok(error instanceof ButterPartialExecutionError)
      assert.deepEqual(error.transactions, [{ hash: '0xapproval', chain: '56', type: 'approval' }])
      assert.equal(error.failedType, 'source')
      assert.ok(error.cause instanceof ButterConfigurationError)
      assert.match(error.cause.message, /did not return a hash/)
      return true
    })
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
      async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') },
      async getTransactionReceipt () { return null }
    }, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000,
      maxNativeFee: 0n,
      tokenDecimals: ERC20_TOKEN_DECIMALS,
      evm: { walletClient: evmWallet(async () => '0xapproval'), approvalTimeoutMs: 20 }
    })

    await assert.rejects(protocol.swidge({
      fromToken: ERC20_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }), (error: unknown) => {
      // The approval is already broadcast and may still land, so the timeout is
      // reported as a partial execution carrying its hash — not a bare timeout.
      assert.ok(error instanceof ButterPartialExecutionError)
      assert.deepEqual(error.transactions, [{ hash: '0xapproval', chain: '56', type: 'approval' }])
      assert.equal(error.failedType, 'approval')
      assert.ok(error.cause instanceof ButterConfigurationError)
      assert.ok(error.cause.message.includes('Timed out'))
      return true
    })
  })

  it('does not send the swap when the approval receipt has an unknown status (fail-closed)', async () => {
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
        data: [{ to: ROUTER, value: '0', data: crossChainSwapData(ERC20_TOKEN, 1500000000000000000n), chainId: '56', method: 'swapAndBridge' }]
      })
    })
    const sent: unknown[] = []
    const protocol = new ButterSwidgeProtocol({
      async getAddress () { return VALID_SENDER },
      async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') },
      // Present but uninterpretable status must NOT be treated as confirmed.
      async getTransactionReceipt () { return {} }
    }, {
      sourceChainId: 56,
      entrance: 'wdk',
      apiKeyId: 'key',
      apiSecret: 'secret',
      fetch,
      now: () => 1000,
      maxNativeFee: 0n,
      tokenDecimals: ERC20_TOKEN_DECIMALS,
      evm: {
        walletClient: evmWallet(async (tx) => { sent.push(tx); return '0xapproval' }),
        approvalTimeoutMs: 20
      }
    })

    await assert.rejects(protocol.swidge({
      fromToken: ERC20_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 137,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n,
      slippage: 0.02
    }), (error: unknown) => {
      assert.ok(error instanceof ButterPartialExecutionError)
      assert.deepEqual(error.transactions, [{ hash: '0xapproval', chain: '56', type: 'approval' }])
      assert.equal(error.failedType, 'approval')
      assert.ok(error.cause instanceof ButterConfigurationError)
      assert.ok(error.cause.message.includes('Timed out'))
      return true
    })
    // Only the approval was submitted; the swap must not follow an unconfirmed approval.
    assert.equal(sent.length, 1)
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

  it('filters /findToken results to the requested chain and ignores other chains', async () => {
    const fetch = makeFetch({
      // /findToken matches by address only: it returns the token on several
      // chains. The wrong-chain entry (6 decimals) must never be used for chain 56.
      '/findToken': async () => ({
        errno: 0,
        message: 'success',
        data: [
          { chainId: 42161, address: ERC20_TOKEN, decimals: 6, symbol: 'X' },
          { chainId: 56, address: ERC20_TOKEN, decimals: 18, symbol: 'X' }
        ]
      }),
      '/route': async (url) => {
        assert.equal(url.searchParams.get('amount'), '1.5') // 18-decimal scaling, not 6
        return {
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            srcChain: sourceChainWithToken(ERC20_TOKEN),
            dstChain: { chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' }, totalAmountOut: '10.25' }
          })]
        }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })

    const quote = await protocol.quoteSwidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1500000000000000000n, slippage: 0.02 })
    assert.equal(quote.fromTokenAmount, 1500000000000000000n)
  })

  it('treats a /findToken result with no matching chain as an unknown token', async () => {
    const fetch = makeFetch({
      '/findToken': async () => ({ errno: 0, message: 'success', data: [{ chainId: 42161, address: ERC20_TOKEN, decimals: 6 }] })
    })
    const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })

    await assert.rejects(
      protocol.quoteSwidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }),
      ButterActionRequiredError
    )
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

  it('defaults the Solana route receiver to the sender when recipient is omitted', async () => {
    const solanaChain = '1360108768460801'
    const solSender = 'SoLsender11111111111111111111111111111111'
    const fetch = makeFetch({
      '/route': async (url) => {
        // WDK default: omitted recipient falls back to the account address.
        assert.equal(url.searchParams.get('receiver'), solSender)
        return {
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            srcChain: { chainId: solanaChain, tokenIn: { address: 'sol', decimals: 9 }, totalAmountIn: '1', totalAmountOut: '1' },
            dstChain: { chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' }, totalAmountOut: '10.25' }
          })]
        }
      }
    })
    const protocol = new ButterSwidgeProtocol({ getAddress: async () => solSender }, {
      sourceChainId: solanaChain,
      entrance: 'wdk',
      fetch
    })

    const quote = await protocol.quoteSwidge({ fromToken: 'sol', toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1000000000n, slippage: 0.02 })
    assert.equal(quote.fromTokenAmount, 1000000000n)
  })

  it('still requires an explicit recipient for a Solana quote with no account', async () => {
    const fetch = makeFetch({})
    const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: '1360108768460801', entrance: 'wdk', fetch })

    await assert.rejects(
      protocol.quoteSwidge({ fromToken: 'sol', toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1000000000n, slippage: 0.02 }),
      ButterActionRequiredError
    )
    assert.equal(fetch.calls.length, 0)
  })

  it('aborts the swap when the ERC20 approval reverts', async () => {
    const fetch = makeFetch({
      '/route': async () => ({
        errno: 0,
        message: 'success',
        data: [quoteRoute({
          swapFee: { nativeFee: '0', tokenFee: '0' },
          srcChain: sourceChainWithToken(ERC20_TOKEN),
          dstChain: { chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' }, totalAmountOut: '10.25' }
        })]
      }),
      '/swap': async () => ({
        errno: 0,
        message: 'success',
        data: [{ to: ROUTER, value: '0', data: crossChainSwapData(ERC20_TOKEN, 1500000000000000000n), chainId: '56', method: 'swapAndBridge' }]
      })
    })
    const sent: unknown[] = []
    const protocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      now: () => 1000,
      maxNativeFee: 0n,
      tokenDecimals: ERC20_TOKEN_DECIMALS,
      evm: {
        publicClient: {
          async readContract () { return 0n },
          async waitForTransactionReceipt () { return { status: 'reverted' } }
        },
        walletClient: evmWallet(async (tx) => { sent.push(tx); return '0xapproval' })
      }
    })

    await assert.rejects(
      protocol.swidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, recipient: VALID_RECIPIENT, fromTokenAmount: 1500000000000000000n, slippage: 0.02 }),
      (error: unknown) => {
        // The reverted approval is a real on-chain transaction; report its hash
        // rather than discarding it with the stack frame.
        assert.ok(error instanceof ButterPartialExecutionError)
        assert.deepEqual(error.transactions, [{ hash: '0xapproval', chain: '56', type: 'approval' }])
        assert.equal(error.failedType, 'approval')
        assert.ok(error.cause instanceof ButterConfigurationError)
        assert.ok(/approval.*revert/i.test(error.cause.message))
        return true
      }
    )
    // Only the approval was sent; the swap must not follow a reverted approval.
    assert.equal(sent.length, 1)
  })

  it('rejects EVM execution with no full account before any network call', async () => {
    const fetch = makeFetch({})
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      evm: { walletClient: evmWallet(async () => '0xshould-not-send') }
    })

    await assert.rejects(
      protocol.swidge({ fromToken: NATIVE_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }),
      ButterReadOnlyAccountError
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
      maxNativeFee: 0n,
      evm: { walletClient: evmWallet(async () => '0xsourcehash') }
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
    const result = await protocol.swidge({ ...options, routeHash: quote.routeHash })

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
      evm: { walletClient: evmWallet(async () => '0xshould-not-send') }
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
      }),
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
        walletClient: evmWallet(async (tx) => {
          sent.push(tx)
          return '0xshould-not-send'
        })
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

  it('does not reject a refundAddress that differs from the sender before requesting a route', async () => {
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

    // Execution used to short-circuit here, because refundAddress had to equal the
    // sender. That promise was never checked against the calldata, so it is now
    // verified downstream instead: the request goes out and the refund destination
    // is compared with what Butter actually encodes.
    const executionFetch = makeFetch({
      '/route': async () => ({ errno: 2003, message: 'No Route Found' })
    })
    const executionProtocol = new ButterSwidgeProtocol(account, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch: executionFetch,
      tokenDecimals: DEFAULT_TOKEN_DECIMALS,
      evm: { walletClient: evmWallet(async () => '0xshould-not-send') }
    })
    await assert.rejects(executionProtocol.swidge({
      fromToken: '0xfrom',
      toToken: '0xto',
      toChain: 137,
      fromTokenAmount: 1500000000000000000n,
      refundAddress: VALID_RECIPIENT,
      slippage: 0.02
    }), ButterApiError)
    assert.equal(executionFetch.calls.length, 1)
    assert.equal(executionFetch.calls[0].url.pathname, '/route')
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
      '/supportedChainInfo': async () => ({
        errno: 0,
        message: 'success',
        data: [{ id: '999', type: 'TON', name: 'TON', nativeToken: '{"symbol":"TON","decimals":9}' }]
      }),
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

  it('drops a chain missing its type from getSupportedChains', async () => {
    const fetch = makeFetch({
      '/supportedChainInfo': async () => ({
        errno: 0,
        message: 'success',
        data: [
          { id: '56', type: 'EVM', name: 'BNB Chain', nativeToken: '{"symbol":"BNB","decimals":18}' },
          { id: '137', name: 'Polygon', nativeToken: '{"symbol":"POL","decimals":18}' }
        ]
      }),
      '/api/queryChainList': async () => ({ code: 200, message: 'success', data: { chains: [] } })
    })
    const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })

    const chains = await protocol.getSupportedChains()

    // WDK marks `type` as required, so the chain is dropped rather than listed
    // with a placeholder that reads like a real chain type.
    assert.deepEqual(chains.map((chain) => chain.id), ['56'])
  })

  it('drops a chain missing its native token symbol from getSupportedChains', async () => {
    const fetch = makeFetch({
      '/supportedChainInfo': async () => ({
        errno: 0,
        message: 'success',
        data: [
          { id: '56', type: 'EVM', name: 'BNB Chain', nativeToken: '{"symbol":"BNB","decimals":18}' },
          { id: '137', type: 'EVM', name: 'Polygon' },
          { id: '8453', type: 'EVM', name: 'Base', nativeToken: '{"decimals":18}' }
        ]
      }),
      '/api/queryChainList': async () => ({ code: 200, message: 'success', data: { chains: [] } })
    })
    const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })

    const chains = await protocol.getSupportedChains()

    // Both an absent blob and one that parses without a symbol are dropped.
    assert.deepEqual(chains.map((chain) => chain.id), ['56'])
  })

  it('still applies the strict slippage floor for a dropped BTC-like chain', async () => {
    const fetch = makeFetch({
      // Bitcoin-like by name — so the 300 bps floor applies — but missing
      // `nativeToken`, so the chain itself is dropped from the listing. Its id
      // is not one of the built-in strict chain constants, so the floor can
      // only come from discovery having classified it before the filter.
      '/supportedChainInfo': async () => ({
        errno: 0,
        message: 'success',
        data: [{ id: '998', type: 'EVM', name: 'Bitcoin Sidechain' }]
      }),
      '/api/queryChainList': async () => ({ code: 200, message: 'success', data: { chains: [] } }),
      '/route': async (url) => {
        // 300, not the 150 bps cross-chain floor that would apply otherwise.
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
              chainId: '998',
              tokenOut: { address: '0xto', decimals: 6, symbol: 'BTCS' },
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
      toChain: 998,
      fromTokenAmount: 1500000000000000000n
    })

    assert.deepEqual(chains, [])
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

  it('derives same-chain swidge status from the transaction receipt', async () => {
    const cases: Array<[unknown, string]> = [
      [{ status: 'success' }, 'completed'],
      [{ status: 'reverted' }, 'failed'],
      [null, 'pending']
    ]
    for (const [receipt, expected] of cases) {
      const fetch = makeFetch({})
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        evm: {
          publicClient: {
            async readContract () { return 0n },
            async getTransaction () { return { input: sameChainSwapDataFor(ERC20_TOKEN, 1n), to: ROUTER } },
            async getTransactionReceipt () { return receipt as never }
          }
        }
      })

      const result = await protocol.getSwidgeStatus('0xsourcehash', { fromChain: 56, toChain: 56 })
      assert.equal(result.status, expected)
      // No cross-chain API is queried for a same-chain status.
      assert.equal(fetch.calls.length, 0)
    }
  })

  it('fails closed on a same-chain receipt with an unknown or missing status', async () => {
    // A mined receipt whose status we cannot interpret must NOT be reported as
    // completed (fail-open); it maps conservatively to pending.
    const cases: Array<[unknown, string]> = [
      [{ status: '0x2' }, 'pending'],
      [{ status: 2 }, 'pending'],
      [{}, 'pending'],
      [{ status: '0x1' }, 'completed'],
      [{ status: 1 }, 'completed'],
      [{ status: true }, 'completed'],
      [{ status: '0x0' }, 'failed'],
      [{ status: false }, 'failed']
    ]
    for (const [receipt, expected] of cases) {
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch: makeFetch({}),
        evm: {
          publicClient: {
            async readContract () { return 0n },
            async getTransaction () { return { input: sameChainSwapDataFor(ERC20_TOKEN, 1n), to: ROUTER } },
            async getTransactionReceipt () { return receipt as never }
          }
        }
      })
      const result = await protocol.getSwidgeStatus('0xsourcehash', { fromChain: 56, toChain: 56 })
      assert.equal(result.status, expected, `receipt ${JSON.stringify(receipt)} -> ${expected}`)
    }
  })

  it('routes same-chain status to the receipt without explicit chain hints after executing', async () => {
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
        publicClient: {
          readContract: async () => 1500000000000000000n,
          getTransactionReceipt: async () => ({ status: 'success' })
        },
        walletClient: evmWallet(async () => '0xsourcehash')
      }
    })

    const result = await protocol.swidge({
      fromToken: ERC20_TOKEN,
      toToken: DEST_TOKEN,
      toChain: 56,
      recipient: VALID_RECIPIENT,
      fromTokenAmount: 1500000000000000000n
    })

    const callsBefore = fetch.calls.length
    // No fromChain/toChain hints: the provider must remember this was same-chain
    // and derive status from the receipt, not query the cross-chain API.
    const status = await protocol.getSwidgeStatus(result.id)
    assert.equal(status.status, 'completed')
    assert.equal(fetch.calls.length, callsBefore)
  })

  it('routes same-chain status statelessly by decoding a swapAndCall source tx (no hints, fresh instance)', async () => {
    const fetch = makeFetch({}) // the cross-chain API must not be called
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      evm: {
        publicClient: {
          readContract: async () => 0n,
          getTransaction: async () => ({ input: sameChainSwapDataFor(ERC20_TOKEN, 1000n), to: ROUTER }),
          getTransactionReceipt: async () => ({ status: 'success' })
        }
      }
    })

    const status = await protocol.getSwidgeStatus('0xsourcehash')
    assert.equal(status.status, 'completed')
    assert.equal(fetch.calls.length, 0)
  })

  it('routes cross-chain status to the cross API when the source tx is swapAndBridge (no hints)', async () => {
    let appCalled = false
    const fetch = makeFetch({
      '/api/queryBridgeInfoBySourceHash': async () => {
        appCalled = true
        return { code: 200, message: 'ok', data: { state: 1, fromChain: { chainId: '56' }, toChain: { chainId: '137' }, sourceHash: '0xsourcehash', toHash: '0xdest' } }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      evm: {
        publicClient: {
          readContract: async () => 0n,
          getTransaction: async () => ({ input: crossChainSwapData(ERC20_TOKEN, 1000n), to: ROUTER })
        }
      }
    })

    const status = await protocol.getSwidgeStatus('0xsourcehash')
    assert.equal(appCalled, true)
    assert.equal(status.status, 'completed')
  })

  it('does not report an unrelated (non-Router) transaction as a completed swidge', async () => {
    const NON_ROUTER = '0x00000000000000000000000000000000000000ff'
    const fetch = makeFetch({}) // cross API has no record; must not resolve to completed
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      evm: {
        publicClient: {
          readContract: async () => 0n,
          // swapAndCall-shaped calldata but to a NON-allowlisted address.
          getTransaction: async () => ({ input: sameChainSwapDataFor(ERC20_TOKEN, 1000n), to: NON_ROUTER }),
          getTransactionReceipt: async () => ({ status: 'success' })
        }
      }
    })

    // No hints: must not be attributed as a same-chain Butter swidge.
    await assert.rejects(protocol.getSwidgeStatus('0xsourcehash'))
    // Explicit same-chain hints must not bypass the Router attribution check.
    await assert.rejects(
      protocol.getSwidgeStatus('0xsourcehash', { fromChain: 56, toChain: 56 }),
      ButterApiError
    )
  })

  it('requires a receipt source for same-chain status', async () => {
    const fetch = makeFetch({})
    // Attribution succeeds (Router swapAndCall) but there is no receipt source.
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      evm: { publicClient: { readContract: async () => 0n, getTransaction: async () => ({ input: sameChainSwapDataFor(ERC20_TOKEN, 1n), to: ROUTER }) } }
    })

    await assert.rejects(
      protocol.getSwidgeStatus('0xsourcehash', { fromChain: 56, toChain: 56 }),
      ButterConfigurationError
    )
  })

  it('propagates an infrastructure error from Router attribution instead of silently falling back to the cross API', async () => {
    // Had attribution swallowed the RPC error, the id would fall through to the
    // cross API and resolve as completed. The node fault must surface instead.
    const fetch = makeFetch({
      '/api/queryBridgeInfoBySourceHash': async () => ({
        code: 200, message: 'success', data: { info: { state: 'completed', sourceHash: '0xsourcehash' } }
      })
    })
    const protocol = new ButterSwidgeProtocol(undefined, {
      sourceChainId: 56,
      entrance: 'wdk',
      fetch,
      evm: {
        publicClient: {
          readContract: async () => 0n,
          getTransaction: async () => { throw new Error('RPC unavailable') }
        }
      }
    })

    await assert.rejects(protocol.getSwidgeStatus('0xsourcehash'), /RPC unavailable/)
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

  it('rejects more than one transaction on the built-in EVM Router path', () => {
    const tx = { to: ROUTER, value: '0x0', chainId: '56', method: 'swapAndCall', data: sameChainSwapData() }
    // Two individually-valid Router txs would double-spend if both executed.
    assert.throws(
      () => validateSwapTransactions([tx, tx], validationContext()),
      ButterTransactionValidationError
    )
    // A single tx is still accepted.
    assert.doesNotThrow(() => validateSwapTransactions([tx], validationContext()))
    // The adapter path (no router allowlist) may legitimately return multiple txs.
    const adapterTx = { to: 'deposit-address', value: '0', chainId: '56' }
    assert.doesNotThrow(() => validateSwapTransactions(
      [adapterTx, adapterTx],
      { ...validationContext(), requireRouterAllowlist: false }
    ))
  })

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

  it('trusts Butter for cross-chain destination routing but still enforces router, toChain, and value', () => {
    const context = {
      ...validationContext(),
      destinationChainId: '137',
      minimumAmountOut: 950n,
      // Cross-chain fails closed without a cap; this test is about the other checks.
      maxNativeFee: 100n
    }
    // A different destination receiver is NOT rejected: cross-chain destination
    // routing is trusted to Butter's /swap (policy: middle-tier validation).
    assert.doesNotThrow(() => validateSwapTransaction({
      to: ROUTER,
      value: '0',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { destinationReceiver: VALID_SENDER })
    }, context))

    // The non-allowlisted router target is still rejected.
    assert.throws(() => validateSwapTransaction({
      to: '0x00000000000000000000000000000000000000ff',
      value: '0',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n)
    }, context), ButterTransactionValidationError)

    // A bridge to the wrong destination chain is still rejected.
    assert.throws(() => validateSwapTransaction({
      to: ROUTER,
      value: '0',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n)
    }, { ...context, destinationChainId: '42161' }), ButterTransactionValidationError)

    // A tx.value that would drain native beyond the fees is still rejected.
    assert.throws(() => validateSwapTransaction({
      to: ROUTER,
      value: '1000000',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n })
    }, context), ButterTransactionValidationError)
  })

  it('applies maxNativeFee to the router fee on a same-chain swap when configured', () => {
    // Same-chain has no bridge fee, but the router native fee is still capped when
    // maxNativeFee is set (it is optional same-chain, unlike cross-chain).
    const context = { ...validationContext(), routerNativeFee: 7n }
    const tx = { to: ROUTER, value: '7', chainId: '56', method: 'swapAndCall', data: sameChainSwapData() }
    assert.doesNotThrow(() => validateSwapTransaction(tx, { ...context, maxNativeFee: 7n }))
    assert.throws(() => validateSwapTransaction(tx, { ...context, maxNativeFee: 5n }), ButterTransactionValidationError)
    // Without a cap, a same-chain swap is not rejected (no unbounded bridge fee).
    assert.doesNotThrow(() => validateSwapTransaction(tx, context))
  })

  it('caps router + bridge native fees at maxNativeFee and fails closed without one', () => {
    const base = { ...validationContext(), destinationChainId: '137', routerNativeFee: 7n }
    const tx = {
      to: ROUTER,
      value: '17',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n })
    }
    // nonInputNative = routerFee(7) + bridgeFee(10) = 17.
    assert.doesNotThrow(() => validateSwapTransaction(tx, { ...base, maxNativeFee: 17n }))
    assert.throws(() => validateSwapTransaction(tx, { ...base, maxNativeFee: 16n }), ButterTransactionValidationError)
    // Fail-closed: a cross-chain bridge native fee with no cap configured is rejected.
    assert.throws(() => validateSwapTransaction(tx, base), ButterConfigurationError)
  })

  it('accepts a tx value equal to input plus the distinct router and bridge native fees', () => {
    // routerNativeFee (route.swapFee.nativeFee) and the bridge param nativeFee
    // are DIFFERENT fees; both are added to msg.value.
    const erc20Context = {
      ...validationContext(),
      destinationChainId: '137',
      routerNativeFee: 7n,
      maxNativeFee: 100n
    }
    const nativeContext = {
      ...erc20Context,
      nativeSource: true,
      sourceToken: NATIVE_TOKEN,
      requestedAmountIn: 1000n
    }

    // ERC20: value = 0 + routerFee(7) + bridgeFee(10) = 17
    assert.doesNotThrow(() => validateSwapTransaction({
      to: ROUTER,
      value: '17',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n })
    }, erc20Context))
    // native: value = input(1000) + routerFee(7) + bridgeFee(10) = 1017
    assert.doesNotThrow(() => validateSwapTransaction({
      to: ROUTER,
      value: '1017',
      chainId: '56',
      data: crossChainSwapData(NATIVE_TOKEN, 1000n, { nativeFee: 10n })
    }, nativeContext))
  })

  it('rejects a tx value above the quoted router and bridge native fees but allows one below', () => {
    const context = {
      ...validationContext(),
      destinationChainId: '137',
      routerNativeFee: 7n,
      // High enough that the quote-consistency bound, not the cap, is what rejects.
      maxNativeFee: 1000n
    }

    // value 18 > routerFee(7) + bridgeFee(10), beyond the tolerated drift.
    assert.throws(() => validateSwapTransaction({
      to: ROUTER,
      value: '18',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n })
    }, context), ButterTransactionValidationError)
    // The fee half is bounded above only: charging less than quoted cannot harm the
    // user (the router reverts if it is genuinely underfunded), so value 10 —
    // the bridge fee without the 7 router fee — is accepted.
    assert.doesNotThrow(() => validateSwapTransaction({
      to: ROUTER,
      value: '10',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n })
    }, context))
  })

  it('accepts a /swap native value that rounds 1 wei above the quoted fee', () => {
    // /route formats the router fee as a decimal string and /swap returns tx.value as
    // a hex integer, so the round-trip can land a wei above the quote.
    const context = {
      ...validationContext(),
      destinationChainId: '137',
      routerNativeFee: 190n,
      maxNativeFee: 1000n
    }
    const swap = (value: string) => ({
      to: ROUTER,
      value,
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n })
    })

    // quoted = 190 + 10 = 200; 50 bps of that is exactly 1 wei of drift.
    assert.doesNotThrow(() => validateSwapTransaction(swap('201'), context))
    assert.throws(() => validateSwapTransaction(swap('202'), context), ButterTransactionValidationError)
  })

  it('rejects a /swap native value below the quoted native input', () => {
    const context = {
      ...validationContext(),
      destinationChainId: '137',
      nativeSource: true,
      sourceToken: NATIVE_TOKEN,
      requestedAmountIn: 1000n,
      routerNativeFee: 7n,
      maxNativeFee: 100n
    }

    // The input half is a hard lower bound — anything less under-funds the swap.
    assert.throws(() => validateSwapTransaction({
      to: ROUTER,
      value: '999',
      chainId: '56',
      data: crossChainSwapData(NATIVE_TOKEN, 1000n, { nativeFee: 10n })
    }, context), ButterTransactionValidationError)
  })

  it('rejects cross-chain execution without maxNativeFee even when the calldata reports a zero bridge fee', () => {
    // A route that reports no bridge fee must not be able to opt out of the cap that
    // actually bounds what tx.value spends.
    const context = { ...validationContext(), destinationChainId: '137' }

    assert.throws(() => validateSwapTransaction({
      to: ROUTER,
      value: '0',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 0n })
    }, context), ButterConfigurationError)
    // With a cap configured the same transaction is fine.
    assert.doesNotThrow(() => validateSwapTransaction({
      to: ROUTER,
      value: '0',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 0n })
    }, { ...context, maxNativeFee: 0n }))
  })

  it('accepts a cross-chain swap whose bridge payload encodes the requested refund address', () => {
    const context = {
      ...validationContext(),
      destinationChainId: '137',
      maxNativeFee: 100n,
      refundAddress: VALID_SENDER
    }

    assert.doesNotThrow(() => validateSwapTransaction({
      to: ROUTER,
      value: '10',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n, refundAddress: VALID_SENDER })
    }, context))
  })

  it('rejects a cross-chain swap whose bridge payload encodes a different refund address', () => {
    const context = {
      ...validationContext(),
      destinationChainId: '137',
      maxNativeFee: 100n,
      refundAddress: VALID_RECIPIENT
    }

    assert.throws(() => validateSwapTransaction({
      to: ROUTER,
      value: '10',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n, refundAddress: VALID_SENDER })
    }, context), ButterTransactionValidationError)
  })

  it('allows a refund address that differs from the sender', () => {
    // The previous rule demanded refundAddress === sender while never checking the
    // calldata, so it bought nothing and ruled out legitimate destinations (a cold
    // wallet, a multisig, or an address on a chain the sender cannot spend on).
    const coldWallet = '0x00000000000000000000000000000000000000dd'
    const context = {
      ...validationContext(),
      destinationChainId: '137',
      maxNativeFee: 100n,
      refundAddress: coldWallet
    }

    assert.doesNotThrow(() => validateSwapTransaction({
      to: ROUTER,
      value: '10',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n, refundAddress: coldWallet })
    }, context))
  })

  it('matches a non-EVM refund address by its UTF-8 encoding', () => {
    // `refundAddress` is raw `bytes`, so the destination chain decides the encoding.
    // What is under test is the encoding, not the destination: a base58 address is
    // carried as UTF-8 text rather than as 20 raw bytes.
    const solanaAddress = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH'
    const context = {
      ...validationContext(),
      destinationChainId: '137',
      maxNativeFee: 100n,
      refundAddress: solanaAddress
    }

    assert.doesNotThrow(() => validateSwapTransaction({
      to: ROUTER,
      value: '10',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n, refundAddress: solanaAddress })
    }, context))
    assert.throws(() => validateSwapTransaction({
      to: ROUTER,
      value: '10',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n, refundAddress: 'So11111111111111111111111111111111111111112' })
    }, context), ButterTransactionValidationError)
  })

  it('rejects an explicit refundAddress when the bridge payload cannot be decoded', () => {
    // The caller asked for a guarantee. If it cannot be checked it must not be
    // reported as holding — dropping refundAddress is the way back to Butter's default.
    const context = {
      ...validationContext(),
      destinationChainId: '137',
      maxNativeFee: 100n,
      refundAddress: VALID_SENDER
    }

    // Nothing nested at all.
    assert.throws(() => validateSwapTransaction({
      to: ROUTER,
      value: '10',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n, bridgePayload: '0x' })
    }, context), ButterUnsupportedError)
    // Present, but not the documented (gasLimit, refundAddress, swapData) layout.
    assert.throws(() => validateSwapTransaction({
      to: ROUTER,
      value: '10',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n, bridgePayload: '0xdeadbeef' })
    }, context), ButterUnsupportedError)
  })

  it('does not decode the bridge payload when no refundAddress was requested', () => {
    // The default path trusts Butter's own refund destination like the rest of the
    // cross-chain destination routing, so the nested payload stays unread.
    const context = { ...validationContext(), destinationChainId: '137', maxNativeFee: 100n }

    assert.doesNotThrow(() => validateSwapTransaction({
      to: ROUTER,
      value: '10',
      chainId: '56',
      data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n, bridgePayload: '0xdeadbeef' })
    }, context))
  })

  it('checks a same-chain refundAddress against the leftover receiver', () => {
    // Same-chain has no bridge payload; swapAndCall's leftover receiver is where a
    // refund lands, so it carries the same role.
    const coldWallet = '0x00000000000000000000000000000000000000dd'
    const context = { ...validationContext(), refundAddress: coldWallet }

    assert.doesNotThrow(() => validateSwapTransaction({
      to: ROUTER,
      value: '0',
      chainId: '56',
      data: sameChainSwapData({ leftReceiver: coldWallet })
    }, context))
    // Once a refund destination is named, the sender is no longer the expected one.
    assert.throws(() => validateSwapTransaction({
      to: ROUTER,
      value: '0',
      chainId: '56',
      data: sameChainSwapData()
    }, context), ButterTransactionValidationError)
  })

  it('values a native swap fee with more decimals than the chain native token', () => {
    const feeContext = { sourceChainId: '56', sourceToken: ERC20_TOKEN }
    const routeWithNativeFee = (nativeFee: string) => quoteRoute({
      swapFee: { nativeFee, tokenFee: '0' }
    }) as never

    // 19 decimals on an 18-decimal native token. This value is the quoted side of an
    // upper bound on tx.value, so it rounds up instead of rejecting the whole quote.
    assert.equal(routeNativeFee(routeWithNativeFee('0.0000000000000000001'), feeContext), 1n)
    assert.equal(routeNativeFee(routeWithNativeFee('1.0000000000000000001'), feeContext), 10n ** 18n + 1n)
    // A representable amount is unaffected.
    assert.equal(routeNativeFee(routeWithNativeFee('0.000000000000000001'), feeContext), 1n)
  })

  it('accepts calldata feeData that matches the quoted feeConfig and rejects any deviation', () => {
    const referrer = '0x51C700e5bE790C91F14D42F85ca90aed9f2D142e'
    const context = {
      ...validationContext(),
      destinationChainId: '137',
      route: quoteRoute({
        srcChain: { chainId: '56', tokenIn: { address: ERC20_TOKEN, decimals: 18 }, tokenOut: { address: DEST_TOKEN, decimals: 6 } },
        dstChain: undefined,
        feeConfig: { feeType: 1, referrer, rateOrNativeFee: 0 }
      }),
      feeConfig: { feeType: 1, referrer, rateOrNativeFee: 0 },
      maxNativeFee: 100n
    }
    const swap = (feeData: `0x${string}`) => ({ to: ROUTER, value: '10', chainId: '56', data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n, feeData }) })

    // Matches the declared feeConfig.
    assert.doesNotThrow(() => validateSwapTransaction(swap(encodeFeeData(1, referrer, 0n)), context))
    // Empty feeData is allowed here because the quoted feeConfig charges nothing
    // (rateOrNativeFee is 0).
    assert.doesNotThrow(() => validateSwapTransaction(swap('0x'), context))
    // Different referrer.
    assert.throws(() => validateSwapTransaction(swap(encodeFeeData(1, '0x00000000000000000000000000000000000000ff', 0n)), context), ButterTransactionValidationError)
    // Inflated rate.
    assert.throws(() => validateSwapTransaction(swap(encodeFeeData(1, referrer, 50n)), context), ButterTransactionValidationError)
    // Different feeType.
    assert.throws(() => validateSwapTransaction(swap(encodeFeeData(0, referrer, 0n)), context), ButterTransactionValidationError)
  })

  it('rejects empty feeData when the route quoted a non-zero integrator fee', () => {
    const referrer = '0x51C700e5bE790C91F14D42F85ca90aed9f2D142e'
    const context = {
      ...validationContext(),
      destinationChainId: '137',
      maxNativeFee: 100n,
      route: quoteRoute({
        srcChain: { chainId: '56', tokenIn: { address: ERC20_TOKEN, decimals: 18 }, tokenOut: { address: DEST_TOKEN, decimals: 6 } },
        dstChain: undefined,
        feeConfig: { feeType: 1, referrer, rateOrNativeFee: 50 }
      }),
      feeConfig: { feeType: 1, referrer, rateOrNativeFee: 50 }
    }
    // Empty feeData would silently drop the quoted 50-bps integrator fee.
    assert.throws(
      () => validateSwapTransaction({ to: ROUTER, value: '10', chainId: '56', data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n }) }, context),
      ButterTransactionValidationError
    )
    // The matching non-empty feeData is still accepted.
    assert.doesNotThrow(
      () => validateSwapTransaction({ to: ROUTER, value: '10', chainId: '56', data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n, feeData: encodeFeeData(1, referrer, 50n) }) }, context)
    )
  })

  it('rejects calldata feeData when the route declared no feeConfig', () => {
    const context = { ...validationContext(), destinationChainId: '137' }
    assert.throws(
      () => validateSwapTransaction({
        to: ROUTER,
        value: '10',
        chainId: '56',
        data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n, feeData: encodeFeeData(1, '0x51C700e5bE790C91F14D42F85ca90aed9f2D142e', 0n) })
      }, context),
      ButterTransactionValidationError
    )
  })

  it('fails closed on non-empty feeData when the quoted feeConfig tuple is incomplete', () => {
    const referrer = '0x51C700e5bE790C91F14D42F85ca90aed9f2D142e'
    const base = {
      ...validationContext(),
      destinationChainId: '137',
      maxNativeFee: 100n,
      route: quoteRoute({
        srcChain: { chainId: '56', tokenIn: { address: ERC20_TOKEN, decimals: 18 }, tokenOut: { address: DEST_TOKEN, decimals: 6 } },
        dstChain: undefined
      })
    }
    const swap = { to: ROUTER, value: '10', chainId: '56', data: crossChainSwapData(ERC20_TOKEN, 1000n, { nativeFee: 10n, feeData: encodeFeeData(1, referrer, 50n) }) }

    // A non-empty feeData charges a fee, so the quoted tuple must be complete
    // before it can be matched. A missing field is unverifiable → reject, rather
    // than partially trusting the rest while /swap picks the unchecked field.
    assert.throws(
      () => validateSwapTransaction(swap, { ...base, feeConfig: { referrer, rateOrNativeFee: 50 } }),
      ButterTransactionValidationError
    )
    assert.throws(
      () => validateSwapTransaction(swap, { ...base, feeConfig: { feeType: 1, rateOrNativeFee: 50 } }),
      ButterTransactionValidationError
    )
    assert.throws(
      () => validateSwapTransaction(swap, { ...base, feeConfig: { feeType: 1, referrer } }),
      ButterTransactionValidationError
    )
    // The complete, matching tuple is still accepted.
    assert.doesNotThrow(
      () => validateSwapTransaction(swap, { ...base, feeConfig: { feeType: 1, referrer, rateOrNativeFee: 50 } })
    )
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

  it('converts slippage decimals to exact basis points without floating point drift', () => {
    // Every integer-bps decimal must map back to that exact bp, not one higher.
    assert.equal(toButterSlippage(0.0051), 51)
    assert.equal(toButterSlippage(0.0099), 99)
    assert.equal(toButterSlippage(0.0079), 79)
    assert.equal(toButterSlippage(0.035), 350)
    assert.equal(toButterSlippage(0.5), 5000)
    // Genuine sub-bps precision still rounds up so slippage is never below request.
    assert.equal(toButterSlippage(0.00505), 51)
    // Tiny non-zero slippage in scientific notation rounds up to 1 bp, never 0/-0.
    assert.equal(toButterSlippage(1e-10), 1)
    assert.equal(toButterSlippage(Number.MIN_VALUE), 1)
    assert.equal(toButterSlippage(0), 0)
    // Full sweep: i/10000 must yield exactly i bps for every valid bp.
    for (let i = 1; i <= 5000; i++) {
      assert.equal(toButterSlippage(i / 10000), i, `slippage ${i / 10000} should be ${i} bps`)
    }
  })

  it('adapts a viem public client: a genuinely-missing lookup maps to null', async () => {
    const client = toEvmPublicClient({
      async readContract () { return 42n },
      async waitForTransactionReceipt () { return { status: 'success' } },
      async getTransactionReceipt () { throw new TransactionReceiptNotFoundError({ hash: '0xhash' }) },
      async getTransaction () { throw new TransactionNotFoundError({ hash: '0xhash' }) }
    })
    assert.equal(await client.readContract({}), 42n)
    // Only viem's typed not-found errors are treated as "does not exist yet".
    assert.equal(await client.getTransactionReceipt?.('0xhash'), null)
    assert.equal(await client.getTransaction?.('0xhash'), null)
  })

  it('adapts a viem public client: an infrastructure error propagates, not masked as not-found', async () => {
    const client = toEvmPublicClient({
      async readContract () { return 0n },
      async waitForTransactionReceipt () { return { status: 'success' } },
      // RPC timeout / auth / rate-limit — NOT a not-found; must surface to the caller.
      async getTransactionReceipt () { throw new Error('HTTP 429 rate limited') },
      async getTransaction () { throw new Error('request timed out') }
    })
    await assert.rejects(async () => { await client.getTransactionReceipt?.('0xhash') }, /rate limited/)
    await assert.rejects(async () => { await client.getTransaction?.('0xhash') }, /timed out/)
  })

  it('adapts a viem public client: a not-found from a different viem copy still maps to null', async () => {
    // Stands in for a host that built its client with its OWN copy of viem: the
    // error has the right class name and BaseError shape but a different class
    // identity, so `instanceof` alone would misread it as an RPC fault.
    class ForeignViemNotFound extends Error {
      readonly shortMessage = 'Transaction could not be found.'
      constructor (name: string) {
        super(`${name}: Transaction could not be found.`)
        this.name = name
      }
    }
    assert.ok(!(new ForeignViemNotFound('TransactionNotFoundError') instanceof TransactionNotFoundError))

    const client = toEvmPublicClient({
      async readContract () { return 0n },
      async waitForTransactionReceipt () { return { status: 'success' } },
      async getTransactionReceipt () { throw new ForeignViemNotFound('TransactionReceiptNotFoundError') },
      async getTransaction () { throw new ForeignViemNotFound('TransactionNotFoundError') }
    })
    assert.equal(await client.getTransactionReceipt?.('0xhash'), null)
    assert.equal(await client.getTransaction?.('0xhash'), null)
  })

  it('adapts a viem public client: an error merely named like a not-found is still rethrown', async () => {
    // Right name, no viem BaseError shape: an RPC fault must not be able to pass
    // itself off as "does not exist" and force a false pending/cross-API result.
    const named = (name: string) => Object.assign(new Error('HTTP 503 from the RPC provider'), { name })
    const client = toEvmPublicClient({
      async readContract () { return 0n },
      async waitForTransactionReceipt () { return { status: 'success' } },
      async getTransactionReceipt () { throw named('TransactionReceiptNotFoundError') },
      async getTransaction () { throw named('TransactionNotFoundError') }
    })
    await assert.rejects(async () => { await client.getTransactionReceipt?.('0xhash') }, /503/)
    await assert.rejects(async () => { await client.getTransaction?.('0xhash') }, /503/)
  })

  it('adapts a viem wallet client and requires a bound account', () => {
    const adapted = toEvmWalletClient({
      account: { address: VALID_SENDER },
      sendTransaction: async () => '0xhash' as `0x${string}`
    })
    assert.equal(adapted.account.address, VALID_SENDER)
    // A client without a bound account is rejected up front.
    assert.throws(
      () => toEvmWalletClient({ sendTransaction: async () => '0x0' as `0x${string}` }),
      ButterConfigurationError
    )
  })
})
