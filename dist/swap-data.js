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
import { decodeAbiParameters, decodeFunctionData, isAddress, parseAbi, parseAbiParameters } from 'viem';
import { NATIVE_TOKEN_ADDRESSES } from './constants.js';
import { parseIntegerAmount } from './amounts.js';
import { ButterApiError, ButterConfigurationError, ButterTransactionValidationError } from './errors.js';
import { routerDeploymentsForChain } from './router-registry.js';
const ROUTER_V3_ABI = parseAbi([
    'function swapAndBridge(bytes32 transferId,address initiator,address srcToken,uint256 amount,bytes swapData,bytes bridgeData,bytes permitData,bytes feeData)',
    'function swapAndCall(bytes32 transferId,address initiator,address srcToken,uint256 amount,bytes swapData,bytes callbackData,bytes permitData,bytes feeData)'
]);
const SWAP_PARAM = parseAbiParameters('(address dstToken,address receiver,address leftReceiver,uint256 minAmount,(uint8 dexType,address callTo,address approveTo,uint256 fromAmount,bytes callData)[] swaps)');
const BRIDGE_PARAM = parseAbiParameters('(uint256 toChain,uint256 nativeFee,bytes receiver,bytes data)');
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
    if (context.requireRouterAllowlist && transactions.length > 1) {
        throw new ButterTransactionValidationError('Butter /swap returned multiple transactions for a single EVM Router execution', { count: transactions.length });
    }
    return transactions.map((tx) => validateSwapTransaction(tx, context));
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
    if (context.requestedAmountIn == null || amount !== context.requestedAmountIn) {
        throw new ButterTransactionValidationError('Butter Router source amount does not match quote', {
            expected: context.requestedAmountIn?.toString(),
            actual: amount.toString()
        });
    }
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
        // only for the tx.value check and trust Butter for destination routing.
        bridgeNativeFee = readBridgeNativeFee(functionData, context);
    }
    let nativeValue;
    try {
        nativeValue = parseIntegerAmount(tx.value);
    }
    catch (cause) {
        throw new ButterTransactionValidationError('Butter /swap returned an invalid native value', { cause });
    }
    // Per Butter Router: msg.value = input(if native) + routerFee.nativeFee + bridgeFee.
    const routerNativeFee = context.routerNativeFee ?? 0n;
    const expectedValue = (context.nativeSource ? (context.requestedAmountIn ?? 0n) : 0n) + routerNativeFee + bridgeNativeFee;
    if (context.requestedAmountIn == null || nativeValue !== expectedValue) {
        throw new ButterTransactionValidationError('Butter /swap native value does not match quoted input plus router and bridge fees', {
            expected: expectedValue.toString(),
            actual: nativeValue.toString(),
            routerNativeFee: routerNativeFee.toString(),
            bridgeNativeFee: bridgeNativeFee.toString()
        });
    }
    // The bridge messaging fee comes from the (partially trusted) /swap calldata
    // and is not bounded by the quote. Cap the total non-input native spend at the
    // configured maxNativeFee, and fail closed cross-chain when no cap is set.
    const nonInputNativeFee = routerNativeFee + bridgeNativeFee;
    if (context.maxNativeFee != null) {
        if (nonInputNativeFee > context.maxNativeFee) {
            throw new ButterTransactionValidationError('Butter /swap native fee exceeds the configured maxNativeFee', {
                nonInputNativeFee: nonInputNativeFee.toString(),
                maxNativeFee: context.maxNativeFee.toString()
            });
        }
    }
    else if (bridgeNativeFee > 0n) {
        throw new ButterConfigurationError('Butter cross-chain execution requires maxNativeFee to bound the bridge native fee returned by /swap');
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
function feeConfigChargesFee(config) {
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
    assertAddressEqual(swap.leftReceiver, context.sender, 'Butter Router leftover receiver does not match sender');
    if (context.minimumAmountOut == null || swap.minAmount < context.minimumAmountOut) {
        throw new ButterTransactionValidationError('Butter Router minimum output is below quoted minimum', {
            expectedMinimum: context.minimumAmountOut?.toString(),
            actual: swap.minAmount.toString()
        });
    }
}
/**
 * Reads the bridge messaging fee from the outer bridge params for the tx.value
 * check, and confirms the bridge targets the quoted destination chain.
 *
 * The nested `bridge.data` (destination swap / adapter) is intentionally NOT
 * decoded or verified: by policy the module trusts Butter's `/swap` for the
 * cross-chain destination routing (receiver, output token, minimum output).
 * The user is still protected against native-balance drain (the returned
 * nativeFee feeds the exact tx.value check) and against an unbounded source
 * spend (the module approves only the exact input amount to the router).
 */
function readBridgeNativeFee(encodedBridge, context) {
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
    return bridge.nativeFee;
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