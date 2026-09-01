import type { ButterRouterDeployment } from './types.js';
export type ButterRouterRegistry = Readonly<Record<string, readonly ButterRouterDeployment[]>>;
/**
 * Builds the effective per-chain Butter Router allowlist from defaults and caller overrides.
 *
 * @param {Partial<Record<number, readonly ButterRouterDeployment[]>>} [overrides] - The per-call or per-chain overrides to apply.
 * @returns {ButterRouterRegistry} The validated Router registry.
 */
export declare function createRouterRegistry(overrides?: Partial<Record<number, readonly ButterRouterDeployment[]>>): ButterRouterRegistry;
/**
 * Returns the allowlisted Router deployments configured for one chain.
 *
 * @param {ButterRouterRegistry} registry - The effective Butter Router allowlist.
 * @param {string | number} chainId - The chain identifier used for normalization or lookup.
 * @returns {readonly ButterRouterDeployment[]} The allowlisted deployments for the chain.
 */
export declare function routerDeploymentsForChain(registry: ButterRouterRegistry, chainId: string | number): readonly ButterRouterDeployment[];
/**
 * Projects the Router registry into a chain-to-address map.
 *
 * @param {ButterRouterRegistry} registry - The effective Butter Router allowlist.
 * @returns {Record<string, string[]>} The allowlisted Router addresses grouped by chain.
 */
export declare function routerAddressesByChain(registry: ButterRouterRegistry): Record<string, string[]>;
//# sourceMappingURL=router-registry.d.ts.map