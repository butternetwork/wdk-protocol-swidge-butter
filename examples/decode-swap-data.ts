import {
  decodeAbiParameters,
  decodeFunctionData,
  parseAbi,
  parseAbiParameters,
  size,
  type Hex
} from 'viem'
import ButterSwidgeProtocol from '@butternetwork/wdk-protocol-swidge-butter'

import {
  butterAuthFromEnv,
  envOrDefault,
  numberFromEnv,
  positiveBigIntFromEnv,
  printJson,
  requireEnv,
  runExample
} from './shared.js'

const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000'

const ROUTER_V3_ABI = parseAbi([
  'function swapAndBridge(bytes32 transferId,address initiator,address srcToken,uint256 amount,bytes swapData,bytes bridgeData,bytes permitData,bytes feeData)',
  'function swapAndCall(bytes32 transferId,address initiator,address srcToken,uint256 amount,bytes swapData,bytes callbackData,bytes permitData,bytes feeData)'
])

/** Outer bridge payload, already decoded and checked by `swap-data.ts`. */
const BRIDGE_PARAM = parseAbiParameters('(uint256 toChain,uint256 nativeFee,bytes receiver,bytes data)')

/**
 * The nested payload this script exists to confirm. Butter's router-interface
 * documentation gives `b_data` as `(uint256 gasLimit, bytes refundAddress,
 * bytes swapData)`, but the package does not decode it today, so the layout has
 * never been checked against a live response.
 */
const BRIDGE_DATA_PARAM = parseAbiParameters('(uint256 gasLimit,bytes refundAddress,bytes swapData)')

/**
 * Read-only diagnostic: fetches a real `/route` + `/swap` pair and decodes the
 * nested bridge payload. No wallet is constructed and nothing is signed or
 * broadcast — only two GET requests are made.
 *
 * Run it before relying on `refundAddress` verification; if the decode below
 * fails on live data, the documented layout is wrong and the verification must
 * not be built on it.
 */
runExample(async () => {
  const sourceChainId = envOrDefault('SOURCE_CHAIN_ID', '56')
  const destinationChainId = envOrDefault('DESTINATION_CHAIN_ID', '137')
  const fromToken = envOrDefault('FROM_TOKEN', NATIVE_TOKEN)
  const sender = requireEnv('SENDER')
  const recipient = envOrDefault('RECIPIENT', sender)
  // One base URL for both the library's `/route` and the raw `/swap` below, so
  // an override cannot point the two halves at different deployments.
  const routerBaseUrl = envOrDefault('BUTTER_ROUTER_BASE_URL', 'https://bs-router-v3.chainservice.io')

  // The library owns the `/route` request; observe the slippage it settled on
  // (floors and defaults are applied inside) so the raw `/swap` call below
  // reproduces the same route rather than a differently-priced one.
  let slippageBps: string | undefined
  const observingFetch = async (
    url: string,
    init?: { method?: string, headers?: Record<string, string> }
  ): Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }> => {
    const response = await globalThis.fetch(url, init)
    const body: unknown = await response.json()
    if (url.includes('/route')) slippageBps = new URL(url).searchParams.get('slippage') ?? undefined
    return { ok: response.ok, status: response.status, json: async () => body }
  }

  const tokenDecimals = fromToken.toLowerCase() === NATIVE_TOKEN
    ? {}
    : { [fromToken]: numberFromEnv('FROM_TOKEN_DECIMALS') }
  const protocol = new ButterSwidgeProtocol(undefined, {
    sourceChainId,
    entrance: requireEnv('BUTTER_ENTRANCE'),
    routerBaseUrl,
    fetch: observingFetch,
    ...butterAuthFromEnv(),
    tokenDecimals
  })

  const quote = await protocol.quoteSwidge({
    fromToken,
    toToken: envOrDefault('TO_TOKEN', NATIVE_TOKEN),
    toChain: destinationChainId,
    fromTokenAmount: positiveBigIntFromEnv('FROM_TOKEN_AMOUNT', process.env, 1000000000000000n),
    slippage: numberFromEnv('SLIPPAGE', process.env, 0.02),
    recipient
  })

  const auth = butterAuthFromEnv()
  const swapUrl = new URL('/swap', routerBaseUrl)
  swapUrl.searchParams.set('hash', quote.routeHash)
  if (slippageBps != null) swapUrl.searchParams.set('slippage', slippageBps)
  swapUrl.searchParams.set('from', sender)
  swapUrl.searchParams.set('receiver', recipient)
  const swapResponse = await globalThis.fetch(swapUrl.toString(), {
    method: 'GET',
    headers: {
      ...(auth.apiKeyId ? { 'x-api-key-id': auth.apiKeyId } : {}),
      ...(auth.apiSecret ? { Authorization: `Bearer ${auth.apiSecret}` } : {})
    }
  })
  const swapBody = await swapResponse.json() as { errno?: number, message?: string, data?: unknown }
  if (!swapResponse.ok || swapBody.errno !== 0) {
    throw new Error(`Butter /swap failed (${swapResponse.status}): ${swapBody.message ?? 'unknown error'}`)
  }

  const transactions = (Array.isArray(swapBody.data) ? swapBody.data : [swapBody.data]) as Array<{ to?: string, data?: Hex }>
  printJson({
    routeHash: quote.routeHash,
    slippageBps,
    transactionCount: transactions.length,
    transactions: transactions.map((tx, index) => ({ index, to: tx.to, ...describe(tx.data) }))
  })
})

