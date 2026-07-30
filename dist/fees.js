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
import { NATIVE_TOKEN_ADDRESSES, SOLANA_CHAIN_ID, BTC_CHAIN_ID, TRON_CHAIN_ID } from './constants.js';
import { parseTokenAmount } from './amounts.js';
import { feeConfigChargesFee } from './swap-data.js';
import { ButterApiError, ButterConfigurationError, ButterFeeLimitExceededError, ButterFeeValuationError } from './errors.js';
const USD_DECIMALS = 18;
const BPS_DENOMINATOR = 10000n;
/** Resolves and validates constructor and per-call WDK fee limits. */
export function resolveFeeLimits(defaults, overrides) {
    const network = overrides.maxNetworkFeeBps ?? defaults.maxNetworkFeeBps;
    const protocol = overrides.maxProtocolFeeBps ?? defaults.maxProtocolFeeBps;
    const result = {};
    if (network != null)
        result.maxNetworkFeeBps = parseBps(network, 'maxNetworkFeeBps');
    if (protocol != null)
        result.maxProtocolFeeBps = parseBps(protocol, 'maxProtocolFeeBps');
    return result;
}
/** Validates configured fee limits eagerly, rejecting malformed bps values. */
export function validateFeeLimits(config) {
    resolveFeeLimits(config, {});
}
/**
 * Rounding for **reported** fee amounts.
 *
 * These are display/estimate values, not enforced ones, so a Butter response with
 * more decimals than the token carries (a USDT fee quoted to 7 places) must not
 * reject the whole quote — under-reporting a displayed fee by one base unit cannot
 * harm the caller. Cap-enforcement parses elsewhere in this file deliberately keep
 * `'reject'`, or `'ceil'` where the value is a quoted upper bound.
 */
const DISPLAY_ROUNDING = { rounding: 'floor' };
/**
 * Maps Butter fee metadata into WDK fee entries using denomination-specific decimals.
 *
 * NOTE (upstream WDK contract): the base SwidgeProtocol's legacy `swap()` and
 * `bridge()` sum `fees[].amount` across entries regardless of denomination.
 * Butter fees can be denominated in different tokens (native, input token,
 * bridge token), so the legacy aggregated `fee` / `bridgeFee` have no coherent
 * unit when denominations differ. Consumers needing correct per-currency costs
 * must read the itemised `fees[]` on the SwidgeQuote/SwidgeResult, not the
 * legacy scalars. This cannot be fixed here without overriding legacy methods
 * (which providers must not do); it needs a WDK PR #39 mapping-contract change.
 */
