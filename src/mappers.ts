import { parseTokenAmount } from './amounts.js'
import { decimalsOf } from './route.js'
import type {
  ButterChainInfo,
  ButterRoute,
  ButterTokenInfo,
  SwidgeFee,
  SwidgeQuote,
  SwidgeSupportedChain,
  SwidgeSupportedToken
} from './types.js'

export function routeToQuote (route: ButterRoute, now: () => number, expiry?: number): SwidgeQuote {
  const sourceDecimals = decimalsOf(route.srcChain?.tokenIn)
  const destinationDecimals = decimalsOf(route.dstChain?.tokenOut ?? route.srcChain?.tokenOut)
  const toTokenAmountMin = parseTokenAmount(route.minAmountOut?.amount ?? route.amountOutMin, destinationDecimals)
  return {
    fromTokenAmount: parseTokenAmount(route.srcChain?.totalAmountIn ?? route.totalAmountIn, sourceDecimals),
    toTokenAmount: parseTokenAmount(route.dstChain?.totalAmountOut ?? route.srcChain?.totalAmountOut ?? route.totalAmountOut, destinationDecimals),
    toTokenAmountMin,
    fees: routeFees(route),
    estimatedDuration: Number(route.timeEstimated ?? route.estimatedTime ?? 0),
    expiry: expiry ?? now() + 300,
    priceImpact: route.priceImpact == null ? undefined : Number(route.priceImpact)
  }
}

export function routeFees (route: ButterRoute): SwidgeFee[] {
  const fees: SwidgeFee[] = []
  const destinationDecimals = decimalsOf(route.dstChain?.tokenOut ?? route.srcChain?.tokenOut)
  if (route.bridgeFee?.amount != null) {
    fees.push({
      type: 'protocol',
      amount: parseTokenAmount(route.bridgeFee.amount, destinationDecimals),
      token: route.bridgeFee.address ?? route.bridgeFee.symbol ?? '',
      symbol: route.bridgeFee.symbol,
      chain: route.bridgeFee.chainId,
      included: true,
      description: 'Butter bridge fee'
    } as SwidgeFee & { symbol?: string })
  }
  if (route.gasFee?.amount != null) {
    fees.push({
      type: 'network',
      amount: parseTokenAmount(route.gasFee.amount, 18),
      token: route.gasFee.symbol ?? '',
      included: false,
      description: 'Estimated source chain gas fee'
    })
  }
  if (route.swapFee?.nativeFee != null) {
    fees.push({
      type: 'protocol',
      amount: parseTokenAmount(route.swapFee.nativeFee, 18),
      token: route.swapFee.nativeSymbol ?? '',
      included: false,
      description: 'Butter native swap fee'
    })
  }
  if (route.swapFee?.tokenFee != null) {
    fees.push({
      type: 'protocol',
      amount: parseTokenAmount(route.swapFee.tokenFee, destinationDecimals),
      token: route.swapFee.tokenSymbol ?? '',
      included: true,
      description: 'Butter token swap fee'
    })
  }
  return fees
}

export function chainToSupportedChain (chain: ButterChainInfo, execution: string): SwidgeSupportedChain & { execution: string } {
  const nativeToken = parseJsonMaybe<ButterTokenInfo>(chain.nativeToken)
  return {
    id: normalizeId(chain.chainId ?? chain.id),
    name: chain.name ?? normalizeId(chain.chainId ?? chain.id),
    type: String(chain.chainType ?? chain.type ?? 'unknown').toLowerCase(),
    nativeToken: nativeToken?.symbol ?? '',
    execution
  }
}

export function tokenToSupportedToken (token: ButterTokenInfo, chainId: string): SwidgeSupportedToken {
  return {
    token: token.address ?? token.token ?? '',
    chain: normalizeId(token.chainId ?? chainId),
    symbol: token.symbol ?? '',
    decimals: Number(token.decimals ?? token.decimal ?? 18),
    address: token.address ?? token.token,
    name: token.name
  }
}

export function parseJsonMaybe<T> (value: unknown): T | undefined {
  if (typeof value !== 'string') return value as T | undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

export function normalizeId (id: string | number | undefined): string {
  return id == null ? '' : String(id)
}
