// Copyright 2026 Butter Network
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { ButterApiError } from './errors.js'
import type { SwidgeStatusResult } from './types.js'

export function mapStatusResponse (id: string, data: unknown, hints: { fromChain?: string | number, toChain?: string | number, byOrderId?: boolean } = {}): SwidgeStatusResult {
  const info = ((data as { info?: unknown })?.info ?? data) as Record<string, unknown>
  if (!info || typeof info !== 'object' || Object.keys(info).length === 0) {
    throw new ButterApiError('Butter returned no swidge for the requested id', { id, data })
  }
  if (info.state == null && info.status == null) {
    throw new ButterApiError('Butter status response is missing a state', { id, data })
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

/**
 * Maps a Butter state code to a WDK SwidgeStatus.
 *
 * Known numeric codes: 0 crossing, 1 completed, 2 failed, 6 refunded. Any
 * unrecognized value throws instead of being silently reported as `pending`,
 * so real refund/partial/failure states are never masked. Extend this table
 * once Butter publishes the authoritative state enumeration.
 */
function mapButterStatus (state: unknown): SwidgeStatusResult['status'] {
  if (state === 0 || state === '0' || state === 'crossing' || state === 'pending') return 'pending'
  if (state === 1 || state === '1' || state === 'completed' || state === 'success') return 'completed'
  if (state === 6 || state === '6' || state === 'refunded') return 'refunded'
  if (state === 2 || state === '2' || state === 'failed') return 'failed'
  if (state === 'action-required') return 'action-required'
  if (state === 'refund-pending') return 'refund-pending'
  if (state === 'cancelled') return 'cancelled'
  if (state === 'expired') return 'expired'
  if (state === 'partial') return 'partial'
  throw new ButterApiError('Unrecognized Butter swidge state', { state })
}

function chainIdOf (value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  return stringValue((value as { chainId?: unknown }).chainId)
}

function stringValue (value: unknown): string | undefined {
  return value == null ? undefined : String(value)
}
