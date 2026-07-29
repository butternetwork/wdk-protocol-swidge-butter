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
/** Converts a non-negative decimal token amount into integer base units. */
export function parseTokenAmount(amount, decimals = 18, options = {}) {
    assertDecimals(decimals);
    if (amount == null)
        return 0n;
    if (typeof amount === 'bigint') {
        if (amount < 0n)
            throw new ButterApiError(`Invalid token amount: ${amount}`);
        return amount;
    }
    if (typeof amount === 'number' && (!Number.isSafeInteger(amount) || amount < 0)) {
        throw new ButterApiError(`Unsafe numeric token amount: ${amount}; use a decimal string`);
    }
    const raw = String(amount).trim();
    if (!/^\d+(\.\d+)?$/.test(raw)) {
        throw new ButterApiError(`Invalid token amount: ${raw}`);
    }
    const [whole = '0', fraction = ''] = raw.split('.');
    const rounding = options.rounding ?? 'reject';
    const losesPrecision = /[1-9]/.test(fraction.slice(decimals));
    if (losesPrecision && rounding === 'reject') {
        throw new ButterApiError(`Token amount exceeds ${decimals} decimal places: ${raw}`);
    }
    const normalizedFraction = fraction.slice(0, decimals).padEnd(decimals, '0');
    const truncated = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(normalizedFraction || '0');
    return losesPrecision && rounding === 'ceil' ? truncated + 1n : truncated;
}
/** Formats integer base units as a decimal token amount without floating point conversion. */
export function formatTokenAmount(amount, decimals = 18) {
    assertDecimals(decimals);
    if (typeof amount === 'number' && (!Number.isSafeInteger(amount) || amount < 0)) {
        throw new ButterApiError(`Unsafe numeric token amount: ${amount}; use bigint base units`);
    }
    const value = BigInt(amount);
    if (value < 0n)
        throw new ButterApiError(`Invalid token amount: ${amount}`);
    const scale = 10n ** BigInt(decimals);
    const whole = value / scale;
    const fraction = value % scale;
    if (fraction === 0n)
        return whole.toString();
    return `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}
/** Parses a decimal or hexadecimal integer amount returned by Butter. */
export function parseIntegerAmount(value) {
    if (value == null)
        return 0n;
    if (typeof value === 'bigint')
        return value;
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
        throw new ButterApiError(`Unsafe integer amount: ${value}`);
    }
    const raw = String(value);
    if (raw.startsWith('0x'))
        return BigInt(raw);
    return BigInt(raw);
}
function assertDecimals(decimals) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
        throw new ButterApiError(`Invalid token decimals: ${decimals}`);
    }
}
//# sourceMappingURL=amounts.js.map