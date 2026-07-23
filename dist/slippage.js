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
import { BTC_CHAIN_ID, CROSS_CHAIN_MIN_SLIPPAGE_BPS, DEFAULT_SLIPPAGE_BPS, STRICT_CHAIN_MIN_SLIPPAGE_BPS, TON_CHAIN_ID } from './constants.js';
import { ButterActionRequiredError, ButterUnsupportedError } from './errors.js';
/** Converts WDK decimal slippage to Butter basis points and enforces minimums. */
export function toButterSlippage(slippage, options = {}) {
    const minimum = minimumSlippageBps(options);
    const explicitBps = slippage == null ? Math.max(DEFAULT_SLIPPAGE_BPS, minimum) : Math.ceil(Number(slippage) * 10000);
    if (!Number.isFinite(explicitBps) || explicitBps < 0 || explicitBps > 5000) {
        throw new ButterUnsupportedError('slippage must be a decimal between 0 and 0.5');
    }
    if (explicitBps < minimum) {
        throw new ButterActionRequiredError(`Butter requires at least ${minimum} bps slippage for this route`, {
            requestedBps: explicitBps,
            requiredBps: minimum
        });
    }
    return explicitBps;
}
/** Returns the minimum Butter slippage in basis points for a route. */
export function minimumSlippageBps(options) {
    const source = normalizeId(options.sourceChainId);
    const destination = normalizeId(options.toChainId);
    const strict = options.strictChainMinimum ?? (isStrictChain(source) || isStrictChain(destination) ? STRICT_CHAIN_MIN_SLIPPAGE_BPS : 0);
    return Math.max(options.crossChain ? CROSS_CHAIN_MIN_SLIPPAGE_BPS : 0, strict);
}
function normalizeId(id) {
    return id == null ? undefined : String(id).toLowerCase();
}
function isStrictChain(id) {
    return id === BTC_CHAIN_ID || id === TON_CHAIN_ID || id === 'btc' || id === 'ton';
}
//# sourceMappingURL=slippage.js.map