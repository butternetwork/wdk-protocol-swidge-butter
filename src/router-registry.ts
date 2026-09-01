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

import { isAddress } from 'viem'
import { DEFAULT_ROUTER_CONTRACTS } from './constants.js'
import { ButterConfigurationError } from './errors.js'
import type { ButterRouterDeployment, ButterRouterVersion } from './types.js'

export type ButterRouterRegistry = Readonly<Record<string, readonly ButterRouterDeployment[]>>

/**
 * Builds the effective per-chain Butter Router allowlist from defaults and caller overrides.
 *
 * @param {Partial<Record<number, readonly ButterRouterDeployment[]>>} [overrides] - The per-call or per-chain overrides to apply.
 * @returns {ButterRouterRegistry} The validated Router registry.
 */
export function createRouterRegistry (
  overrides?: Partial<Record<number, readonly ButterRouterDeployment[]>>
): ButterRouterRegistry {
  const registry: Record<string, readonly ButterRouterDeployment[]> = {}
  for (const [chainId, deployments] of Object.entries(DEFAULT_ROUTER_CONTRACTS)) {
    registry[chainId] = validateDeployments(chainId, deployments)
  }
  for (const [chainId, deployments] of Object.entries(overrides ?? {})) {
    registry[chainId] = validateDeployments(chainId, deployments ?? [])
  }
  return registry
}

/**
 * Returns the allowlisted Router deployments configured for one chain.
 *
 * @param {ButterRouterRegistry} registry - The effective Butter Router allowlist.
 * @param {string | number} chainId - The chain identifier used for normalization or lookup.
 * @returns {readonly ButterRouterDeployment[]} The allowlisted deployments for the chain.
 */
export function routerDeploymentsForChain (
  registry: ButterRouterRegistry,
  chainId: string | number
): readonly ButterRouterDeployment[] {
  return registry[String(chainId)] ?? []
}

/**
 * Projects the Router registry into a chain-to-address map.
 *
 * @param {ButterRouterRegistry} registry - The effective Butter Router allowlist.
 * @returns {Record<string, string[]>} The allowlisted Router addresses grouped by chain.
 */
export function routerAddressesByChain (registry: ButterRouterRegistry): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(registry).map(([chainId, deployments]) => [
      chainId,
      deployments.map(({ address }) => address)
    ])
  )
}

/**
 * Validates deployments against the required contract.
 *
 * @param {string} chainId - The chain identifier used for normalization or lookup.
 * @param {readonly ButterRouterDeployment[]} deployments - The Router deployments configured for the chain.
 * @returns {readonly ButterRouterDeployment[]} The validated immutable deployment list.
 * @throws {ButterConfigurationError} If required provider configuration is missing or invalid.
 */
function validateDeployments (
  chainId: string,
  deployments: readonly ButterRouterDeployment[]
): readonly ButterRouterDeployment[] {
  if (!/^\d+$/.test(chainId)) {
    throw new ButterConfigurationError(`Invalid Butter router chain ID: ${chainId}`)
  }
  const seen = new Set<string>()
  return deployments.map((deployment) => {
    if (!isAddress(deployment.address, { strict: false })) {
      throw new ButterConfigurationError(`Invalid Butter router address for chain ${chainId}`, deployment)
    }
    assertRouterVersion(deployment.version)
    const normalized = deployment.address.toLowerCase()
    if (seen.has(normalized)) {
      throw new ButterConfigurationError(`Duplicate Butter router address for chain ${chainId}`, deployment)
    }
    seen.add(normalized)
    return { address: deployment.address, version: deployment.version }
  })
}

/**
 * Requires a supported Router calldata validator version.
 *
 * @param {string} version - The Router validator version to validate.
 * @returns {void} Returns when the deployment uses the supported `v3` validator.
 * @throws {ButterConfigurationError} If required provider configuration is missing or invalid.
 */
function assertRouterVersion (version: string): asserts version is ButterRouterVersion {
  if (version !== 'v3') {
    throw new ButterConfigurationError(`Unsupported Butter router validator version: ${version}`)
  }
}