export function mapRouteFees(route, context) {
    const fees = [];
    const sourceToken = route.srcChain?.tokenIn;
    const nativeDecimals = nativeDecimalsForChain(context.sourceChainId, context.nativeTokenDecimals);
    for (const component of bridgeFeeComponents(route)) {
        fees.push({
            type: 'protocol',
            amount: parseTokenAmount(component.amount, component.decimals, DISPLAY_ROUNDING),
            token: component.token,
            chain: route.bridgeFee?.chainId,
            included: true,
            description: component.description
        });
    }
    if (isNonZero(route.bridgeFee?.affiliate?.amount)) {
        const token = route.bridgeFee?.affiliate?.token;
        fees.push({
            type: 'affiliate',
            amount: parseTokenAmount(route.bridgeFee?.affiliate?.amount, requiredDecimals(token, 'affiliate fee'), DISPLAY_ROUNDING),
            token: requiredTokenId(token?.address ?? token?.symbol, 'affiliate fee'),
            chain: route.bridgeFee?.chainId,
            included: true,
            description: 'Butter affiliate fee'
        });
    }
    if (isNonZero(route.gasFee?.amount)) {
        fees.push({
            type: 'network',
            amount: parseTokenAmount(route.gasFee?.amount, nativeDecimals, DISPLAY_ROUNDING),
            token: requiredTokenId(route.gasFee?.address ?? route.gasFee?.symbol ?? nativeTokenId(context), 'network fee'),
            chain: route.gasFee?.chainId ?? context.sourceChainId,
            included: false,
            description: 'Estimated source chain gas fee'
        });
    }
    if (isNonZero(route.swapFee?.nativeFee)) {
        fees.push({
            type: 'protocol',
            amount: parseTokenAmount(route.swapFee?.nativeFee, nativeDecimals, DISPLAY_ROUNDING),
            token: requiredTokenId(route.swapFee?.nativeSymbol ?? route.gasFee?.address ?? route.gasFee?.symbol ?? nativeTokenId(context), 'native protocol fee'),
            chain: context.sourceChainId,
            included: false,
            description: 'Butter native swap fee'
        });
    }
    if (isNonZero(route.swapFee?.tokenFee)) {
        fees.push({
            type: 'protocol',
            amount: parseTokenAmount(route.swapFee?.tokenFee, requiredDecimals(sourceToken, 'token protocol fee'), DISPLAY_ROUNDING),
            token: requiredTokenId(sourceToken?.address ?? context.sourceToken ?? route.swapFee?.tokenSymbol, 'token protocol fee'),
            chain: context.sourceChainId,
            included: true,
            description: 'Butter token swap fee'
        });
    }
    return reportFeeCaveats(fees, context);
}
/**
 * Emits the caveats a caller reading only WDK's surface could not otherwise see,
 * and guarantees a populated array.
 *
 * The WDK integration guide requires fees to always be a populated array, and an
 * empty one also reads as "free" rather than "Butter told us nothing". The
 * placeholder is zero-amount and only added when there is nothing else, so it can
 * never mask a real fee.
 */
function reportFeeCaveats(fees, context) {
    if (fees.length === 0) {
        context.onWarning?.({
            code: 'no-fees-reported',
            message: 'Butter reported no fees for this route; fees[] carries a zero-amount placeholder'
        });
        return [{
                type: 'network',
                amount: 0n,
                // A `network` fee is gas, which is always paid in the chain's native token —
                // never in the input token. `nativeTokenId` only answers when the source token
                // IS native, so fall back to the generic 'native' identifier (recognized in
                // NATIVE_TOKEN_ADDRESSES) rather than mislabelling gas as e.g. USDC.
                token: nativeTokenId(context) ?? 'native',
                chain: context.sourceChainId,
                included: false,
                description: 'Butter reported no fees for this route'
            }];
    }
    const protocolTokens = new Set(fees.filter(({ type }) => type === 'protocol').map(({ token }) => token));
    if (protocolTokens.size > 1) {
        context.onWarning?.({
            code: 'mixed-currency-protocol-fees',
            message: 'Butter protocol fees span multiple tokens; the WDK legacy bridgeFee scalar sums across denominations and is not meaningful — read fees[]',
            details: { tokens: [...protocolTokens] }
        });
    }
    return fees;
}
/**
 * Returns the route's additional native protocol fee in source-chain base units.
 *
 * Rounds up: this value is the quoted side of an upper bound on `tx.value`
 * (`swap-data.ts`), so rounding down would turn a sub-wei formatting artifact in
 * Butter's decimal string into a rejected transaction. Rounding up can only widen
 * the bound by one wei, and the absolute `maxNativeFee` cap is unaffected.
 */
