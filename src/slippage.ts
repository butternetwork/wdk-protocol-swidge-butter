import {
  BTC_CHAIN_ID,
  CROSS_CHAIN_MIN_SLIPPAGE_BPS,
  DEFAULT_SLIPPAGE_BPS,
  STRICT_CHAIN_MIN_SLIPPAGE_BPS
} from './constants.js'
import { ButterActionRequiredError, ButterUnsupportedError } from './errors.js'

export interface SlippageOptions {
  crossChain?: boolean
  sourceChainId?: string | number
  toChainId?: string | number
  strictChainMinimum?: number
}

export function toButterSlippage (slippage: number | undefined, options: SlippageOptions = {}): number {
  const explicitBps = slippage == null ? DEFAULT_SLIPPAGE_BPS : Math.ceil(Number(slippage) * 10000)
  if (!Number.isFinite(explicitBps) || explicitBps < 0 || explicitBps > 5000) {
    throw new ButterUnsupportedError('slippage must be a decimal between 0 and 0.5')
  }
  const minimum = minimumSlippageBps(options)
  if (explicitBps < minimum) {
    throw new ButterActionRequiredError(`Butter requires at least ${minimum} bps slippage for this route`, {
      requestedBps: explicitBps,
      requiredBps: minimum
    })
  }
  return explicitBps
}

export function minimumSlippageBps (options: SlippageOptions): number {
  const source = normalizeId(options.sourceChainId)
  const destination = normalizeId(options.toChainId)
  const strict = options.strictChainMinimum ?? (
    source === BTC_CHAIN_ID || destination === BTC_CHAIN_ID ? STRICT_CHAIN_MIN_SLIPPAGE_BPS : 0
  )
  return Math.max(options.crossChain ? CROSS_CHAIN_MIN_SLIPPAGE_BPS : 0, strict)
}

function normalizeId (id: string | number | undefined): string | undefined {
  return id == null ? undefined : String(id)
}
