import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'

export const FUNDED_EXECUTION_CONFIRMATION = 'I_UNDERSTAND_THIS_SENDS_REAL_FUNDS'

type Environment = Readonly<Record<string, string | undefined>>

export function parseRequiredString (env: Environment, name: string): string {
  const value = env[name]
  if (value == null || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value.trim()
}

export function parsePositiveBigInt (env: Environment, name: string): bigint {
  const value = parseUnsignedInteger(env, name)
  if (value <= 0n) throw new Error(`${name} must be a positive bigint`)
  return value
}

export function parseNonNegativeBigInt (env: Environment, name: string): bigint {
  return parseUnsignedInteger(env, name)
}

export function parseNonNegativeSafeInteger (env: Environment, name: string): number {
  const raw = parseRequiredString(env, name)
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }

  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value
}

export function parseEvmAddress (env: Environment, name: string): string {
  const value = parseRequiredString(env, name)
  if (!isEvmAddress(value)) throw new Error(`${name} must be a valid EVM address`)
  return value
}

function parseUnsignedInteger (env: Environment, name: string): bigint {
  const raw = parseRequiredString(env, name)
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative bigint`)
  return BigInt(raw)
}

function isEvmAddress (value: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(value)
}

export interface FundedExecutionGuard {
  confirmation: string | undefined
  sender: string
  expectedSender: string
  recipient: string
}

export function validateFundedExecution (guard: FundedExecutionGuard): void {
  if (guard.confirmation !== FUNDED_EXECUTION_CONFIRMATION) {
    throw new Error(`Funded execution requires confirmation ${FUNDED_EXECUTION_CONFIRMATION}`)
  }
  if (!isEvmAddress(guard.sender)) throw new Error('sender must be a valid EVM address')
  if (!isEvmAddress(guard.expectedSender)) throw new Error('expected sender must be a valid EVM address')
  if (guard.sender.toLowerCase() !== guard.expectedSender.toLowerCase()) {
    throw new Error('sender does not match the configured expected sender')
  }
  if (!isEvmAddress(guard.recipient)) throw new Error('recipient must be a valid EVM address')
  if (guard.recipient.toLowerCase() === guard.sender.toLowerCase()) {
    throw new Error('recipient must differ from sender')
  }
}

export class ReadOnlySendBlockedError extends Error {
  constructor () {
    super('E2E read-only sender blocked transaction broadcast')
    this.name = 'ReadOnlySendBlockedError'
  }
}

export function createEphemeralEvmAddress (): string {
  return privateKeyToAddress(generatePrivateKey())
}

export class NoBroadcastSender {
  readonly account: { address: string }
  readonly attempts: unknown[] = []

  constructor (address: string) {
    if (!isEvmAddress(address)) throw new Error('read-only sender must be a valid EVM address')
    this.account = { address }
  }

  async sendTransaction (transaction: unknown): Promise<never> {
    this.attempts.push(transaction)
    throw new ReadOnlySendBlockedError()
  }
}

export function assertReadOnlySendBlocked (
  cause: unknown,
  sender: NoBroadcastSender,
  wdkAccountSendCalls: number
): void {
  if (!(cause instanceof ReadOnlySendBlockedError)) {
    throw new Error('Read-only E2E did not stop at the transaction send boundary', { cause })
  }
  if (sender.attempts.length !== 1) {
    throw new Error(`Read-only E2E expected one send attempt, received ${sender.attempts.length}`)
  }
  if (wdkAccountSendCalls !== 0) {
    throw new Error('Read-only E2E unexpectedly called the WDK account sender')
  }
}

export interface ExecutionBudget {
  input: bigint
  maxInput: bigint
  maxNativeFee: bigint
  maxNetworkFeeBps: bigint
  maxProtocolFeeBps: bigint
  maxTotalGasFee: bigint
  chainId: number
}

export function assertExecutionBudget (budget: ExecutionBudget): void {
  assertPositiveBigInt(budget.input, 'input')
  assertPositiveBigInt(budget.maxInput, 'maxInput')
  if (budget.input > budget.maxInput) throw new Error('input exceeds maxInput')

  assertNonNegativeBigInt(budget.maxNativeFee, 'maxNativeFee')
  assertNonNegativeBigInt(budget.maxNetworkFeeBps, 'maxNetworkFeeBps')
  assertNonNegativeBigInt(budget.maxProtocolFeeBps, 'maxProtocolFeeBps')
  assertNonNegativeBigInt(budget.maxTotalGasFee, 'maxTotalGasFee')

  if (!Number.isSafeInteger(budget.chainId) || budget.chainId <= 0) {
    throw new Error('chainId must be a positive safe integer')
  }
}

function assertPositiveBigInt (value: bigint, name: string): void {
  if (typeof value !== 'bigint' || value <= 0n) throw new Error(`${name} must be a positive bigint`)
}

function assertNonNegativeBigInt (value: bigint, name: string): void {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`${name} must be a non-negative bigint`)
}

export interface PreparedTransaction {
  gas: bigint
  feePerGas: bigint
  value: bigint
}

export interface GuardedTransactionSenderOptions<TTransaction extends PreparedTransaction> {
  maxTotalGasFee: bigint
  maxValue: bigint
  send: (transaction: TTransaction) => Promise<string>
}

export class GuardedTransactionSender<TTransaction extends PreparedTransaction = PreparedTransaction> {
  private readonly maxTotalGasFee: bigint
  private readonly maxValue: bigint
  private readonly realSender: (transaction: TTransaction) => Promise<string>
  private committedGasFee = 0n

  constructor (options: GuardedTransactionSenderOptions<TTransaction>) {
    assertNonNegativeBigInt(options.maxTotalGasFee, 'maxTotalGasFee')
    assertNonNegativeBigInt(options.maxValue, 'maxValue')
    this.maxTotalGasFee = options.maxTotalGasFee
    this.maxValue = options.maxValue
    this.realSender = options.send
  }

  get committedMaximumGasFee (): bigint {
    return this.committedGasFee
  }

  async send (transaction: TTransaction): Promise<string> {
    assertNonNegativeBigInt(transaction.gas, 'gas')
    assertNonNegativeBigInt(transaction.feePerGas, 'feePerGas')
    assertNonNegativeBigInt(transaction.value, 'value')

    const transactionGasFee = transaction.gas * transaction.feePerGas
    if (this.committedGasFee + transactionGasFee > this.maxTotalGasFee) {
      throw new Error('Transaction would exceed the cumulative gas budget')
    }
    if (transaction.value > this.maxValue) {
      throw new Error('Transaction value exceeds the scenario value limit')
    }

    this.committedGasFee += transactionGasFee
    return await this.realSender(transaction)
  }
}

export interface GuardableViemWalletClient {
  account?: { address: string } | null
  prepareTransactionRequest: (transaction: unknown) => Promise<unknown>
  sendTransaction: (transaction: unknown) => Promise<string>
}

export function createGuardedEvmWalletClient (
  client: GuardableViemWalletClient,
  budget: { maxTotalGasFee: bigint, maxValue: bigint }
): { account: { address: string }, sendTransaction: (transaction: unknown) => Promise<string> } {
  const address = client.account?.address
  if (!address || !isEvmAddress(address)) {
    throw new Error('Guarded EVM wallet client requires a bound EVM account')
  }

  type GuardedPreparedTransaction = PreparedTransaction & { request: unknown }
  const guarded = new GuardedTransactionSender<GuardedPreparedTransaction>({
    ...budget,
    send: async ({ request }) => await client.sendTransaction(request)
  })

  return {
    account: { address },
    async sendTransaction (transaction: unknown): Promise<string> {
      let request = await client.prepareTransactionRequest(transaction)
      if (shouldReprepareAsLegacy(transaction, request)) {
        request = await client.prepareTransactionRequest({ ...transaction, type: 'legacy' })
      }
      if (!isRecord(request)) {
        throw new Error('Prepared transaction must be an object')
      }
      const prepared = request
      const gas = prepared.gas
      const feePerGas = prepared.maxFeePerGas ?? prepared.gasPrice
      const value = prepared.value ?? 0n
      if (typeof gas !== 'bigint' || gas < 0n) {
        throw new Error('Prepared transaction gas must be a non-negative bigint')
      }
      if (typeof feePerGas !== 'bigint' || feePerGas < 0n) {
        throw new Error('Prepared transaction fee per gas must be a non-negative bigint')
      }
      if (typeof value !== 'bigint' || value < 0n) {
        throw new Error('Prepared transaction value must be a non-negative bigint')
      }
      return await guarded.send({ gas, feePerGas, value, request })
    }
  }
}

function shouldReprepareAsLegacy (transaction: unknown, prepared: unknown): transaction is Record<string, unknown> {
  if (!isRecord(transaction) || !isRecord(prepared)) return false
  if (Object.hasOwn(transaction, 'type')) return false
  return prepared.type === 'eip1559' && prepared.maxFeePerGas === 0n
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

type PollingStatus =
  | 'pending'
  | 'action-required'
  | 'refund-pending'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'cancelled'
  | 'expired'
  | 'partial'

interface PollingResult {
  status: PollingStatus
}

export interface PollSwidgeStatusOptions<TResult extends PollingResult> {
  query: () => Promise<TResult>
  retryOnError?: (cause: unknown) => boolean
  intervalMs: number
  timeoutMs: number
  now?: () => number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

const CONTINUING_STATUSES = new Set<PollingStatus>([
  'pending',
  'action-required',
  'refund-pending'
])

const FAILED_STATUSES = new Set<PollingStatus>([
  'failed',
  'refunded',
  'cancelled',
  'expired',
  'partial'
])

const QUERY_TIMED_OUT = Symbol('query timed out')
const NEVER = new Promise<never>(() => {})

export function isButterStatusIndexingDelay (cause: unknown): boolean {
  if (!(cause instanceof Error) || cause.name !== 'ButterApiError') return false
  const details = (cause as Error & { details?: unknown }).details
  if (!isRecord(details) || !isRecord(details.data)) return false
  return Object.hasOwn(details.data, 'info') && details.data.info === null
}

export async function pollSwidgeStatus<TResult extends PollingResult> (
  options: PollSwidgeStatusOptions<TResult>
): Promise<TResult> {
  assertPollingDuration(options.intervalMs, 'intervalMs', false)
  assertPollingDuration(options.timeoutMs, 'timeoutMs', true)

  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const startedAt = now()

  while (true) {
    const remaining = options.timeoutMs - (now() - startedAt)
    if (remaining <= 0) throw new Error('Swidge status polling timed out')

    const controller = new AbortController()
    const query = options.query().then(
      (result) => {
        controller.abort()
        return result
      },
      (cause: unknown) => {
        controller.abort()
        throw cause
      }
    )
    const queryTimeout = waitForQueryTimeout(remaining, sleep, controller.signal)
    let outcome: TResult | typeof QUERY_TIMED_OUT
    try {
      outcome = await Promise.race([query, queryTimeout])
    } catch (cause) {
      controller.abort()
      if (options.retryOnError?.(cause) !== true) throw cause
      const elapsed = now() - startedAt
      if (elapsed >= options.timeoutMs) throw new Error('Swidge status polling timed out')
      await sleep(Math.min(options.intervalMs, options.timeoutMs - elapsed))
      continue
    }
    controller.abort()

    if (outcome === QUERY_TIMED_OUT || now() - startedAt >= options.timeoutMs) {
      throw new Error('Swidge status polling timed out')
    }

    const result = outcome
    if (result.status === 'completed') return result
    if (FAILED_STATUSES.has(result.status)) {
      throw new Error(`Swidge reached terminal status: ${result.status}`)
    }
    if (!CONTINUING_STATUSES.has(result.status)) {
      throw new Error(`Swidge returned unsupported status: ${String(result.status)}`)
    }

    const elapsed = now() - startedAt
    if (elapsed >= options.timeoutMs) throw new Error('Swidge status polling timed out')
    await sleep(Math.min(options.intervalMs, options.timeoutMs - elapsed))
  }
}

async function waitForQueryTimeout (
  milliseconds: number,
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  signal: AbortSignal
): Promise<typeof QUERY_TIMED_OUT> {
  await Promise.resolve()
  if (signal.aborted) return await NEVER
  await sleep(milliseconds, signal)
  if (signal.aborted) return await NEVER
  return QUERY_TIMED_OUT
}

function assertPollingDuration (value: number, name: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`)
  }
}