export function routeNativeFee(route, context) {
    return parseTokenAmount(route.swapFee?.nativeFee ?? '0', nativeDecimalsForChain(context.sourceChainId, context.nativeTokenDecimals), { rounding: 'ceil' });
}
/** Enforces WDK network and protocol fee caps before transaction construction. */
export function enforceFeeLimits(route, context, limits) {
    if (limits.maxNetworkFeeBps != null) {
        enforceLimit('network', networkFeeRatios(route, context), limits.maxNetworkFeeBps);
    }
    if (limits.maxProtocolFeeBps != null) {
        enforceLimit('protocol', protocolFeeRatios(route, context), limits.maxProtocolFeeBps);
    }
}
function networkFeeRatios(route, context) {
    // Absent is NOT zero. An unreported gas fee cannot be valued, so a configured cap
    // must fail closed rather than score it as free — otherwise omitting the metadata
    // is enough to pass any limit. An explicit zero is a real answer and passes.
    // Only reached when a cap is configured (see enforceFeeLimits).
    if (route.gasFee?.amount == null) {
        throw new ButterFeeValuationError('Cannot enforce the Butter network fee cap: the route reports no gas fee amount');
    }
    if (!isNonZero(route.gasFee.amount))
        return [];
    const nativeDecimals = nativeDecimalsForChain(context.sourceChainId, context.nativeTokenDecimals);
    const gasAmount = parseTokenAmount(route.gasFee?.amount, nativeDecimals);
    if (isNativeSource(context.sourceToken)) {
        // Source is native here, so native decimals are the source token's decimals.
        return [{ numerator: gasAmount, denominator: sourceDenominator(context, route, nativeDecimals) }];
    }
    return [usdRatio(route.gasFee?.inUSD, route.totalAmountInUSD, 'network fee')];
}
function protocolFeeRatios(route, context) {
    const ratios = [];
    const sourceToken = route.srcChain?.tokenIn;
    const sourceDecimals = requiredDecimals(sourceToken, 'source token');
    const nativeDecimals = nativeDecimalsForChain(context.sourceChainId, context.nativeTokenDecimals);
    // A cross-chain route always carries a bridge fee (route.ts rejects a cross-chain
    // response without dstChain, so its presence is the reliable cross-chain signal).
    // Absent is not zero: scoring an unreported bridge fee as free would let omitted
    // metadata pass any cap. An explicit zero in any of the three places is a real
    // answer and passes.
    const bridgeFee = route.bridgeFee;
    const reportsBridgeFee = bridgeFee?.amount != null || bridgeFee?.in?.amount != null || bridgeFee?.out?.amount != null;
    if (route.dstChain != null && !reportsBridgeFee) {
        throw new ButterFeeValuationError('Cannot enforce the Butter protocol fee cap: the cross-chain route reports no bridge fee amount');
    }
    // The integrator fee appears twice: `swapFee` reports it, and `feeConfig` encodes
    // it for the calldata. Only `feeConfig` is verified against what the Router will
    // actually charge (`swap-data.ts: validateFeeData`), so counting `swapFee` alone
    // let a route declare a fat `feeConfig`, omit `swapFee`, pass any cap, and then
    // execute calldata carrying the fee. They are taken as two views of ONE fee — the
    // larger wins rather than being summed, which neither double-counts when they
    // agree nor lets the under-reported one decide when they do not.
    const integratorRate = feeConfigRateRatio(route, context);
    const tokenFeeRatio = isNonZero(route.swapFee?.tokenFee)
        ? {
            numerator: parseTokenAmount(route.swapFee?.tokenFee, sourceDecimals),
            denominator: sourceDenominator(context, route, sourceDecimals)
        }
        : undefined;
    const proportional = largerRatio(tokenFeeRatio, integratorRate);
    if (proportional)
        ratios.push(proportional);
    const feeConfigNative = feeConfigNativeAmount(route);
    if (isNonZero(route.swapFee?.nativeFee) || feeConfigNative != null) {
        // Same pairing on the native side: feeType 0 is a fixed native fee, which is
        // what `swapFee.nativeFee` reports.
        const reported = parseTokenAmount(route.swapFee?.nativeFee, nativeDecimals);
        const nativeFee = feeConfigNative != null && feeConfigNative > reported ? feeConfigNative : reported;
        if (isNativeSource(context.sourceToken)) {
            ratios.push({ numerator: nativeFee, denominator: sourceDenominator(context, route, nativeDecimals) });
        }
        else {
            const gasAmount = parseTokenAmount(route.gasFee?.amount, nativeDecimals);
            const gasUsd = parseUsd(route.gasFee?.inUSD, 'native protocol fee');
            const inputUsd = parseUsd(route.totalAmountInUSD, 'native protocol fee');
            if (gasAmount === 0n)
                throw new ButterFeeValuationError('Cannot value Butter native protocol fee without a nonzero gas fee');
            ratios.push({ numerator: nativeFee * gasUsd, denominator: gasAmount * inputUsd });
        }
    }
    for (const component of bridgeFeeComponents(route)) {
        ratios.push(bridgeFeeComponentRatio(component, route, context));
    }
    return ratios;
}
/** Butter's proportional integrator fee type; `rateOrNativeFee` is then in bps. */
const FEE_TYPE_PROPORTION = 1;
/** Butter's fixed integrator fee type; `rateOrNativeFee` is then source-chain wei. */
const FEE_TYPE_FIXED_NATIVE = 0;
/**
 * Values a **proportional** integrator fee (`feeType: 1`) as a fraction of the input.
 *
 * `rateOrNativeFee` is in basis points of the input amount, so the ratio is simply
 * `rate / 10000` — it depends on no Butter-reported amount at all, which makes this
 * the one fee check in the module that requires zero trust in the route.
 *
 * Returns `undefined` when the config charges nothing or is a fixed-native fee
 * (handled separately). Fails closed on a `feeType` this package does not model:
 * an unrecognized encoding could charge anything.
 */
