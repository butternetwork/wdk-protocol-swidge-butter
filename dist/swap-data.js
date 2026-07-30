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
import { decodeAbiParameters, decodeFunctionData, isAddress, parseAbi, parseAbiParameters, stringToHex } from 'viem';
import { NATIVE_FEE_DRIFT_BPS, NATIVE_TOKEN_ADDRESSES } from './constants.js';
import { parseIntegerAmount } from './amounts.js';
import { ButterApiError, ButterConfigurationError, ButterTransactionValidationError, ButterUnsupportedError } from './errors.js';
import { routerDeploymentsForChain } from './router-registry.js';
const ROUTER_V3_ABI = parseAbi([
    'function swapAndBridge(bytes32 transferId,address initiator,address srcToken,uint256 amount,bytes swapData,bytes bridgeData,bytes permitData,bytes feeData)',
    'function swapAndCall(bytes32 transferId,address initiator,address srcToken,uint256 amount,bytes swapData,bytes callbackData,bytes permitData,bytes feeData)'
]);
const SWAP_PARAM = parseAbiParameters('(address dstToken,address receiver,address leftReceiver,uint256 minAmount,(uint8 dexType,address callTo,address approveTo,uint256 fromAmount,bytes callData)[] swaps)');
const BRIDGE_PARAM = parseAbiParameters('(uint256 toChain,uint256 nativeFee,bytes receiver,bytes data)');
/**
 * The payload nested inside `BRIDGE_PARAM.data`, per Butter's router-interface
 * documentation. Decoded only to verify an explicitly requested `refundAddress`;
 * the rest of the destination routing stays trusted (see
 * {@link validateBridgeParams}).
 */
const BRIDGE_DATA_PARAM = parseAbiParameters('(uint256 gasLimit,bytes refundAddress,bytes swapData)');
const FEE_PARAM = parseAbiParameters('(uint8 feeType,address referrer,uint256 rateOrNativeFee)');
export function validateSwapTransactions(swapData, context) {
    const transactions = Array.isArray(swapData) ? swapData : [swapData];
    if (transactions.length === 0) {
        throw new ButterApiError('Butter /swap returned no transaction data');
    }
    // A single EVM Router execution is exactly one swapAndBridge/swapAndCall call.
    // Executing multiple individually-valid Router txs would multiply native/ERC-20
    // spend while only the first hash and one quote are returned, so reject them.
    // (The adapter path may legitimately return multiple txs, e.g. BTC.)
    //
    // Butter documents `/swap` as returning "one or more" transactions, so this is a
    // deliberate narrowing rather than a contract violation on their side. Describe
    // each transaction in the error: if this ever fires, whether it is "one Router
    // call plus an approval" or "two Router calls" decides what to do about it, and
    // a bare count answers neither.
    if (context.requireRouterAllowlist && transactions.length > 1) {
        throw new ButterTransactionValidationError('Butter /swap returned multiple transactions for a single EVM Router execution', { count: transactions.length, transactions: transactions.map(describeSwapTransaction) });
    }
    return transactions.map((tx) => validateSwapTransaction(tx, context));
}
/**
 * Validates the calldata's source amount and returns what is actually being spent.
 *
 * Exact-in: the caller named the input, so the calldata must match it **exactly**.
 *
 * Exact-out: the caller named the *output*, so the required input is not knowable
 * up front and can only be bounded. It is bounded by `maxAmountIn`, which comes
 * from the caller — deliberately not by `route.srcChain.totalAmountIn`, which is
 * Butter-reported and would let the response validate itself. This is the one
 * place the source-amount check is an inequality, and it must stay confined to the
 * exact-out branch.
 */
function assertSourceAmountIn(amount, context) {
    if (context.maxAmountIn != null) {
        if (amount > context.maxAmountIn) {
            throw new ButterTransactionValidationError('Butter Router source amount exceeds maxFromTokenAmount', {
                maxFromTokenAmount: context.maxAmountIn.toString(),
                actual: amount.toString()
            });
        }
        return amount;
    }
    if (context.requestedAmountIn == null) {
        throw new ButterTransactionValidationError('Butter /swap cannot be validated without the quoted input amount');
    }
    if (amount !== context.requestedAmountIn) {
        throw new ButterTransactionValidationError('Butter Router source amount does not match quote', {
            expected: context.requestedAmountIn.toString(),
            actual: amount.toString()
        });
    }
    return amount;
}
/**
 * Summarizes an unvalidated `/swap` entry for an error report.
 *
 * Runs on untrusted input that has failed no check yet, so every field is read
 * defensively — this must never throw and mask the error it is describing.
 */
