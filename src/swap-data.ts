import {
  decodeAbiParameters,
  decodeFunctionData,
  isAddress,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex
} from 'viem'
import { NATIVE_TOKEN_ADDRESSES } from './constants.js'
import { parseIntegerAmount } from './amounts.js'
import {
  ButterApiError,
  ButterConfigurationError,
  ButterTransactionValidationError
} from './errors.js'
import { routerDeploymentsForChain, type ButterRouterRegistry } from './router-registry.js'
import type { ButterRoute, ButterSwapTx } from './types.js'

const ROUTER_V3_ABI = parseAbi([
  'function swapAndBridge(bytes32 transferId,address initiator,address srcToken,uint256 amount,bytes swapData,bytes bridgeData,bytes permitData,bytes feeData)',
  'function swapAndCall(bytes32 transferId,address initiator,address srcToken,uint256 amount,bytes swapData,bytes callbackData,bytes permitData,bytes feeData)'
])

const SWAP_PARAM = parseAbiParameters(
  '(address dstToken,address receiver,address leftReceiver,uint256 minAmount,(uint8 dexType,address callTo,address approveTo,uint256 fromAmount,bytes callData)[] swaps)'
)

const BRIDGE_PARAM = parseAbiParameters(
  '(uint256 toChain,uint256 nativeFee,bytes receiver,bytes data)'
)

const BRIDGE_ADAPTER_PARAM = parseAbiParameters(
  '(uint256 gasLimit,bytes refundAddress,bytes swapData)'
)

const REMOTE_SWAP_AND_CALL = parseAbiParameters('bytes swapData,bytes callbackData')

export interface SwapValidationContext {
  sourceChainId: string
  destinationChainId: string
  route: ButterRoute
  routerRegistry: ButterRouterRegistry
  nativeSource: boolean
  requestedAmountIn?: bigint
  minimumAmountOut?: bigint
  sender: string
  receiver: string
  sourceToken: string
  destinationToken: string
  requireRouterAllowlist: boolean
}

export function validateSwapTransactions (
  swapData: unknown,
  context: SwapValidationContext
): ButterSwapTx[] {
  const transactions = Array.isArray(swapData) ? swapData : [swapData]
  if (transactions.length === 0) {
    throw new ButterApiError('Butter /swap returned no transaction data')
  }

  return transactions.map((tx) => validateSwapTransaction(tx, context))
}

export function validateSwapTransaction (
  value: unknown,
  context: SwapValidationContext
): ButterSwapTx {
  if (!value || typeof value !== 'object') {
    throw new ButterApiError('Butter /swap returned invalid transaction data', value)
  }
  const tx = value as Partial<ButterSwapTx>
  if (!tx.to || tx.value == null || tx.chainId == null) {
    throw new ButterApiError('Butter /swap transaction is missing required fields', value)
  }
  if (String(tx.chainId) !== context.sourceChainId) {
    throw new ButterTransactionValidationError('Butter /swap transaction chain does not match source chain', value)
  }

  if (context.requireRouterAllowlist) {
    validateEvmRouterTransaction(
      tx as Partial<ButterSwapTx> & Pick<ButterSwapTx, 'to' | 'value' | 'chainId'>,
      context
    )
  }

  return {
    to: tx.to,
    value: tx.value,
    chainId: tx.chainId,
    data: tx.data,
    method: tx.method,
    args: tx.args,
    memo: tx.memo
  }
}