function feeConfigRateRatio(route, context) {
    const config = route.feeConfig;
    if (!feeConfigChargesFee(config))
        return undefined;
    const feeType = Number(config?.feeType);
    if (!Number.isInteger(feeType) || (feeType !== FEE_TYPE_PROPORTION && feeType !== FEE_TYPE_FIXED_NATIVE)) {
        throw new ButterFeeValuationError('Cannot value the Butter integrator fee: unrecognized feeConfig feeType', {
            feeType: config?.feeType
        });
    }
    if (feeType !== FEE_TYPE_PROPORTION)
        return undefined;
    if (!isNonZero(route.swapFee?.tokenFee)) {
        context.onWarning?.({
            code: 'undeclared-integrator-fee',
            message: 'Butter feeConfig charges a proportional integrator fee that swapFee does not report; the quoted fees understate what the Router will take',
            details: { feeConfig: config }
        });
    }
    return { numerator: BigInt(config?.rateOrNativeFee ?? 0), denominator: BPS_DENOMINATOR };
}
/** Fixed native integrator fee (`feeType: 0`) in source-chain base units, if any. */
function feeConfigNativeAmount(route) {
    const config = route.feeConfig;
    if (!feeConfigChargesFee(config))
        return undefined;
    if (Number(config?.feeType) !== FEE_TYPE_FIXED_NATIVE)
        return undefined;
    return BigInt(config?.rateOrNativeFee ?? 0);
}
/** Returns whichever ratio is larger, comparing by cross-multiplication. */
function largerRatio(left, right) {
    if (!left)
        return right;
    if (!right)
        return left;
    return left.numerator * right.denominator >= right.numerator * left.denominator ? left : right;
}
/**
 * Resolves `bridgeFee` into its priced components.
 *
 * Butter reports a bridge fee as a top-level `{ amount, address, symbol }` summary
 * plus `in` and `out` parts that each carry their own amount and token. The docs
 * describe `in`/`out` only as "input/output token details" and never say whether
 * the summary is their sum or a restatement of `out` — the published example has
 * `in.amount: "0.0"`, so it cannot distinguish the two.
 *
 * Preferring the components is correct under either reading: if the summary is a
 * sum, `in + out` equals it; if it only mirrors `out`, `in + out` is the more
 * complete figure. It is never lower than the summary, so this cannot under-report
 * while the ambiguity stands. The summary is used only when neither part exists.
 *
 * Each component keeps its own token rather than sharing one guessed for the whole
 * fee: `in` and `out` can sit on different chains in different tokens, and folding
 * them into a single entry forced a guess about which one to report.
 */
