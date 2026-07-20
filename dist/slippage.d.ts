export interface SlippageOptions {
    crossChain?: boolean;
    sourceChainId?: string | number;
    toChainId?: string | number;
    strictChainMinimum?: number;
}
export declare function toButterSlippage(slippage: number | undefined, options?: SlippageOptions): number;
export declare function minimumSlippageBps(options: SlippageOptions): number;
//# sourceMappingURL=slippage.d.ts.map