function describeSwapTransaction(value, index) {
    if (value == null || typeof value !== 'object')
        return { index, shape: typeof value };
    const tx = value;
    return {
        index,
        to: typeof tx.to === 'string' ? tx.to : undefined,
        chainId: typeof tx.chainId === 'string' || typeof tx.chainId === 'number' ? String(tx.chainId) : undefined,
        value: typeof tx.value === 'string' || typeof tx.value === 'number' ? String(tx.value) : undefined,
        // `undefined` here means "not a recognized Router call" — an ERC-20 approve,
        // for instance, which is exactly the distinction worth surfacing.
        method: typeof tx.data === 'string' ? routerFunctionName(tx.data) : undefined
    };
}
export function validateSwapTransaction(value, context) {
    if (!value || typeof value !== 'object') {
        throw new ButterApiError('Butter /swap returned invalid transaction data', value);
    }
    const tx = value;
    if (!tx.to || tx.value == null || tx.chainId == null) {
        throw new ButterApiError('Butter /swap transaction is missing required fields', value);
    }
    if (String(tx.chainId) !== context.sourceChainId) {
        throw new ButterTransactionValidationError('Butter /swap transaction chain does not match source chain', value);
    }
    if (context.requireRouterAllowlist) {
        validateEvmRouterTransaction(tx, context);
    }
    return {
        to: tx.to,
        value: tx.value,
        chainId: tx.chainId,
        data: tx.data,
        method: tx.method,
        args: tx.args,
        memo: tx.memo
    };
}
function validateEvmRouterTransaction(tx, context) {
    const deployment = assertRouterAllowed(tx.to, context.sourceChainId, context.routerRegistry);
    if (context.route.contract) {
        assertRouterAllowed(context.route.contract, context.sourceChainId, context.routerRegistry);
        assertAddressEqual(tx.to, context.route.contract, 'Butter route contract does not match /swap target');
    }
    if (deployment.version !== 'v3') {
        throw new ButterConfigurationError(`No calldata validator for Butter router ${deployment.version}`);
    }
    if (!tx.data || !isHexData(tx.data)) {
        throw new ButterTransactionValidationError('Butter /swap transaction is missing valid calldata', tx);
    }
    let decoded;
    try {
        decoded = decodeFunctionData({ abi: ROUTER_V3_ABI, data: tx.data });
    }
    catch (cause) {
        throw new ButterTransactionValidationError('Butter /swap returned malformed or unsupported Router V3 calldata', { cause });
    }
    if (decoded.functionName !== 'swapAndCall' && decoded.functionName !== 'swapAndBridge') {
        throw new ButterTransactionValidationError('Butter /swap returned an unsupported Router V3 function');
    }
    if (tx.method != null && tx.method !== decoded.functionName) {
        throw new ButterTransactionValidationError('Butter /swap method metadata does not match calldata', {
            method: tx.method,
            decodedMethod: decoded.functionName
        });
    }
    const args = decoded.args;
    const [, initiator, srcToken, amount, encodedSwap, functionData, permitData, feeData] = args;
    assertAddressEqual(initiator, context.sender, 'Butter Router initiator does not match sender');
    assertTokenEqual(srcToken, context.sourceToken, 'Butter Router source token does not match quote');
    const effectiveAmountIn = assertSourceAmountIn(amount, context);
    if (permitData !== '0x') {
        throw new ButterTransactionValidationError('Butter Router permit data is not supported');
    }
    validateFeeData(feeData, context);
    const sameChain = context.sourceChainId === context.destinationChainId;
    let bridgeNativeFee = 0n;
    if (sameChain) {
        if (decoded.functionName !== 'swapAndCall') {
            throw new ButterTransactionValidationError('Same-chain Butter execution must use swapAndCall');
        }
        if (functionData !== '0x') {
            throw new ButterTransactionValidationError('Butter Router callback data is not supported');
        }
        validateSameChainSwapParam(encodedSwap, context);
    }
    else {
        if (decoded.functionName !== 'swapAndBridge') {
            throw new ButterTransactionValidationError('Cross-chain Butter execution must use swapAndBridge');
        }
        // The bridge param's nativeFee is the bridge messaging fee; it is a distinct
        // value from the router protocol fee (route.swapFee.nativeFee). We read it
        // only for the tx.value check and trust Butter for destination routing,
        // except for an explicitly requested refundAddress.
        bridgeNativeFee = validateBridgeParams(functionData, context);
    }
    let nativeValue;
    try {
        nativeValue = parseIntegerAmount(tx.value);
    }
    catch (cause) {
        throw new ButterTransactionValidationError('Butter /swap returned an invalid native value', { cause });
    }
    // Per Butter Router: msg.value = input(if native) + routerFee.nativeFee + bridgeFee.
    // The input half and the fee half are bounded separately rather than compared as
    // one exact sum: `/route` formats the router fee as a decimal string while
    // `/swap` returns tx.value as a hex integer, so a sub-wei formatting artifact in
    // that round-trip would otherwise reject a perfectly good transaction.
    const routerNativeFee = context.routerNativeFee ?? 0n;
    // Exact-out uses the amount the calldata actually spends (already bounded above
    // by maxFromTokenAmount) rather than the cap itself: a route needing less than
    // the cap is the normal case, and requiring the full cap would reject it.
    const inputPart = context.nativeSource ? effectiveAmountIn : 0n;
    // The input half is a hard lower bound: anything less would under-fund the swap.
    if (nativeValue < inputPart) {
        throw new ButterTransactionValidationError('Butter /swap native value is below the quoted native input', {
            expectedAtLeast: inputPart.toString(),
            actual: nativeValue.toString()
        });
    }
    const nativeFeePart = nativeValue - inputPart;
    // The fee half only needs an upper bound. Paying less than quoted cannot harm the
    // user (the router reverts if it is genuinely insufficient), so there is no lower
    // bound and no need for a two-sided tolerance.
    //
    // The bridge messaging fee comes from the (partially trusted) /swap calldata and
    // is not bounded by the quote, which makes maxNativeFee the actual native-drain
    // guard. Cross-chain therefore fails closed whenever it is unset — including when
    // the calldata reports a zero bridge fee, which must not be able to opt out of
    // the cap by under-reporting what tx.value actually spends.
    if (context.maxNativeFee != null) {
        if (nativeFeePart > context.maxNativeFee) {
            throw new ButterTransactionValidationError('Butter /swap native fee exceeds the configured maxNativeFee', {
                nativeFeePart: nativeFeePart.toString(),
                maxNativeFee: context.maxNativeFee.toString()
            });
        }
    }
    else if (!sameChain) {
        throw new ButterConfigurationError('Butter cross-chain execution requires maxNativeFee to bound the bridge native fee returned by /swap');
    }
    // Consistency with the quote. This is a sanity check, not the security boundary:
    // it catches a /swap that charges materially more native than /route advertised,
    // while tolerating the formatting drift described above.
    const quotedNativeFee = routerNativeFee + bridgeNativeFee;
    const allowedNativeFee = quotedNativeFee + (quotedNativeFee * BigInt(NATIVE_FEE_DRIFT_BPS)) / 10000n;
    if (nativeFeePart > allowedNativeFee) {
        throw new ButterTransactionValidationError('Butter /swap native fee exceeds the quoted router and bridge fees', {
            quotedNativeFee: quotedNativeFee.toString(),
            allowed: allowedNativeFee.toString(),
            actual: nativeFeePart.toString(),
            routerNativeFee: routerNativeFee.toString(),
            bridgeNativeFee: bridgeNativeFee.toString()
        });
    }
}
/**
 * Validates that the calldata `feeData` matches the integrator fee config the
 * route declared. Empty feeData charges no integrator fee: allowed only when the
 * route quoted no fee (zero `rateOrNativeFee`) — otherwise `/swap` would silently
 * drop the quoted integrator fee. A non-empty feeData requires the route to have
 * declared the FULL `(feeType, referrer, rateOrNativeFee)` tuple and must match it
 * exactly. Butter's `/route` defines feeConfig as that one tuple, so an incomplete
 * quoted config cannot be verified and fails closed — otherwise `/swap` could pick
 * an unchecked `feeType` (e.g. flipping a fixed native fee to a proportional rate)
 * or an unchecked `referrer` while only matching the rate.
 */
