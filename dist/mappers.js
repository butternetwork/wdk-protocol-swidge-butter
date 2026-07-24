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
import { parseTokenAmount } from './amounts.js';
import { mapRouteFees } from './fees.js';
import { decimalsOf } from './route.js';
/**
 * Builds a WDK quote from a Butter route.
 *
 * For exact-in the caller passes `requestedAmountIn` (the base-unit input the
 * user asked for); the quote echoes it verbatim so `fromTokenAmount` can never
 * drift from the request due to a decimals-source mismatch. Output amounts use
 * the route-echoed destination decimals, which must be present.
 */
export function routeToQuote(route, now, expiry, feeContext, requestedAmountIn) {
    const destinationDecimals = decimalsOf(route.dstChain?.tokenOut ?? route.srcChain?.tokenOut, 'destination token');
    const toTokenAmountMin = parseTokenAmount(route.minAmountOut?.amount ?? route.amountOutMin, destinationDecimals);
    const fromTokenAmount = requestedAmountIn != null
        ? BigInt(requestedAmountIn)
        : parseTokenAmount(route.srcChain?.totalAmountIn ?? route.totalAmountIn, decimalsOf(route.srcChain?.tokenIn, 'source token'));
    return {
        fromTokenAmount,
        toTokenAmount: parseTokenAmount(route.dstChain?.totalAmountOut ?? route.srcChain?.totalAmountOut ?? route.totalAmountOut, destinationDecimals),
        toTokenAmountMin,
        fees: mapRouteFees(route, feeContext),
        estimatedDuration: finiteOrUndefined(route.timeEstimated ?? route.estimatedTime),
        expiry: expiry ?? now() + 300,
        // Passed through as reported by Butter; the unit (decimal vs percent) is not
        // formally documented, so we only guard against non-numeric values here.
        priceImpact: finiteOrUndefined(route.priceImpact)
    };
}
/** Returns a finite number, or undefined when the value is absent or unparseable. */
function finiteOrUndefined(value) {
    if (value == null)
        return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
export function chainToSupportedChain(chain, execution) {
    const nativeToken = parseJsonMaybe(chain.nativeToken);
    return {
        id: normalizeId(chain.chainId ?? chain.id),
        name: chain.name ?? normalizeId(chain.chainId ?? chain.id),
        type: String(chain.chainType ?? chain.type ?? 'unknown').toLowerCase(),
        nativeToken: nativeToken?.symbol ?? '',
        execution
    };
}
export function tokenToSupportedToken(token, chainId) {
    return {
        token: token.address ?? token.token ?? '',
        chain: normalizeId(token.chainId ?? chainId),
        symbol: token.symbol ?? '',
        // `decimals` is required by SwidgeSupportedToken, so it cannot be undefined;
        // Butter's token API always reports it, and 18 is only a last-resort default.
        decimals: Number(token.decimals ?? token.decimal ?? 18),
        address: token.address ?? token.token,
        name: token.name
    };
}
export function parseJsonMaybe(value) {
    if (typeof value !== 'string')
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
export function normalizeId(id) {
    return id == null ? '' : String(id);
}
//# sourceMappingURL=mappers.js.map