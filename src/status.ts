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
import type { ButterSwidgeStatusOptions, EvmTransactionReceipt, SwidgeStatusResult } from './types.js'

/**
 * Maps an on-chain receipt to a SwidgeStatus for same-chain swaps, which do not
 * produce a Butter cross-chain record. A missing receipt means the tx is not
 * yet mined (pending). Mapping is **fail-closed**: only an explicit success maps
 * to `completed` and only an explicit revert to `failed`; any unknown or missing
 * status maps to `pending` rather than falsely reporting completion.
 */
export function mapReceiptStatus (id: string, receipt: EvmTransactionReceipt | null | undefined, chain?: string | number): SwidgeStatusResult {
  if (receipt == null) return { status: 'pending', transactions: [] }
  const kind = classifyReceiptStatus(receipt)
  const swidgeStatus: SwidgeStatusResult['status'] =
    kind === 'success' ? 'completed' : kind === 'reverted' ? 'failed' : 'pending'
  return {
    status: swidgeStatus,
    transactions: [{ hash: id, chain, type: 'source' as const }]
  }
}

/**
 * Classifies an EVM receipt's status as an explicit `success`, an explicit
 * `reverted`, or `unknown` (missing/unrecognized). Shared by same-chain status
 * mapping and approval-receipt confirmation so both fail closed on `unknown`
 * rather than treating an uninterpretable receipt as success.
 */
export function classifyReceiptStatus (receipt: EvmTransactionReceipt | null | undefined): 'success' | 'reverted' | 'unknown' {
  const status = receipt?.status
  if (status === 'success' || status === 1 || status === '0x1' || status === true) return 'success'
  if (status === 'reverted' || status === 0 || status === '0x0' || status === false) return 'reverted'
  return 'unknown'
}

export function mapStatusResponse (id: string, data: unknown, hints: ButterSwidgeStatusOptions = {}): SwidgeStatusResult {
  // Tolerate either an object or a single-element array, and an optional `info`
  // envelope, since Butter's status response shape is not formally documented.
  let info = (data as { info?: unknown })?.info ?? data
  if (Array.isArray(info)) info = info[0]
  if (!info || typeof info !== 'object' || Array.isArray(info) || Object.keys(info).length === 0) {
    throw new ButterApiError('Butter returned no swidge for the requested id', { id, data })
  }
  const record = info as Record<string, unknown>
  if (record.state == null && record.status == null) {
    throw new ButterApiError('Butter status response is missing a state', { id, data })
  }
  // Do not fabricate a source hash from `id`: for a byOrderId lookup `id` is an
  // order id, not a transaction hash. Only trust a hash Butter actually reports.
  const reportedSourceHash = stringValue(record.sourceHash ?? record.fromHash)
  if (!hints.byOrderId && reportedSourceHash && reportedSourceHash.toLowerCase() !== id.toLowerCase()) {
    throw new ButterApiError('Butter status sourceHash does not match requested id', data)
  }
  const fromChain = chainIdOf(record.fromChain) ?? stringValue(record.fromChainId)
  const toChain = chainIdOf(record.toChain) ?? stringValue(record.toChainId)
  if (hints.fromChain != null && fromChain && String(hints.fromChain) !== fromChain) {
    throw new ButterApiError('Butter status source chain does not match request hints', data)
  }
  if (hints.toChain != null && toChain && String(hints.toChain) !== toChain) {
    throw new ButterApiError('Butter status destination chain does not match request hints', data)
  }
  const sourceHash = reportedSourceHash ?? (hints.byOrderId ? undefined : id)
  const destinationHash = stringValue(record.toHash ?? record.destHash ?? record.destinationHash)
  const transactions = []
  if (sourceHash) transactions.push({ hash: sourceHash, chain: fromChain, type: 'source' as const })
  if (destinationHash) transactions.push({ hash: destinationHash, chain: toChain, type: 'destination' as const })
  return {
    status: mapButterStatus(record.state ?? record.status),
    transactions
  }
}

/**
 * Authoritative Butter cross-state codes (bs-app-api), confirmed 2026-07-24:
 * `0` crossing, `1` completed, `6` refund. There is deliberately no numeric
 * `failed` code. Canonical WDK status strings are also honored in case Butter
 * ever emits them directly.
 */
const BUTTER_STATE_MAP: Record<string, SwidgeStatusResult['status']> = {
  0: 'pending',
  crossing: 'pending',
  pending: 'pending',
  1: 'completed',
  completed: 'completed',
  success: 'completed',
  6: 'refunded',
  refund: 'refunded',
  refunded: 'refunded',
  'action-required': 'action-required',
  'refund-pending': 'refund-pending',
  failed: 'failed',
  cancelled: 'cancelled',
  expired: 'expired',
  partial: 'partial'
}

/**
 * Maps a Butter state to a WDK SwidgeStatus.
 *
 * Unrecognized values map conservatively to `pending` (in-flight) rather than
 * throwing or being reported as terminal: `getSwidgeStatus` is a polling
 * method, and Butter may return intermediate codes (e.g. relaying) beyond the
 * documented `0/1/6`. Mislabeling an in-flight transfer as failed/refunded
 * would be worse than reporting it as still pending.
 */
function mapButterStatus (state: unknown): SwidgeStatusResult['status'] {
  if (state == null) return 'pending'
  return BUTTER_STATE_MAP[String(state).toLowerCase()] ?? 'pending'
}

function chainIdOf (value: unknown): string | undefined {
  if (value == null) return undefined
  // Butter may return a chain as a nested object ({ chainId }) or a bare scalar.
  if (typeof value === 'object') return stringValue((value as { chainId?: unknown }).chainId)
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return undefined
}

function stringValue (value: unknown): string | undefined {
  return value == null ? undefined : String(value)
}