/** Runs a decode step, returning its failure as data so each stage can be reported separately. */
function tryDecode<T> (decode: () => T): { value: T } | { error: string } {
  try {
    return { value: decode() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function describe (data: Hex | undefined): Record<string, unknown> {
  if (data == null) return { error: 'transaction has no calldata' }
  const call = tryDecode(() => decodeFunctionData({ abi: ROUTER_V3_ABI, data }))
  if ('error' in call) return { error: `not a Router V3 call: ${call.error}` }
  const decoded = call.value
  if (decoded.functionName !== 'swapAndBridge') {
    return { functionName: decoded.functionName, note: 'same-chain call: no nested bridge payload' }
  }

  const bridgeData = decoded.args[5]
  const outerDecode = tryDecode(() => decodeAbiParameters(BRIDGE_PARAM, bridgeData)[0])
  if ('error' in outerDecode) {
    return { functionName: decoded.functionName, error: `outer bridge payload did not decode: ${outerDecode.error}` }
  }
  const bridge = outerDecode.value

  const outer = {
    functionName: decoded.functionName,
    toChain: bridge.toChain.toString(),
    nativeFee: bridge.nativeFee.toString(),
    receiver: bridge.receiver,
    receiverUtf8: asUtf8(bridge.receiver),
    nestedDataBytes: size(bridge.data)
  }
  if (bridge.data === '0x') {
    // The layout claim is neither confirmed nor refuted: there is nothing to decode.
    return { ...outer, nested: 'empty — this route carries no nested bridge payload' }
  }

  const innerDecode = tryDecode(() => decodeAbiParameters(BRIDGE_DATA_PARAM, bridge.data)[0])
  if ('error' in innerDecode) {
    return {
      ...outer,
      layoutConfirmed: false,
      error: `nested b_data did not decode as (uint256 gasLimit, bytes refundAddress, bytes swapData): ${innerDecode.error}`
    }
  }
  const inner = innerDecode.value

  return {
    ...outer,
    layoutConfirmed: true,
    gasLimit: inner.gasLimit.toString(),
    refundAddress: inner.refundAddress,
    // A 20-byte value is an EVM address; a longer one is usually the UTF-8
    // encoding of a non-EVM address. Both readings are printed so the on-wire
    // encoding is unambiguous.
    refundAddressBytes: size(inner.refundAddress),
    refundAddressUtf8: asUtf8(inner.refundAddress),
    nestedSwapDataBytes: size(inner.swapData)
  }
}

function asUtf8 (value: Hex): string | undefined {
  try {
    const text = Buffer.from(value.slice(2), 'hex').toString('utf8')
    return /^[\x20-\x7e]+$/.test(text) ? text : undefined
  } catch {
    return undefined
  }
}
