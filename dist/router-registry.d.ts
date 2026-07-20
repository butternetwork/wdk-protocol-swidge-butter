import type { ButterRouterDeployment } from './types.js';
export type ButterRouterRegistry = Readonly<Record<string, readonly ButterRouterDeployment[]>>;
export declare function createRouterRegistry(overrides?: Partial<Record<number, readonly ButterRouterDeployment[]>>): ButterRouterRegistry;
export declare function routerDeploymentsForChain(registry: ButterRouterRegistry, chainId: string | number): readonly ButterRouterDeployment[];
export declare function routerAddressesByChain(registry: ButterRouterRegistry): Record<string, string[]>;
//# sourceMappingURL=router-registry.d.ts.map