function validateEvmRouterTransaction (
  tx: Partial<ButterSwapTx> & Pick<ButterSwapTx, 'to' | 'value' | 'chainId'>,
  context: SwapValidationContext
): void {
  const deployment = assertRouterAllowed(tx.to, context.sourceChainId, context.routerRegistry)
  if (context.route.contract) {
    assertRouterAllowed(context.route.contract, context.sourceChainId, context.routerRegistry)
    assertAddressEqual(tx.to, context.route.contract, 'Butter route contract does not match /swap target')
  }
  if (deployment.version !== 'v3') {
    throw new ButterConfigurationError(`No calldata validator for Butter router ${deployment.version}`)
  }
  if (!tx.data || !isHexData(tx.data)) {
    throw new ButterTransactionValidationError('Butter /swap transaction is missing valid calldata', tx)
  }

  let decoded: ReturnType<typeof decodeFunctionData<typeof ROUTER_V3_ABI>>
  try {
    decoded = decodeFunctionData({ abi: ROUTER_V3_ABI, data: tx.data as Hex })
  } catch (cause) {
    throw new ButterTransactionValidationError('Butter /swap returned malformed or unsupported Router V3 calldata', { cause })
  }
  if (decoded.functionName !== 'swapAndCall' && decoded.functionName !== 'swapAndBridge') {
    throw new ButterTransactionValidationError('Butter /swap returned an unsupported Router V3 function')
  }
  if (tx.method != null && tx.method !== decoded.functionName) {
    throw new ButterTransactionValidationError('Butter /swap method metadata does not match calldata', {
      method: tx.method,
      decodedMethod: decoded.functionName
    })
  }

  const args = decoded.args as readonly [Hex, Address, Address, bigint, Hex, Hex, Hex, Hex]
  const [, initiator, srcToken, amount, encodedSwap, functionData, permitData] = args
  assertAddressEqual(initiator, context.sender, 'Butter Router initiator does not match sender')
  assertTokenEqual(srcToken, context.sourceToken, 'Butter Router source token does not match quote')
  if (context.requestedAmountIn == null || amount !== context.requestedAmountIn) {
    throw new ButterTransactionValidationError('Butter Router source amount does not match quote', {
      expected: context.requestedAmountIn?.toString(),
      actual: amount.toString()
    })
  }
  if (permitData !== '0x') {
    throw new ButterTransactionValidationError('Butter Router permit data is not supported')
  }

  const sameChain = context.sourceChainId === context.destinationChainId
  if (sameChain) {
    if (decoded.functionName !== 'swapAndCall') {
      throw new ButterTransactionValidationError('Same-chain Butter execution must use swapAndCall')
    }
    if (functionData !== '0x') {
      throw new ButterTransactionValidationError('Butter Router callback data is not supported')
    }
    validateSameChainSwapParam(encodedSwap, context)
  } else {
    if (decoded.functionName !== 'swapAndBridge') {
      throw new ButterTransactionValidationError('Cross-chain Butter execution must use swapAndBridge')
    }
    validateCrossChainParams(encodedSwap, functionData, context)
  }

  let nativeValue: bigint
  try {
    nativeValue = parseIntegerAmount(tx.value)
  } catch (cause) {
    throw new ButterTransactionValidationError('Butter /swap returned an invalid native value', { cause })
  }
  const expectedValue = context.nativeSource ? context.requestedAmountIn : 0n
  if (expectedValue == null || nativeValue !== expectedValue) {
    throw new ButterTransactionValidationError('Butter /swap native value does not match quoted input', {
      expected: expectedValue?.toString(),
      actual: nativeValue.toString()
    })
  }
}

function validateSameChainSwapParam (encoded: Hex, context: SwapValidationContext): void {
  const swap = decodeSwapParam(encoded)
  assertTokenEqual(swap.dstToken, context.destinationToken, 'Butter Router destination token does not match quote')
  assertAddressEqual(swap.receiver, context.receiver, 'Butter Router receiver does not match requested recipient')
  assertAddressEqual(swap.leftReceiver, context.sender, 'Butter Router leftover receiver does not match sender')
  if (context.minimumAmountOut == null || swap.minAmount < context.minimumAmountOut) {
    throw new ButterTransactionValidationError('Butter Router minimum output is below quoted minimum', {
      expectedMinimum: context.minimumAmountOut?.toString(),
      actual: swap.minAmount.toString()
    })
  }
}