function bridgeFeeComponents(route) {
    const fee = route.bridgeFee;
    const parts = [
        { part: fee?.in, label: 'inbound' },
        { part: fee?.out, label: 'outbound' }
    ];
    const components = [];
    for (const { part, label } of parts) {
        if (!isNonZero(part?.amount))
            continue;
        components.push({
            amount: part?.amount,
            token: requiredTokenId(part?.token?.address ?? part?.token?.symbol, `${label} bridge fee`),
            decimals: requiredDecimals(part?.token, `${label} bridge fee`),
            routeToken: part?.token,
            description: `Butter ${label} bridge fee`
        });
    }
    if (components.length > 0)
        return components;
    if (!isNonZero(fee?.amount))
        return [];
    // Neither part is present: fall back to the summary, resolving its token the way
    // this always did.
    const token = bridgeFeeToken(route);
    return [{
            amount: fee?.amount,
            token: requiredTokenId(fee?.address ?? token?.address ?? fee?.symbol ?? token?.symbol, 'bridge fee'),
            decimals: requiredDecimals(token, 'bridge fee'),
            routeToken: token,
            description: 'Butter bridge fee'
        }];
}
/**
 * Values one bridge fee component against a denominator in its OWN token.
 *
 * When the component is charged in the SOURCE token the caller's own input is
 * available and MUST be used: falling through to a route-reported amount reopens
 * precisely the bypass `sourceDenominator` exists to close — inflate
 * `srcChain.totalAmountIn` and any ratio can be pushed under a bps cap. A component
 * in some other token has no caller-supplied amount to divide by, which is the
 * documented trust concession; but it is matched strictly by token and **never**
 * falls back to an amount denominated in a different currency, since dividing by
 * the wrong currency produces a meaningless ratio.
 */
function bridgeFeeComponentRatio(component, route, context) {
    const numerator = parseTokenAmount(component.amount, component.decimals);
    if (tokenHasAddress(component.routeToken, context.sourceToken)) {
        return { numerator, denominator: sourceDenominator(context, route, component.decimals) };
    }
    const candidates = [
        { token: route.bridgeChain?.tokenIn, amount: route.bridgeChain?.totalAmountIn },
        { token: route.bridgeChain?.tokenOut, amount: route.bridgeChain?.totalAmountOut },
        { token: route.srcChain?.tokenOut, amount: route.srcChain?.totalAmountOut },
        { token: route.dstChain?.tokenOut, amount: route.dstChain?.totalAmountOut },
        { token: route.srcChain?.tokenIn, amount: route.srcChain?.totalAmountIn }
    ];
    const denominator = candidates.find((candidate) => sameToken(candidate.token, component.routeToken) && candidate.amount != null);
    if (!denominator?.amount) {
        throw new ButterFeeValuationError('Cannot value a Butter bridge fee component against a route amount in the same token', {
            token: component.token,
            description: component.description
        });
    }
    return { numerator, denominator: parseTokenAmount(denominator.amount, component.decimals) };
}
/** True when a route token is the given address/identifier (case-insensitive). */
function tokenHasAddress(token, address) {
    const candidate = token?.address?.trim();
    if (!candidate || !address.trim())
        return false;
    return candidate.toLowerCase() === address.trim().toLowerCase();
}
function enforceLimit(type, ratios, maximumBps) {
    let total = { numerator: 0n, denominator: 1n };
    for (const ratio of ratios) {
        if (ratio.denominator <= 0n)
            throw new ButterFeeValuationError(`Cannot value Butter ${type} fee against a zero amount`);
        total = {
            numerator: total.numerator * ratio.denominator + ratio.numerator * total.denominator,
            denominator: total.denominator * ratio.denominator
        };
    }
    if (total.numerator * BPS_DENOMINATOR > maximumBps * total.denominator) {
        const actualBps = (total.numerator * BPS_DENOMINATOR + total.denominator - 1n) / total.denominator;
        throw new ButterFeeLimitExceededError(type, actualBps, maximumBps);
    }
}
function usdRatio(feeUsd, inputUsd, label) {
    return {
        numerator: parseUsd(feeUsd, label),
        denominator: parseUsd(inputUsd, label)
    };
}
function parseUsd(value, label) {
    if (value == null)
        throw new ButterFeeValuationError(`Cannot value Butter ${label} without USD metadata`);
    return parseTokenAmount(value, USD_DECIMALS);
}
/**
 * Denominator for source-denominated fee caps: the caller's exact input, NOT the
 * route-reported `srcChain.totalAmountIn` (which is untrusted and, if inflated,
 * would understate the ratio and let an over-cap fee pass).
 *
 * Exact-out has no exact input to use, so the denominator is
 * `min(maxFromTokenAmount, route-reported input)`. The `min` is what keeps this
 * safe in both directions: the caller's cap bounds it from above, so inflating the
 * reported input cannot understate the ratio; and if Butter instead under-reports,
 * the smaller denominator overstates the ratio and trips the cap, which is the
 * fail-closed direction. The reported value is only ever allowed to make the check
 * stricter, never looser.
 */
