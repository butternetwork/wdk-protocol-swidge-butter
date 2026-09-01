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
  ButterNoRouteError,
  ButterPartialExecutionError,
  ButterReadOnlyAccountError,
  ButterTransactionValidationError,
  ButterUnsupportedError,
  parseTokenAmount,
  toButterSlippage,
  toEvmWalletClient,
  toEvmPublicClient
} from '../../src/index.ts'

export function jsonResponse (body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    async json () {
      return body
    }
  }
}

export function failAfter<T> (ms: number): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`test deadline exceeded after ${ms}ms`)), ms))
}

export function dummyHash (nibble: number): `0x${string}` {
  return `0x${nibble.toString(16).repeat(64)}`
}

export function assertError<T extends Error> (
  value: unknown,
  ErrorType: new (...args: never[]) => T,
  message: string
): asserts value is T {
  const error = value as { name?: unknown, message?: unknown }
  assert.deepEqual(
    { name: error?.name, message: error?.message },
    { name: ErrorType.name, message }
  )
}

export function makeFetch (routes: Record<string, (url: URL, init: { headers?: Record<string, string> }) => Promise<unknown> | unknown>) {
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

export function quoteRoute (overrides: Record<string, unknown> = {}) {
  return {
    hash: '0x3333333333333333333333333333333333333333333333333333333333333333',
    timestamp: 1000,
    hasLiquidity: true,
    timeEstimated: 120,
    contract: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A',
    bridgeFee: {
      amount: '0.25',
      symbol: 'USDT',
      address: '0x00000000000000000000000000000000000000ee',
      chainId: '56',
      out: { amount: '0.25', token: { address: '0x00000000000000000000000000000000000000ee', decimals: 6, symbol: 'USDT' } }
    },
    gasFee: { amount: '0.0001', symbol: 'BNB' },
    swapFee: { nativeFee: '0', tokenFee: '0.02' },
    minAmountOut: { amount: '9.5', symbol: 'USDT' },
    srcChain: {
      chainId: '56',
      tokenIn: { address: '0x00000000000000000000000000000000000000ab', decimals: 18, symbol: 'BNB' },
      totalAmountIn: '1.5',
      totalAmountOut: '1.5'
    },
    dstChain: {
      chainId: '137',
      tokenOut: { address: '0x00000000000000000000000000000000000000cd', decimals: 6, symbol: 'USDT' },
      totalAmountOut: '10.25'
    },
    ...overrides
  }
}

export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000'

export const ERC20_TOKEN = '0x00000000000000000000000000000000000000aa'

export const DEST_TOKEN = '0x00000000000000000000000000000000000000cc'

export const VALID_SENDER = '0x0000000000000000000000000000000000000111'

export const VALID_RECIPIENT = '0x0000000000000000000000000000000000000222'

export const ROUTER = '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A'

export const SOLANA_CHAIN_ID = '1360108768460801'

export const FORMER_TON_CHAIN_ID = '1360104473493505'

export const DEFAULT_TOKEN_DECIMALS = { '0x00000000000000000000000000000000000000ab': 18, '0x00000000000000000000000000000000000000cd': 6 }

export const ERC20_TOKEN_DECIMALS = { [ERC20_TOKEN]: 18, [DEST_TOKEN]: 6 }

export function evmWallet (
  sendTransaction: (tx: unknown) => Promise<string | { hash?: string, fee?: bigint }>,
  address: string = VALID_SENDER
) {
  return { account: { address }, sendTransaction }
}

export const routerV3Abi = parseAbi([
  'function swapAndBridge(bytes32 transferId,address initiator,address srcToken,uint256 amount,bytes swapData,bytes bridgeData,bytes permitData,bytes feeData)',
  'function swapAndCall(bytes32 transferId,address initiator,address srcToken,uint256 amount,bytes swapData,bytes callbackData,bytes permitData,bytes feeData)'
])

export const swapParamAbi = parseAbiParameters(
  '(address dstToken,address receiver,address leftReceiver,uint256 minAmount,(uint8 dexType,address callTo,address approveTo,uint256 fromAmount,bytes callData)[] swaps)'
)

export const bridgeParamAbi = parseAbiParameters('(uint256 toChain,uint256 nativeFee,bytes receiver,bytes data)')

export const bridgeAdapterParamAbi = parseAbiParameters('(uint256 gasLimit,bytes refundAddress,bytes swapData)')

export const remoteSwapAndCallAbi = parseAbiParameters('bytes swapData,bytes callbackData')

export function crossChainSwapData (sourceToken: `0x${string}`, amount: bigint, options: {
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
    // An EVM refund destination travels as the raw 20 bytes; anything else
    // (such as base58 or bech32) travels as UTF-8 text, exactly as the validator reads it.
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

export const feeParamAbi = parseAbiParameters('(uint8 feeType,address referrer,uint256 rateOrNativeFee)')

export function encodeFeeData (feeType: number, referrer: `0x${string}`, rateOrNativeFee: bigint): `0x${string}` {
  return encodeAbiParameters(feeParamAbi, [{ feeType, referrer, rateOrNativeFee }])
}

export function sourceChainWithToken (address: string, symbol = 'BNB') {
  return {
    chainId: '56',
    tokenIn: { address, decimals: 18, symbol },
    totalAmountIn: '1.5',
    totalAmountOut: '1.5'
  }
}

export function sameChainSwapDataFor (sourceToken: `0x${string}`, amount: bigint): `0x${string}` {
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

export let account: { getAddress: () => Promise<string>, sendTransaction: (tx: unknown) => Promise<{ hash: string, tx: unknown }> }

export const NATIVE_FEE_PART = 20000000000000000n

export function nativeFeeFetch () {
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

export function nativeFeeOptions (maxNativeFee?: bigint) {
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

export function multiTxAdapterFetch (bitcoinChain: string) {
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

export function threeTxAdapterFetch (bitcoinChain: string, toChainId: string) {
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

export function threeTxAdapter (tx: { to: string }) {
    if (tx.to === 'btc-approval') return { transaction: tx, type: 'approval' as const }
    if (tx.to === 'btc-deposit') return { transaction: tx, type: 'source' as const }
    return { transaction: tx, type: 'other' as const }
  }

export function oversizedAllowanceFetch () {
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

export function protocolFailingOnSend (account: unknown, failAt: number, rejected: Error) {
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
          return dummyHash(sends + 13)
        })
      }
    })
  }

export const sameChainErc20Options = {
    fromToken: ERC20_TOKEN,
    toToken: DEST_TOKEN,
    toChain: 56,
    recipient: VALID_RECIPIENT,
    fromTokenAmount: 1500000000000000000n
  }

export function sameChainErc20Fetch () {
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

export function erc20FeeProtocol (send: (tx: unknown) => Promise<string | { hash?: string, fee?: bigint }>) {
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
