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
import { sameTransactionHash } from './identifiers.js'
import type { ButterSwidgeStatusOptions, EvmTransactionReceipt, SwidgeStatusResult } from './types.js'

/**
 * Maps an on-chain receipt to a SwidgeStatus for same-chain swaps, which do not
 * produce a Butter cross-chain record. A missing receipt means the tx is not
 * yet mined (pending). Mapping is **fail-closed**: only an explicit success maps
 * to `completed` and only an explicit revert to `failed`; any unknown or missing
 * status maps to `pending` rather than falsely reporting completion.
 *
 * @param {string} id - The identifier to normalize or query.
 * @param {EvmTransactionReceipt | null | undefined} receipt - The transaction receipt to classify.
 * @param {string | number} [chain] - The chain metadata to inspect.
 * @returns {SwidgeStatusResult} The mapped provider result.
 */
export function mapReceiptStatus (id: string, receipt: EvmTransactionReceipt | null | undefined, chain?: string | number): SwidgeStatusResult {
  if (receipt == null) return { status: 'pending', transactions: [] }
  const kind = classifyReceiptStatus(receipt)
  const swidgeStatus: SwidgeStatusResult['status'] =
    kind === 'success' ? 'completed' : kind === 'reverted' ? 'failed' : 'pending'
  return {
    status: swidgeStatus,
    transactions: [{
      hash: id,
      ...(chain != null ? { chain } : {}),
      type: 'source' as const
    }]
  }
}

/**
 * Maps the raw WDK Solana receipt, retaining normalized account receipt support.
 *
 * @param {string} id - The recorded source transaction signature.
 * @param {unknown} receipt - The account's raw or normalized transaction receipt.
 * @param {string | number} chain - The source chain identifier.
 * @returns {SwidgeStatusResult} The receipt's terminal state, or pending for unknown metadata.
 */
export function mapSolanaReceiptStatus (id: string, receipt: unknown, chain: string | number): SwidgeStatusResult {
  if (receipt == null) return mapReceiptStatus(id, null, chain)
  let status = 'unknown'
  if (typeof receipt === 'object' && !Array.isArray(receipt)) {
    if (!('meta' in receipt)) return mapReceiptStatus(id, receipt as EvmTransactionReceipt, chain)
    const meta = receipt.meta
    if (meta != null && typeof meta === 'object' && !Array.isArray(meta) && 'err' in meta) {
      const error = meta.err
      if (error === null) status = 'success'
      else if ((typeof error === 'string' && error.trim() !== '') ||
        (typeof error === 'object' && !Array.isArray(error) && Object.keys(error).length > 0)) {
        status = 'reverted'
      }
    }
  }
  return mapReceiptStatus(id, { status }, chain)
}

/**
 * Classifies an EVM receipt's status as an explicit `success`, an explicit
 * `reverted`, or `unknown` (missing/unrecognized). Shared by same-chain status
 * mapping and approval-receipt confirmation so both fail closed on `unknown`
 * rather than treating an uninterpretable receipt as success.
 *
 * @param {EvmTransactionReceipt | null | undefined} receipt - The transaction receipt to classify.
 * @returns {'success' | 'reverted' | 'unknown'} The explicit success, revert, or unknown classification.
 */
export function classifyReceiptStatus (receipt: EvmTransactionReceipt | null | undefined): 'success' | 'reverted' | 'unknown' {
  const status = receipt?.status
  if (status === 'success' || status === 1 || status === '0x1' || status === true) return 'success'
  if (status === 'reverted' || status === 0 || status === '0x0' || status === false) return 'reverted'
  return 'unknown'
}

// Transaction.Result.contractResult failures (2-15), from
// https://github.com/tronprotocol/protocol/blob/master/core/Tron.proto
const TRON_CONTRACT_FAILURES = new Set([
  'REVERT', 'BAD_JUMP_DESTINATION', 'OUT_OF_MEMORY', 'PRECOMPILED_CONTRACT',
  'STACK_TOO_SMALL', 'STACK_TOO_LARGE', 'ILLEGAL_OPERATION', 'STACK_OVERFLOW',
  'OUT_OF_ENERGY', 'OUT_OF_TIME', 'JVM_STACK_OVER_FLOW', 'UNKNOWN',
  'TRANSFER_FAILED', 'INVALID_CODE'
])

/**
 * Maps a raw Tron receipt, giving native outcomes precedence over normalized status.
 *
 * @param {string} id - The recorded source transaction hash.
 * @param {unknown} receipt - The account's raw or normalized transaction receipt.
 * @param {string | number} chain - The source chain identifier.
 * @returns {SwidgeStatusResult} The explicit terminal state, or pending for unknown metadata.
 */