function validateCrossChainParams (encodedSwap: Hex, encodedBridge: Hex, context: SwapValidationContext): void {
  let bridgedToken = context.sourceToken
  if (encodedSwap !== '0x') {
    const sourceSwap = decodeSwapParam(encodedSwap)
    bridgedToken = sourceSwap.dstToken
    assertAddressEqual(sourceSwap.receiver, context.sender, 'Butter source swap receiver does not match sender')
    assertAddressEqual(sourceSwap.leftReceiver, context.sender, 'Butter source swap leftover receiver does not match sender')
    if (sourceSwap.minAmount <= 0n) {
      throw new ButterTransactionValidationError('Butter source swap minimum output must be positive')
    }
  }

  let bridge: { toChain: bigint, nativeFee: bigint, receiver: Hex, data: Hex }
  try {
    ;[bridge] = decodeAbiParameters(BRIDGE_PARAM, encodedBridge)
  } catch (cause) {
    throw new ButterTransactionValidationError('Butter Router bridge parameters are malformed', { cause })
  }
  if (bridge.toChain.toString() !== context.destinationChainId) {
    throw new ButterTransactionValidationError('Butter Router destination chain does not match quote', {
      expected: context.destinationChainId,
      actual: bridge.toChain.toString()
    })
  }
  if (bridge.receiver === '0x') {
    throw new ButterTransactionValidationError('Butter Router bridge receiver is missing')
  }
  if (bridge.data === '0x') {
    validateDirectBridgeRecipient(bridge.receiver, bridgedToken, context)
    return
  }

  let adapter: { gasLimit: bigint, refundAddress: Hex, swapData: Hex }
  try {
    ;[adapter] = decodeAbiParameters(BRIDGE_ADAPTER_PARAM, bridge.data)
  } catch (cause) {
    throw new ButterTransactionValidationError('Butter bridge adapter parameters are malformed', { cause })
  }
  assertPackedAddressEqual(adapter.refundAddress, context.sender, 'Butter bridge refund address does not match sender')
  if (adapter.swapData === '0x') {
    validateDirectBridgeRecipient(bridge.receiver, bridgedToken, context)
    return
  }

  const destinationRouter = packedAddress(bridge.receiver, 'Butter destination router address is malformed')
  assertRouterAllowed(destinationRouter, context.destinationChainId, context.routerRegistry)
  let destinationSwapData: Hex
  let callbackData: Hex
  try {
    ;[destinationSwapData, callbackData] = decodeAbiParameters(REMOTE_SWAP_AND_CALL, adapter.swapData)
  } catch (cause) {
    throw new ButterTransactionValidationError('Butter destination swap parameters are malformed', { cause })
  }
  if (callbackData !== '0x') {
    throw new ButterTransactionValidationError('Butter destination callback data is not supported')
  }
  if (destinationSwapData === '0x') {
    throw new ButterTransactionValidationError('Butter destination swap data is missing')
  }
  const destinationSwap = decodeSwapParam(destinationSwapData)
  assertTokenEqual(destinationSwap.dstToken, context.destinationToken, 'Butter destination token does not match quote')
  assertAddressEqual(destinationSwap.receiver, context.receiver, 'Butter destination receiver does not match requested recipient')
  assertAddressEqual(destinationSwap.leftReceiver, context.receiver, 'Butter destination leftover receiver does not match requested recipient')
  if (context.minimumAmountOut == null || destinationSwap.minAmount < context.minimumAmountOut) {
    throw new ButterTransactionValidationError('Butter destination minimum output is below quoted minimum', {
      expectedMinimum: context.minimumAmountOut?.toString(),
      actual: destinationSwap.minAmount.toString()
    })
  }
}

function validateDirectBridgeRecipient (receiver: Hex, bridgedToken: string, context: SwapValidationContext): void {
  assertPackedAddressEqual(receiver, context.receiver, 'Butter bridge receiver does not match requested recipient')
  assertTokenEqual(bridgedToken, context.destinationToken, 'Butter bridged token does not match destination token')
}

function decodeSwapParam (encoded: Hex): {
  dstToken: Address
  receiver: Address
  leftReceiver: Address
  minAmount: bigint
} {
  try {
    const [swap] = decodeAbiParameters(SWAP_PARAM, encoded)
    return swap
  } catch (cause) {
    throw new ButterTransactionValidationError('Butter Router swap parameters are malformed', { cause })
  }
}

export function assertRouterAllowed (
  address: string,
  chainId: string,
  registry: ButterRouterRegistry
): ReturnType<typeof routerDeploymentsForChain>[number] {
  const deployments = routerDeploymentsForChain(registry, chainId)
  if (deployments.length === 0) {
    throw new ButterConfigurationError(`No Butter router contracts configured for chain ${chainId}`)
  }
  const deployment = deployments.find(({ address: allowed }) => normalizeAddress(allowed) === normalizeAddress(address))
  if (!deployment) {
    throw new ButterTransactionValidationError('Butter router address is not allowlisted', { chainId, address })
  }
  return deployment
}

function assertAddressEqual (actual: string, expected: string, message: string): void {
  if (!isAddress(actual, { strict: false }) || !isAddress(expected, { strict: false }) || normalizeAddress(actual) !== normalizeAddress(expected)) {
    throw new ButterTransactionValidationError(message, { expected, actual })
  }
}

function assertTokenEqual (actual: string, expected: string, message: string): void {
  const actualNormalized = normalizeAddress(actual)
  const expectedNormalized = normalizeAddress(expected)
  const bothNative = NATIVE_TOKEN_ADDRESSES.has(actualNormalized) && NATIVE_TOKEN_ADDRESSES.has(expectedNormalized)
  if (!bothNative && actualNormalized !== expectedNormalized) {
    throw new ButterTransactionValidationError(message, { expected, actual })
  }
}

function assertPackedAddressEqual (encoded: Hex, expected: string, message: string): void {
  const actual = packedAddress(encoded, message)
  assertAddressEqual(actual, expected, message)
}

function packedAddress (encoded: Hex, message: string): Address {
  if (encoded.length !== 42 || !isAddress(encoded, { strict: false })) {
    throw new ButterTransactionValidationError(message, { encoded })
  }
  return encoded
}

function isHexData (value: string): boolean {
  return /^0x(?:[0-9a-fA-F]{2})*$/.test(value)
}

export function normalizeAddress (address: string): string {
  return address.toLowerCase()
}