function sourceDenominator(context, route, sourceDecimals) {
    if (context.requestedAmountIn != null)
        return context.requestedAmountIn;
    if (context.maxAmountIn == null) {
        throw new ButterFeeValuationError('Cannot value a source-denominated Butter fee without the requested input amount');
    }
    const reported = parseTokenAmount(route.srcChain?.totalAmountIn, sourceDecimals, { rounding: 'floor' });
    return reported > 0n && reported < context.maxAmountIn ? reported : context.maxAmountIn;
}
function bridgeFeeToken(route) {
    const fee = route.bridgeFee;
    const candidates = [fee?.out?.token, fee?.in?.token, route.bridgeChain?.tokenOut, route.bridgeChain?.tokenIn, route.srcChain?.tokenOut];
    return candidates.find((token) => tokenMatchesFee(token, fee)) ?? candidates.find((token) => token != null);
}
function tokenMatchesFee(token, fee) {
    if (!token || !fee)
        return false;
    if (fee.address && token.address)
        return fee.address.toLowerCase() === token.address.toLowerCase();
    if (fee.symbol && token.symbol)
        return fee.symbol.toLowerCase() === token.symbol.toLowerCase();
    return false;
}
function sameToken(left, right) {
    if (!left || !right)
        return false;
    if (left.address && right.address)
        return left.address.toLowerCase() === right.address.toLowerCase();
    return Boolean(left.symbol && right.symbol && left.symbol.toLowerCase() === right.symbol.toLowerCase());
}
function requiredDecimals(token, label) {
    const decimals = Number(token?.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
        throw new ButterApiError(`Butter ${label} is missing valid token decimals`);
    }
    return decimals;
}
function requiredTokenId(value, label) {
    const token = value?.trim();
    if (!token)
        throw new ButterApiError(`Butter ${label} is missing a token identifier`);
    return token;
}
function nativeTokenId(context) {
    return isNativeSource(context.sourceToken) ? context.sourceToken : undefined;
}
/** Resolves source-chain native token decimals with caller overrides. */
export function nativeDecimalsForChain(chainId, configured) {
    const configuredValue = configured?.[chainId];
    if (configuredValue != null)
        return configuredValue;
    if (chainId === TRON_CHAIN_ID)
        return 6;
    if (chainId === BTC_CHAIN_ID)
        return 8;
    if (chainId === SOLANA_CHAIN_ID)
        return 9;
    return 18;
}
function isNativeSource(token) {
    return NATIVE_TOKEN_ADDRESSES.has(token.toLowerCase());
}
function isNonZero(value) {
    if (value == null)
        return false;
    const raw = String(value).trim();
    return !/^0+(?:\.0+)?$/.test(raw);
}
function parseBps(value, field) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
        throw new ButterConfigurationError(`${field} must be a non-negative integer`);
    }
    const result = BigInt(value);
    if (result < 0n)
        throw new ButterConfigurationError(`${field} must be a non-negative integer`);
    return result;
}
//# sourceMappingURL=fees.js.map