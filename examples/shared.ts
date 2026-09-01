import type { ButterSwidgeProtocolConfig } from '@butternetwork/wdk-protocol-swidge-butter'

export type ExampleEnv = Readonly<Record<string, string | undefined>>

export const EXECUTION_CONFIRMATION = 'I_UNDERSTAND_THIS_SENDS_A_REAL_TRANSACTION'

export function butterAuthFromEnv (env: ExampleEnv = process.env): Pick<
ButterSwidgeProtocolConfig,
'apiKeyId' | 'apiSecret' | 'authMode'
> {
  const apiKeyId = optionalEnv('BUTTER_API_KEY_ID', env)
  const apiSecret = optionalEnv('BUTTER_API_SECRET', env)
  if (Boolean(apiKeyId) !== Boolean(apiSecret)) {
    throw new Error('BUTTER_API_KEY_ID and BUTTER_API_SECRET must be provided together')
  }
  if (!apiKeyId || !apiSecret) return { authMode: 'optional' }
  return { apiKeyId, apiSecret, authMode: 'required' }
}

export function butterIntegrationFromEnv (env: ExampleEnv = process.env): Pick<
ButterSwidgeProtocolConfig,
'entrance' | 'apiKeyId' | 'apiSecret' | 'authMode'
> {
  const entrance = requireEnv('BUTTER_ENTRANCE', env)
  const apiKeyId = requireEnv('BUTTER_API_KEY_ID', env)
  const apiSecret = requireEnv('BUTTER_API_SECRET', env)
  return { entrance, apiKeyId, apiSecret, authMode: 'required' }
}

export function assertExecutionConfirmed (env: ExampleEnv = process.env): void {
  if (env.CONFIRM_EXECUTION !== EXECUTION_CONFIRMATION) {
    throw new Error(`Set CONFIRM_EXECUTION=${EXECUTION_CONFIRMATION} to send a real transaction`)
  }
}

export function requireEnv (name: string, env: ExampleEnv = process.env): string {
  const value = optionalEnv(name, env)
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function envOrDefault (
  name: string,
  fallback: string,
  env: ExampleEnv = process.env
): string {
  return optionalEnv(name, env) ?? fallback
}

export function positiveBigIntFromEnv (
  name: string,
  env: ExampleEnv = process.env,
  fallback?: bigint
): bigint {
  const raw = optionalEnv(name, env)
  if (raw == null && fallback != null) return fallback
  if (raw == null || !/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    throw new Error(`${name} must be a positive integer in base units`)
  }
  return BigInt(raw)
}

export function numberFromEnv (
  name: string,
  env: ExampleEnv = process.env,
  fallback?: number
): number {
  const raw = optionalEnv(name, env)
  if (raw == null && fallback != null) return fallback
  const value = Number(raw)
  if (raw == null || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`)
  return value
}

export function printJson (value: unknown): void {
  console.log(JSON.stringify(value, (_key, item: unknown) => (
    typeof item === 'bigint' ? item.toString() : item
  ), 2))
}

export function runExample (main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

function optionalEnv (name: string, env: ExampleEnv): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}