function validateFeeData(feeData, context) {
    if (feeData === '0x') {
        if (feeConfigChargesFee(context.feeConfig)) {
            throw new ButterTransactionValidationError('Butter /swap dropped the quoted integrator fee: empty feeData for a non-zero feeConfig');
        }
        return;
    }
    let fee;
    try {
        ;
        [fee] = decodeAbiParameters(FEE_PARAM, feeData);
    }
    catch (cause) {
        throw new ButterTransactionValidationError('Butter Router fee data is malformed', { cause });
    }
    const config = context.feeConfig;
    if (!config) {
        throw new ButterTransactionValidationError('Butter /swap included fee data not declared by the route');
    }
    // Non-empty feeData charges a fee, so the quoted tuple must be complete before it
    // can be matched; a missing field is unverifiable and fails closed.
    if (config.feeType == null) {
        throw new ButterTransactionValidationError('Butter route feeConfig is missing feeType; cannot verify /swap fee data', { feeConfig: config });
    }
    if (!config.referrer) {
        throw new ButterTransactionValidationError('Butter route feeConfig is missing referrer; cannot verify /swap fee data', { feeConfig: config });
    }
    if (config.rateOrNativeFee == null) {
        throw new ButterTransactionValidationError('Butter route feeConfig is missing rateOrNativeFee; cannot verify /swap fee data', { feeConfig: config });
    }
    if (Number(fee.feeType) !== Number(config.feeType)) {
        throw new ButterTransactionValidationError('Butter Router fee type does not match the quoted feeConfig', {
            expected: config.feeType, actual: fee.feeType
        });
    }
    assertAddressEqual(fee.referrer, config.referrer, 'Butter Router fee referrer does not match the quoted feeConfig');
    const expectedRate = BigInt(config.rateOrNativeFee);
    if (fee.rateOrNativeFee !== expectedRate) {
        throw new ButterTransactionValidationError('Butter Router fee rate does not match the quoted feeConfig', {
            expected: expectedRate.toString(), actual: fee.rateOrNativeFee.toString()
        });
    }
}
/** True when the route's integrator fee config charges a non-zero fee. */
export function feeConfigChargesFee(config) {
    if (!config)
        return false;
    try {
        return BigInt(config.rateOrNativeFee ?? 0) !== 0n;
    }
    catch {
        // A non-numeric rate is unexpected; treat as charging a fee (fail closed).
        return true;
    }
}
function validateSameChainSwapParam(encoded, context) {
    const swap = decodeSwapParam(encoded);
    assertTokenEqual(swap.dstToken, context.destinationToken, 'Butter Router destination token does not match quote');
    assertAddressEqual(swap.receiver, context.receiver, 'Butter Router receiver does not match requested recipient');
    // A same-chain swap has no bridge payload; `leftReceiver` is where anything left
    // over (or refunded) lands, so it plays the refund-destination role here.
    const expectedLeftoverReceiver = context.refundAddress ?? context.sender;
    assertAddressEqual(swap.leftReceiver, expectedLeftoverReceiver, context.refundAddress != null
        ? 'Butter Router leftover receiver does not match the requested refundAddress'
        : 'Butter Router leftover receiver does not match sender');
    if (context.minimumAmountOut == null || swap.minAmount < context.minimumAmountOut) {
        throw new ButterTransactionValidationError('Butter Router minimum output is below quoted minimum', {
            expectedMinimum: context.minimumAmountOut?.toString(),
            actual: swap.minAmount.toString()
        });
    }
}
/**
 * Validates the outer bridge params and returns the bridge messaging fee for the
 * tx.value check, confirming the bridge targets the quoted destination chain.
 *
 * The nested `bridge.data` (destination swap / adapter) is otherwise
 * intentionally NOT decoded or verified: by policy the module trusts Butter's
 * `/swap` for the cross-chain destination routing (receiver, output token,
 * minimum output). The user is still protected against native-balance drain (the
 * returned nativeFee feeds the quoted side of the tx.value fee bound, and
 * `maxNativeFee` caps that half absolutely) and against an unbounded source spend
 * (the module approves only the exact input amount to the router).
 *
 * The one exception is {@link SwapValidationContext.refundAddress}: a caller who
 * names a refund destination is asking for a guarantee, so that single nested
 * field is decoded and checked instead of assumed.
 */
