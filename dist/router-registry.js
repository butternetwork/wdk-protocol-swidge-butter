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