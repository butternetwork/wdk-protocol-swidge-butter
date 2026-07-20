import { parseTokenAmount } from './amounts.js';
import { decimalsOf } from './route.js';
export function routeToQuote(route, now, expiry) {
    const sourceDecimals = decimalsOf(route.srcChain?.tokenIn);
    const destinationDecimals = decimalsOf(route.dstChain?.tokenOut ?? route.srcChain?.tokenOut);
    const toTokenAmountMin = parseTokenAmount(route.minAmountOut?.amount ?? route.amountOutMin, destinationDecimals);
    return {
        fromTokenAmount: parseTokenAmount(route.srcChain?.totalAmountIn ?? route.totalAmountIn, sourceDecimals),
        toTokenAmount: parseTokenAmount(route.dstChain?.totalAmountOut ?? route.srcChain?.totalAmountOut ?? route.totalAmountOut, destinationDecimals),
        toTokenAmountMin,
        fees: routeFees(route),
        estimatedDuration: Number(route.timeEstimated ?? route.estimatedTime ?? 0),
        expiry: expiry ?? now() + 300,
        priceImpact: route.priceImpact == null ? undefined : Number(route.priceImpact)
    };
}
export function routeFees(route) {
    const fees = [];
    const destinationDecimals = decimalsOf(route.dstChain?.tokenOut ?? route.srcChain?.tokenOut);
    if (route.bridgeFee?.amount != null) {
        fees.push({
            type: 'protocol',
            amount: parseTokenAmount(route.bridgeFee.amount, destinationDecimals),
            token: route.bridgeFee.address ?? route.bridgeFee.symbol ?? '',
            symbol: route.bridgeFee.symbol,
            chain: route.bridgeFee.chainId,
            included: true,
            description: 'Butter bridge fee'
        });
    }
    if (route.gasFee?.amount != null) {
        fees.push({
            type: 'network',
            amount: parseTokenAmount(route.gasFee.amount, 18),
            token: route.gasFee.symbol ?? '',
            included: false,
            description: 'Estimated source chain gas fee'
        });
    }
    if (route.swapFee?.nativeFee != null) {
        fees.push({
            type: 'protocol',
            amount: parseTokenAmount(route.swapFee.nativeFee, 18),
            token: route.swapFee.nativeSymbol ?? '',
            included: false,
            description: 'Butter native swap fee'
        });
    }
    if (route.swapFee?.tokenFee != null) {
        fees.push({
            type: 'protocol',
            amount: parseTokenAmount(route.swapFee.tokenFee, destinationDecimals),
            token: route.swapFee.tokenSymbol ?? '',
            included: true,
            description: 'Butter token swap fee'
        });
    }
    return fees;
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