function validateBridgeParams(encodedBridge, context) {
    let bridge;
    try {
        ;
        [bridge] = decodeAbiParameters(BRIDGE_PARAM, encodedBridge);
    }
    catch (cause) {
        throw new ButterTransactionValidationError('Butter Router bridge parameters are malformed', { cause });
    }
    if (bridge.toChain.toString() !== context.destinationChainId) {
        throw new ButterTransactionValidationError('Butter Router destination chain does not match quote', {
            expected: context.destinationChainId,
            actual: bridge.toChain.toString()
        });
    }
    if (bridge.receiver === '0x') {
        throw new ButterTransactionValidationError('Butter Router bridge receiver is missing');
    }
    if (context.refundAddress != null)
        validateBridgeRefundAddress(bridge.data, context.refundAddress);
    return bridge.nativeFee;
}
/**
 * Verifies that the nested bridge payload encodes the refund destination the
 * caller requested.
 *
 * Fails closed: the caller asked for a specific guarantee, so a payload that
 * cannot be decoded means the guarantee cannot be given — never that it holds.
 * Dropping `refundAddress` opts back into Butter's default, which is trusted like
 * the rest of the destination routing.
 */
function validateBridgeRefundAddress(nestedData, requested) {
    if (nestedData === '0x') {
        throw new ButterUnsupportedError('Butter encoded no bridge payload, so the requested refundAddress cannot be verified; omit refundAddress to accept Butter\'s default refund destination');
    }
    let nested;
    try {
        ;
        [nested] = decodeAbiParameters(BRIDGE_DATA_PARAM, nestedData);
    }
    catch (cause) {
        throw new ButterUnsupportedError('Butter\'s bridge payload does not match the documented (gasLimit, refundAddress, swapData) layout, so the requested refundAddress cannot be verified; omit refundAddress to accept Butter\'s default refund destination', { cause });
    }
    // C5 (deferred): `nested.swapData` also carries the destination minimum output,
    // so this is where cross-chain `toTokenAmountMin` could become an enforced
    // guarantee rather than a route estimate. Left alone deliberately — it tightens
    // the documented trust boundary and needs its own security review.
    if (!refundAddressMatches(nested.refundAddress, requested)) {
        throw new ButterTransactionValidationError('Butter Router refund address does not match the requested refundAddress', {
            expected: requested,
            actual: nested.refundAddress
        });
    }
}
/**
 * Compares an encoded `bytes` refund address against the requested one.
 *
 * Butter carries it as raw `bytes` because the destination chain decides the
 * encoding: an EVM address is the 20 raw bytes, while a non-EVM address
 * (base58 / bech32 / TON) is its UTF-8 text. Both readings are accepted; only a
 * value matching neither is a mismatch.
 */
