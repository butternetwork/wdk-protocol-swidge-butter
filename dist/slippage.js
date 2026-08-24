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
import { BTC_CHAIN_ID, CROSS_CHAIN_MIN_SLIPPAGE_BPS, DEFAULT_SLIPPAGE_BPS, STRICT_CHAIN_MIN_SLIPPAGE_BPS } from './constants.js';
import { ButterActionRequiredError, ButterUnsupportedError } from './errors.js';
/**
 * Converts WDK decimal slippage to Butter basis points and enforces minimums.
 *
 * @param {number | undefined} slippage - The maximum caller-approved slippage as a decimal fraction.
 * @param {SlippageOptions} [options] - Route topology and chain-specific minimum context (default: empty object).
 * @returns {number} The caller-approved slippage in integer basis points.
 * @throws {ButterUnsupportedError} If slippage is outside 0 through 0.5 or cannot be expressed at one-basis-point precision.
 * @throws {ButterActionRequiredError} If the requested slippage is below Butter's route-specific minimum.
 */
export function toButterSlippage(slippage, options = {}) {
    const minimum = minimumSlippageBps(options);
    const explicitBps = slippage == null ? Math.max(DEFAULT_SLIPPAGE_BPS, minimum) : decimalToBps(slippage);
    if (!Number.isFinite(explicitBps) || explicitBps < 0 || explicitBps > 5000) {
        throw new ButterUnsupportedError('slippage must be a decimal between 0 and 0.5');
    }
    // A positive request finer than one basis point cannot be expressed to Butter.
    // Rejecting is the only option that neither exceeds the caller's stated maximum
    // nor silently sends 0 bps, which would all but guarantee a revert.
    if (slippage != null && slippage > 0 && explicitBps === 0) {
        throw new ButterUnsupportedError('slippage below 0.0001 (1 basis point) cannot be expressed to Butter', {
            slippage
        });
    }
    if (explicitBps < minimum) {
        throw new ButterActionRequiredError(`Butter requires at least ${minimum} bps slippage for this route`, {
            requestedBps: explicitBps,
            requiredBps: minimum
        });
    }
    return explicitBps;
}
/**
 * Returns the minimum Butter slippage in basis points for a route.
 *
 * @param {SlippageOptions} options - Route topology and chain-specific minimum context.
 * @returns {number} The minimum route slippage in basis points.
 */
export function minimumSlippageBps(options) {
    const source = normalizeId(options.sourceChainId);
    const destination = normalizeId(options.toChainId);
    const strict = options.strictChainMinimum ?? (isStrictChain(source) || isStrictChain(destination) ? STRICT_CHAIN_MIN_SLIPPAGE_BPS : 0);
    return Math.max(options.crossChain ? CROSS_CHAIN_MIN_SLIPPAGE_BPS : 0, strict);
}
/**
 * Converts a decimal slippage fraction (e.g. 0.0051 = 0.51%) to integer basis
 * points exactly, via its decimal string rather than `x * 10000` — floating point
 * makes `0.0051 * 10000` yield 51.000000000000006.
 *
 * WDK defines `slippage` as the **maximum acceptable** slippage, so sub-basis-point
 * precision truncates **down**: rounding up would authorize more slippage than the
 * caller stated, letting them receive less than they agreed to. A request that is
 * positive but floors to 0 bps cannot be honoured at Butter's 1 bp granularity, so
 * {@link toButterSlippage} rejects it rather than silently widening it to 1 bp.
 *
 * Non-finite or negative inputs return `NaN`/negative and fall through to the range
 * check in {@link toButterSlippage}.
 *
 * @param {number} value - The decimal slippage fraction to truncate to basis points.
 * @returns {number} The decimal fraction truncated to integer basis points.
 */
function decimalToBps(value) {
    if (!Number.isFinite(value) || value < 0)
        return value * 10000;
    const text = value.toString();
    // Scientific notation only occurs for tiny positive values here (< ~1e-6, i.e.
    // < 0.01 bp), which floor to 0 and are rejected as unrepresentable.
    if (text.includes('e') || text.includes('E'))
        return 0;
    const [whole = '0', fraction = ''] = text.split('.');
    return Number(whole) * 10000 + Number(fraction.slice(0, 4).padEnd(4, '0'));
}
/**
 * Converts an optional chain id to its lowercase comparison form.
 *
 * @param {string | number | undefined} id - The identifier to normalize or query.
 * @returns {string | undefined} The normalized value.
 */
function normalizeId(id) {
    return id == null ? undefined : String(id).toLowerCase();
}
/**
 * Returns whether a chain identifier requires the strict Butter slippage floor.
 *
 * @param {string | undefined} id - The identifier to normalize or query.
 * @returns {boolean} Whether the id is Butter's Bitcoin chain id or `btc` alias.
 */
function isStrictChain(id) {
    return id === BTC_CHAIN_ID || id === 'btc';
}
//# sourceMappingURL=slippage.js.map