async function defaultSleep (milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }

    const timer = setTimeout(finish, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })

    function abort (): void {
      clearTimeout(timer)
      finish()
    }

    function finish (): void {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
  })
}

interface PartialTransaction {
  hash?: unknown
  type?: unknown
}

export function extractRecoverableSourceId (cause: unknown): string {
  const transactions = transactionsFrom(cause)
  const source = transactions.find((transaction) => transaction.type === 'source')
  if (source != null && typeof source.hash === 'string' && source.hash.trim() !== '') {
    return source.hash
  }
  if (transactions.some((transaction) => transaction.type === 'approval')) {
    throw new Error('Partial execution broadcast approval transaction(s) but no source transaction; do not retry swidge')
  }
  throw new Error('Partial execution contains no recoverable source transaction')
}

function transactionsFrom (cause: unknown): PartialTransaction[] {
  if (typeof cause !== 'object' || cause == null || !('transactions' in cause)) {
    throw new Error('Partial execution does not contain a transactions list')
  }
  const transactions = cause.transactions
  if (!Array.isArray(transactions)) {
    throw new Error('Partial execution does not contain a transactions list')
  }
  return transactions.filter((transaction): transaction is PartialTransaction => (
    typeof transaction === 'object' && transaction != null
  ))
}

const SENSITIVE_RESULT_KEY = /(private[^a-z0-9]*key|api[^a-z0-9]*secret|api[^a-z0-9]*key(?![a-z0-9])|authorization)/i

export function serializeE2eResult (value: unknown): string {
  return JSON.stringify(value, (key, nestedValue: unknown) => {
    if (SENSITIVE_RESULT_KEY.test(key)) return undefined
    if (nestedValue instanceof Error) {
      return { name: nestedValue.name, message: nestedValue.message }
    }
    return typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue
  }, 2)
}

export async function writeE2eResult (
  directory: string,
  fileName: string,
  value: unknown
): Promise<string> {
  if (directory.trim() === '') throw new Error('An explicit result directory is required')
  if (fileName.trim() === '' || basename(fileName) !== fileName) {
    throw new Error('Result file name must not contain a directory')
  }

  await mkdir(directory, { recursive: true })
  const outputPath = join(directory, fileName)
  await writeFile(outputPath, `${serializeE2eResult(value)}\n`, 'utf8')
  return outputPath
}