function refundAddressMatches(encoded, requested) {
    const actual = encoded.toLowerCase();
    if (isAddress(requested, { strict: false }) && actual === normalizeAddress(requested))
        return true;
    return actual === stringToHex(requested).toLowerCase();
}
function decodeSwapParam(encoded) {
    try {
        const [swap] = decodeAbiParameters(SWAP_PARAM, encoded);
        return swap;
    }
    catch (cause) {
        throw new ButterTransactionValidationError('Butter Router swap parameters are malformed', { cause });
    }
}
/**
 * Returns the Router V3 function a transaction's calldata calls, or undefined if
 * it is not decodable / not a recognized Router function. Used to classify a
 * swidge as same-chain (`swapAndCall`) or cross-chain (`swapAndBridge`).
 */
export function routerFunctionName(data) {
    if (!data || !isHexData(data))
        return undefined;
    try {
        const decoded = decodeFunctionData({ abi: ROUTER_V3_ABI, data: data });
        if (decoded.functionName === 'swapAndCall' || decoded.functionName === 'swapAndBridge') {
            return decoded.functionName;
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
export function assertRouterAllowed(address, chainId, registry) {
    const deployments = routerDeploymentsForChain(registry, chainId);
    if (deployments.length === 0) {
        throw new ButterConfigurationError(`No Butter router contracts configured for chain ${chainId}`);
    }
    const deployment = deployments.find(({ address: allowed }) => normalizeAddress(allowed) === normalizeAddress(address));
    if (!deployment) {
        throw new ButterTransactionValidationError('Butter router address is not allowlisted', { chainId, address });
    }
    return deployment;
}
function assertAddressEqual(actual, expected, message) {
    if (!isAddress(actual, { strict: false }) || !isAddress(expected, { strict: false }) || normalizeAddress(actual) !== normalizeAddress(expected)) {
        throw new ButterTransactionValidationError(message, { expected, actual });
    }
}
function assertTokenEqual(actual, expected, message) {
    const actualNormalized = normalizeAddress(actual);
    const expectedNormalized = normalizeAddress(expected);
    const bothNative = NATIVE_TOKEN_ADDRESSES.has(actualNormalized) && NATIVE_TOKEN_ADDRESSES.has(expectedNormalized);
    if (!bothNative && actualNormalized !== expectedNormalized) {
        throw new ButterTransactionValidationError(message, { expected, actual });
    }
}
function isHexData(value) {
    return /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
}
export function normalizeAddress(address) {
    return address.toLowerCase();
}
//# sourceMappingURL=swap-data.js.map