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
import { ButterApiError } from './errors.js';
export function mapStatusResponse(id, data, hints = {}) {
    const info = (data?.info ?? data);
    if (!info || typeof info !== 'object' || Object.keys(info).length === 0) {
        throw new ButterApiError('Butter returned no swidge for the requested id', { id, data });
    }
    if (info.state == null && info.status == null) {
        throw new ButterApiError('Butter status response is missing a state', { id, data });
    }
    const sourceHash = stringValue(info.sourceHash ?? info.fromHash ?? id);
    if (!hints.byOrderId && sourceHash && sourceHash.toLowerCase() !== id.toLowerCase()) {
        throw new ButterApiError('Butter status sourceHash does not match requested id', data);
    }
    const fromChain = chainIdOf(info.fromChain) ?? stringValue(info.fromChainId);
    const toChain = chainIdOf(info.toChain) ?? stringValue(info.toChainId);
    if (hints.fromChain != null && fromChain && String(hints.fromChain) !== fromChain) {
        throw new ButterApiError('Butter status source chain does not match request hints', data);
    }
    if (hints.toChain != null && toChain && String(hints.toChain) !== toChain) {
        throw new ButterApiError('Butter status destination chain does not match request hints', data);
    }
    const destinationHash = stringValue(info.toHash ?? info.destHash ?? info.destinationHash);
    const transactions = [];
    if (sourceHash)
        transactions.push({ hash: sourceHash, chain: fromChain, type: 'source' });
    if (destinationHash)
        transactions.push({ hash: destinationHash, chain: toChain, type: 'destination' });
    return {
        status: mapButterStatus(info.state ?? info.status),
        transactions
    };
}
/**
 * Authoritative Butter cross-state codes (bs-app-api), confirmed 2026-07-24:
 * `0` crossing, `1` completed, `6` refund. There is deliberately no numeric
 * `failed` code. Canonical WDK status strings are also honored in case Butter
 * ever emits them directly.
 */
const BUTTER_STATE_MAP = {
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
};
/**
 * Maps a Butter state to a WDK SwidgeStatus.
 *
 * Unrecognized values map conservatively to `pending` (in-flight) rather than
 * throwing or being reported as terminal: `getSwidgeStatus` is a polling
 * method, and Butter may return intermediate codes (e.g. relaying) beyond the
 * documented `0/1/6`. Mislabeling an in-flight transfer as failed/refunded
 * would be worse than reporting it as still pending.
 */
function mapButterStatus(state) {
    if (state == null)
        return 'pending';
    return BUTTER_STATE_MAP[String(state).toLowerCase()] ?? 'pending';
}
function chainIdOf(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    return stringValue(value.chainId);
}
function stringValue(value) {
    return value == null ? undefined : String(value);
}
//# sourceMappingURL=status.js.map