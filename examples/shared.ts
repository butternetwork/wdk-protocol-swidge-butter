import { ButterPartialExecutionError, type ButterSwidgeProtocolConfig } from '@butternetwork/wdk-protocol-swidge-butter'

export type ExampleEnv = Readonly<Record<string, string | undefined>>

export const EXECUTION_CONFIRMATION = 'I_UNDERSTAND_THIS_SENDS_A_REAL_TRANSACTION'

interface ButterRouteRequestOptions {
  env?: ExampleEnv
  fetch?: ButterSwidgeProtocolConfig['fetch']
  timeoutMs?: number
}

export async function requestButterRoute<T> (
  params: Record<string, string>,
  options: ButterRouteRequestOptions = {}
): Promise<T> {
  const env = options.env ?? process.env
  const auth = butterAuthFromEnv(env)
  const url = new URL('/route', envOrDefault('BUTTER_ROUTER_BASE_URL', 'https://bs-router-v3.chainservice.io/', env))
  if (auth.apiSecret && url.protocol !== 'https:') {
    throw new Error('Butter API credentials require HTTPS base URLs')
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const headers: Record<string, string> = {}
  if (auth.apiKeyId) headers['x-api-key-id'] = auth.apiKeyId
  if (auth.apiSecret) headers.Authorization = `Bearer ${auth.apiSecret}`

  const timeoutMs = options.timeoutMs ?? 10000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Butter request timeout must be a positive safe integer')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Butter /route request timed out'))
      controller.abort()
    }, timeoutMs)
  })
  const request = (async (): Promise<T> => {
    const response = await (options.fetch ?? globalThis.fetch)(url.toString(), {
      method: 'GET', headers, signal: controller.signal
    })
    if (!response.ok) {
      controller.abort()
      throw new Error(`Butter /route failed with HTTP ${response.status}`)
    }
    return await response.json() as T
  })()
  try {
    return await Promise.race([request, timeout])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

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
    process.exitCode = 1
    if (error instanceof ButterPartialExecutionError) {
      console.error(JSON.stringify({
        name: error.name,
        message: error.message,
        transactions: error.transactions.map(({ hash, chain, type }) => ({ hash, chain, type })),
        ...(error.failedType != null ? { failedType: error.failedType } : {})
      }, null, 2))
    } else {
      console.error(error instanceof Error ? error.message : error)
    }
  })
}

function optionalEnv (name: string, env: ExampleEnv): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}