export function mapTronReceiptStatus (id: string, receipt: unknown, chain: string | number): SwidgeStatusResult {
  if (receipt == null) return mapReceiptStatus(id, null, chain)
  let status = 'unknown'
  if (typeof receipt === 'object' && !Array.isArray(receipt)) {
    if (!('result' in receipt) && !('receipt' in receipt)) {
      return mapReceiptStatus(id, receipt as EvmTransactionReceipt, chain)
    }
    const result = 'result' in receipt ? receipt.result : undefined
    const resource = 'receipt' in receipt ? receipt.receipt : undefined
    const contractResult = resource != null && typeof resource === 'object' &&
      !Array.isArray(resource) && 'result' in resource ? resource.result : undefined
    if (result === 'FAILED' || (typeof contractResult === 'string' && TRON_CONTRACT_FAILURES.has(contractResult))) {
      status = 'reverted'
    } else if (contractResult === 'SUCCESS' && (!('result' in receipt) || result === 'SUCESS')) {
      // SUCESS is the official TransactionInfo.code spelling.
      status = 'success'
    }
  }
  return mapReceiptStatus(id, { status }, chain)
}

/**
 * Maps a partially trusted Butter status response to the WDK status contract.
 *
 * @param {string} id - The identifier to normalize or query.
 * @param {unknown} data - The partially trusted data to inspect.
 * @param {ButterSwidgeStatusOptions} [hints] - The optional source and destination chain hints (default: empty object).
 * @returns {SwidgeStatusResult} The mapped provider result.
 * @throws {ButterApiError} If Butter returns malformed, inconsistent, or unsuccessful data.
 */
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
  // Format-aware, using the TRANSACTION HASH domain: EVM `0x` hex and bare 64-hex
  // (Bitcoin, Tron) are case-insensitive, while a Solana signature is Base58 where
  // two casings are two different signatures. Comparing hashes loosely reported one
  // transaction's status for another; comparing them with the token-identifier rule
  // rejected a BTC txid that merely differed in case.
  if (!hints.byOrderId && reportedSourceHash && !sameTransactionHash(reportedSourceHash, id)) {
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
  if (sourceHash) {
    transactions.push({
      hash: sourceHash,
      ...(fromChain != null ? { chain: fromChain } : {}),
      type: 'source' as const
    })
  }
  if (destinationHash) {
    transactions.push({
      hash: destinationHash,
      ...(toChain != null ? { chain: toChain } : {}),
      type: 'destination' as const
    })
  }
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
const BUTTER_STATE_MAP = new Map<string, SwidgeStatusResult['status']>([
  ['0', 'pending'],
  ['crossing', 'pending'],
  ['pending', 'pending'],
  ['1', 'completed'],
  ['completed', 'completed'],
  ['success', 'completed'],
  ['6', 'refunded'],
  ['refund', 'refunded'],
  ['refunded', 'refunded'],
  ['action-required', 'action-required'],
  ['refund-pending', 'refund-pending'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
  ['expired', 'expired'],
  ['partial', 'partial']
])

/**
 * Maps a Butter state to a WDK SwidgeStatus.
 *
 * Unrecognized values map conservatively to `pending` (in-flight) rather than
 * throwing or being reported as terminal: `getSwidgeStatus` is a polling
 * method, and Butter may return intermediate codes (e.g. relaying) beyond the
 * documented `0/1/6`. Mislabeling an in-flight transfer as failed/refunded
 * would be worse than reporting it as still pending.
 *
 * @param {unknown} state - The Butter state value to map.
 * @returns {SwidgeStatusResult['status']} The mapped provider result.
 */
function mapButterStatus (state: unknown): SwidgeStatusResult['status'] {
  if (typeof state !== 'string' && !(typeof state === 'number' && Number.isFinite(state))) return 'pending'
  return BUTTER_STATE_MAP.get(String(state).toLowerCase()) ?? 'pending'
}

/**
 * Extracts a chain identifier from scalar or nested Butter metadata.
 *
 * @param {unknown} value - The scalar chain id or nested `{ chainId }` metadata.
 * @returns {string | undefined} The chain identifier, or undefined when unusable.
 */
function chainIdOf (value: unknown): string | undefined {
  if (value == null) return undefined
  // Butter may return a chain as a nested object ({ chainId }) or a bare scalar.
  if (typeof value === 'object') return stringValue((value as { chainId?: unknown }).chainId)
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return undefined
}

/**
 * Converts a scalar status value to a string while rejecting structured values.
 *
 * @param {unknown} value - The optional scalar status field.
 * @returns {string | undefined} The scalar string value, or undefined for structured data.
 */
function stringValue (value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}
