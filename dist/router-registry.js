import { isAddress } from 'viem';
import { DEFAULT_ROUTER_CONTRACTS } from './constants.js';
import { ButterConfigurationError } from './errors.js';
export function createRouterRegistry(overrides) {
    const registry = {};
    for (const [chainId, deployments] of Object.entries(DEFAULT_ROUTER_CONTRACTS)) {
        registry[chainId] = validateDeployments(chainId, deployments);
    }
    for (const [chainId, deployments] of Object.entries(overrides ?? {})) {
        registry[chainId] = validateDeployments(chainId, deployments ?? []);
    }
    return registry;
}
export function routerDeploymentsForChain(registry, chainId) {
    return registry[String(chainId)] ?? [];
}
export function routerAddressesByChain(registry) {
    return Object.fromEntries(Object.entries(registry).map(([chainId, deployments]) => [
        chainId,
        deployments.map(({ address }) => address)
    ]));
}
function validateDeployments(chainId, deployments) {
    if (!/^\d+$/.test(chainId)) {
        throw new ButterConfigurationError(`Invalid Butter router chain ID: ${chainId}`);
    }
    const seen = new Set();
    return deployments.map((deployment) => {
        if (!isAddress(deployment.address, { strict: false })) {
            throw new ButterConfigurationError(`Invalid Butter router address for chain ${chainId}`, deployment);
        }
        assertRouterVersion(deployment.version);
        const normalized = deployment.address.toLowerCase();
        if (seen.has(normalized)) {
            throw new ButterConfigurationError(`Duplicate Butter router address for chain ${chainId}`, deployment);
        }
        seen.add(normalized);
        return { address: deployment.address, version: deployment.version };
    });
}
function assertRouterVersion(version) {
    if (version !== 'v3') {
        throw new ButterConfigurationError(`Unsupported Butter router validator version: ${version}`);
    }
}
//# sourceMappingURL=router-registry.js.map