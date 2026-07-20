import { ButterApiError } from './errors.js'
import type { SwidgeStatusResult } from './types.js'

export function mapStatusResponse (id: string, data: unknown, hints: { fromChain?: string | number, toChain?: string | number, byOrderId?: boolean } = {}): SwidgeStatusResult {
  const info = ((data as { info?: unknown })?.info ?? data) as Record<string, unknown>
  if (!info || typeof info !== 'object') {
    throw new ButterApiError('Butter status response is missing info', data)
  }
  const sourceHash = stringValue(info.sourceHash ?? info.fromHash ?? id)
  if (!hints.byOrderId && sourceHash && sourceHash.toLowerCase() !== id.toLowerCase()) {
    throw new ButterApiError('Butter status sourceHash does not match requested id', data)
  }
  const fromChain = chainIdOf(info.fromChain) ?? stringValue(info.fromChainId)
  const toChain = chainIdOf(info.toChain) ?? stringValue(info.toChainId)
  if (hints.fromChain != null && fromChain && String(hints.fromChain) !== fromChain) {
    throw new ButterApiError('Butter status source chain does not match request hints', data)
  }
  if (hints.toChain != null && toChain && String(hints.toChain) !== toChain) {
    throw new ButterApiError('Butter status destination chain does not match request hints', data)
  }
  const destinationHash = stringValue(info.toHash ?? info.destHash ?? info.destinationHash)
  const transactions = []
  if (sourceHash) transactions.push({ hash: sourceHash, chain: fromChain, type: 'source' as const })
  if (destinationHash) transactions.push({ hash: destinationHash, chain: toChain, type: 'destination' as const })
  return {
    status: mapButterStatus(info.state ?? info.status),
    transactions
  }
}

function mapButterStatus (state: unknown): SwidgeStatusResult['status'] {
  if (state === 0 || state === '0' || state === 'crossing' || state === 'pending') return 'pending'
  if (state === 1 || state === '1' || state === 'completed' || state === 'success') return 'completed'
  if (state === 6 || state === '6' || state === 'refunded') return 'refunded'
  if (state === 2 || state === '2' || state === 'failed') return 'failed'
  throw new ButterApiError('Butter status response contains an unsupported state', { state })
}

function chainIdOf (value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  return stringValue((value as { chainId?: unknown }).chainId)
}

function stringValue (value: unknown): string | undefined {
  return value == null ? undefined : String(value)
}
