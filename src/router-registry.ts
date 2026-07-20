import { isAddress } from 'viem'
import { DEFAULT_ROUTER_CONTRACTS } from './constants.js'
import { ButterConfigurationError } from './errors.js'
import type { ButterRouterDeployment, ButterRouterVersion } from './types.js'

export type ButterRouterRegistry = Readonly<Record<string, readonly ButterRouterDeployment[]>>

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

export function routerDeploymentsForChain (
  registry: ButterRouterRegistry,
  chainId: string | number
): readonly ButterRouterDeployment[] {
  return registry[String(chainId)] ?? []
}

export function routerAddressesByChain (registry: ButterRouterRegistry): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(registry).map(([chainId, deployments]) => [
      chainId,
      deployments.map(({ address }) => address)
    ])
  )
}

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

function assertRouterVersion (version: string): asserts version is ButterRouterVersion {
  if (version !== 'v3') {
    throw new ButterConfigurationError(`Unsupported Butter router validator version: ${version}`)
  }
}
