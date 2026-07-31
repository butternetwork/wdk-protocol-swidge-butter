import assert from 'node:assert/strict'

import ButterSwidgeProtocol, {
  ButterPartialExecutionError,
  toEvmPublicClient,
  type ButterSwidgeOptions
} from '@butternetwork/wdk-protocol-swidge-butter'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  type Address,
  type Hex,
  type PublicClient
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  createGuardedEvmWalletClient,
  extractRecoverableSourceId,
  parseEvmAddress,
  parseNonNegativeBigInt,
  parseNonNegativeSafeInteger,
  parsePositiveBigInt,
  parseRequiredString,
  pollSwidgeStatus,
  validateFundedExecution,
  writeE2eResult
} from './harness.js'

const NATIVE_TOKENS = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
])
const RESULT_DIRECTORY = '.e2e-results'

export type FundedScenario = 'same-native' | 'same-erc20' | 'cross-native'

interface ScenarioConfig {
  scenario: FundedScenario
  prefix: string
  sourceChainId: number
  destinationChainId: number
  sourceRpcUrl: string
  destinationRpcUrl: string
  fromToken: Address
  toToken: Address
  amount: bigint
  maxNativeFee: bigint
  maxTotalGasFee: bigint
  maxNetworkFeeBps: number
  maxProtocolFeeBps: number
  slippage: number
  recipient: Address
  expectedSender: Address
}

export async function runFundedScenario (scenario: FundedScenario): Promise<void> {
  const config = parseFundedScenarioConfig(scenario)
  const privateKey = parsePrivateKey(process.env, 'E2E_PRIVATE_KEY')
  const account = privateKeyToAccount(privateKey)
  validateFundedExecution({
    confirmation: process.env.CONFIRM_EXECUTION,
    sender: account.address,
    expectedSender: config.expectedSender,
    recipient: config.recipient
  })

  const sourceChain = evmChain(config.sourceChainId, config.sourceRpcUrl)
  const destinationChain = evmChain(config.destinationChainId, config.destinationRpcUrl)
  const sourcePublicClient = createPublicClient({ chain: sourceChain, transport: http(config.sourceRpcUrl) })
  const destinationPublicClient = config.destinationChainId === config.sourceChainId &&
    config.destinationRpcUrl === config.sourceRpcUrl
    ? sourcePublicClient
    : createPublicClient({ chain: destinationChain, transport: http(config.destinationRpcUrl) })
  const rawWalletClient = createWalletClient({ account, chain: sourceChain, transport: http(config.sourceRpcUrl) })

  await assertChain(sourcePublicClient, config.sourceChainId, `${config.prefix}_SOURCE_RPC_URL`)
  await assertChain(destinationPublicClient, config.destinationChainId, `${config.prefix}_DESTINATION_RPC_URL`)
  await assertToken(sourcePublicClient, config.fromToken, 'source token')
  await assertToken(destinationPublicClient, config.toToken, 'destination token')

  const inputBalance = await tokenBalance(sourcePublicClient, config.fromToken, account.address)
  assert.ok(inputBalance >= config.amount, 'source token balance is below the configured input amount')
  const sourceNativeBalance = await sourcePublicClient.getBalance({ address: account.address })
  const maximumValue = isNative(config.fromToken)
    ? config.amount + config.maxNativeFee
    : config.maxNativeFee
  assert.ok(
    sourceNativeBalance >= maximumValue + config.maxTotalGasFee,
    'source native balance cannot cover the bounded transaction value and gas budget'
  )

  const guardedWalletClient = createGuardedEvmWalletClient({
    account: { address: account.address },
    prepareTransactionRequest: async (transaction) => await rawWalletClient.prepareTransactionRequest(transaction as never),
    sendTransaction: async (transaction) => await rawWalletClient.sendTransaction(transaction as never)
  }, {
    maxTotalGasFee: config.maxTotalGasFee,
    maxValue: maximumValue
  })
  const wdkAccount = {
    getAddress: async () => account.address,
    sendTransaction: async (): Promise<never> => {
      throw new Error('Funded EVM E2E requires every send to pass through the guarded wallet client')
    },
    getTransactionReceipt: async (hash: string) => await sourcePublicClient.getTransactionReceipt({ hash: hash as Hex })
  }
  const protocol = new ButterSwidgeProtocol(wdkAccount, {
    sourceChainId: config.sourceChainId,
    entrance: parseRequiredString(process.env, 'BUTTER_ENTRANCE'),
    apiKeyId: parseRequiredString(process.env, 'BUTTER_API_KEY_ID'),
    apiSecret: parseRequiredString(process.env, 'BUTTER_API_SECRET'),
    authMode: 'required',
    maxNativeFee: config.maxNativeFee,
    maxNetworkFeeBps: config.maxNetworkFeeBps,
    maxProtocolFeeBps: config.maxProtocolFeeBps,
    evm: {
      publicClient: toEvmPublicClient(sourcePublicClient),
      walletClient: guardedWalletClient
    }
  })
  const options: ButterSwidgeOptions = {
    fromToken: config.fromToken,
    toToken: config.toToken,
    toChain: config.destinationChainId,
    fromTokenAmount: config.amount,
    slippage: config.slippage,
    recipient: config.recipient,
    maxNativeFee: config.maxNativeFee
  }
  const destinationBalanceBefore = await tokenBalance(destinationPublicClient, config.toToken, config.recipient)
  const quote = await protocol.quoteSwidge(options)
  assert.equal(quote.fromTokenAmount, config.amount)
  assert.ok(quote.routeHash.trim().length > 0)
  assert.ok(quote.expiry != null && quote.expiry > Math.floor(Date.now() / 1000))

  let result
  try {
    result = await protocol.swidge({ ...options, routeHash: quote.routeHash })
  } catch (cause) {
    await recordPartialExecution(protocol, cause, config, quote)
    throw cause
  }

  await writeScenarioResult(config.scenario, {
    phase: 'broadcast',
    scenario: scenarioSummary(config),
    sourceHash: result.id,
    quote,
    result
  })
  assert.ok(result.transactions?.some((transaction) => transaction.type === 'source'))
  if (scenario === 'same-erc20') {
    assert.ok(
      result.transactions?.some((transaction) => transaction.type === 'approval'),
      'same-chain ERC20 E2E did not exercise the approval path'
    )
  }

  const status = await pollOperation(protocol, result.id, config)
  const destinationBalanceAfter = await waitForDestinationBalance(
    destinationPublicClient,
    config.toToken,
    config.recipient,
    destinationBalanceBefore,
    quote.toTokenAmountMin
  )
  await writeScenarioResult(config.scenario, {
    phase: 'completed',
    scenario: scenarioSummary(config),
    sourceHash: result.id,
    status,
    quote,
    result,
    destinationBalanceBefore,
    destinationBalanceAfter,
    destinationBalanceDelta: destinationBalanceAfter - destinationBalanceBefore
  })
}

async function recordPartialExecution (
  protocol: ButterSwidgeProtocol,
  cause: unknown,
  config: ScenarioConfig,
  quote: unknown
): Promise<void> {
  if (!(cause instanceof ButterPartialExecutionError)) return
  try {
    let sourceHash: string | undefined
    let recoveryError: unknown
    try {
      sourceHash = extractRecoverableSourceId(cause)
    } catch (error) {
      recoveryError = error
    }
    await writeScenarioResult(config.scenario, {
      phase: 'partial-execution',
      scenario: scenarioSummary(config),
      sourceHash,
      transactions: cause.transactions,
      failedType: cause.failedType,
      quote,
      recoveryError
    })
    if (sourceHash != null) {
      let status: unknown
      let statusError: unknown
      try {
        status = await pollOperation(protocol, sourceHash, config)
      } catch (error) {
        statusError = error
      }
      await writeScenarioResult(config.scenario, {
        phase: 'partial-execution-status',
        scenario: scenarioSummary(config),
        sourceHash,
        transactions: cause.transactions,
        status,
        statusError
      })
    }
  } catch (reportingCause) {
    const message = reportingCause instanceof Error ? reportingCause.message : String(reportingCause)
    console.error(`Failed to record partial E2E execution: ${message}`)
  }
}

async function pollOperation (
  protocol: ButterSwidgeProtocol,
  sourceHash: string,
  config: ScenarioConfig
): Promise<Awaited<ReturnType<ButterSwidgeProtocol['getSwidgeStatus']>>> {
  const crossChain = config.sourceChainId !== config.destinationChainId
  return await pollSwidgeStatus({
    query: async () => await protocol.getSwidgeStatus(sourceHash, {
      fromChain: config.sourceChainId,
      toChain: config.destinationChainId
    }),
    intervalMs: crossChain ? 15_000 : 3_000,
    timeoutMs: crossChain ? 45 * 60_000 : 3 * 60_000
  })
}

async function waitForDestinationBalance (
  client: PublicClient,
  token: Address,
  recipient: Address,
  before: bigint,
  minimumDelta: bigint
): Promise<bigint> {
  const deadline = Date.now() + 2 * 60_000
  while (true) {
    const balance = await tokenBalance(client, token, recipient)
    if (balance - before >= minimumDelta) return balance
    if (Date.now() >= deadline) {
      throw new Error('destination balance did not increase by the quoted minimum')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000))
  }
}

async function assertChain (client: PublicClient, expected: number, name: string): Promise<void> {
  const actual = await client.getChainId()
  if (actual !== expected) throw new Error(`${name} returned chain ${actual}, expected ${expected}`)
}

async function assertToken (client: PublicClient, token: Address, name: string): Promise<void> {
  if (isNative(token)) return
  const code = await client.getBytecode({ address: token })
  if (code == null || code === '0x') throw new Error(`${name} has no contract code`)
}

async function tokenBalance (client: PublicClient, token: Address, owner: Address): Promise<bigint> {
  if (isNative(token)) return await client.getBalance({ address: owner })
  const balance = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner]
  })
  return BigInt(balance)
}

export function parseFundedScenarioConfig (
  scenario: FundedScenario,
  env: NodeJS.ProcessEnv = process.env
): ScenarioConfig {
  const prefix = `E2E_${scenario.replaceAll('-', '_').toUpperCase()}`
  const sourceChainId = positiveSafeInteger(env, `${prefix}_SOURCE_CHAIN_ID`)
  const destinationChainId = positiveSafeInteger(env, `${prefix}_DESTINATION_CHAIN_ID`)
  const fromToken = parseEvmAddress(env, `${prefix}_FROM_TOKEN`) as Address
  const toToken = parseEvmAddress(env, `${prefix}_TO_TOKEN`) as Address
  const amount = parsePositiveBigInt(env, `${prefix}_AMOUNT`)
  const maxInput = parsePositiveBigInt(env, `${prefix}_MAX_INPUT`)
  if (amount > maxInput) throw new Error(`${prefix}_AMOUNT exceeds ${prefix}_MAX_INPUT`)
  const maxNativeFee = parseNonNegativeBigInt(env, `${prefix}_MAX_NATIVE_FEE`)
  const maxTotalGasFee = parsePositiveBigInt(env, `${prefix}_MAX_TOTAL_GAS_FEE`)
  const maxNetworkFeeBps = parseNonNegativeSafeInteger(env, `${prefix}_MAX_NETWORK_FEE_BPS`)
  const maxProtocolFeeBps = parseNonNegativeSafeInteger(env, `${prefix}_MAX_PROTOCOL_FEE_BPS`)
  if (maxNetworkFeeBps > 10_000) throw new Error(`${prefix}_MAX_NETWORK_FEE_BPS must not exceed 10000`)
  if (maxProtocolFeeBps > 10_000) throw new Error(`${prefix}_MAX_PROTOCOL_FEE_BPS must not exceed 10000`)
  const slippageBps = positiveSafeInteger(withDefault(env, `${prefix}_SLIPPAGE_BPS`, '200'), `${prefix}_SLIPPAGE_BPS`)
  if (slippageBps > 10_000) throw new Error(`${prefix}_SLIPPAGE_BPS must not exceed 10000`)

  if (scenario.startsWith('same-') && sourceChainId !== destinationChainId) {
    throw new Error(`${scenario} requires identical source and destination chain ids`)
  }
  if (scenario === 'cross-native' && sourceChainId === destinationChainId) {
    throw new Error('cross-native requires different source and destination chain ids')
  }
  if (scenario.endsWith('native') && !isNative(fromToken)) {
    throw new Error(`${scenario} requires a native source token`)
  }
  if (scenario === 'same-erc20' && isNative(fromToken)) {
    throw new Error('same-erc20 requires an ERC20 source token')
  }

  return {
    scenario,
    prefix,
    sourceChainId,
    destinationChainId,
    sourceRpcUrl: parseRequiredString(env, `${prefix}_SOURCE_RPC_URL`),
    destinationRpcUrl: parseRequiredString(env, `${prefix}_DESTINATION_RPC_URL`),
    fromToken,
    toToken,
    amount,
    maxNativeFee,
    maxTotalGasFee,
    maxNetworkFeeBps,
    maxProtocolFeeBps,
    slippage: slippageBps / 10_000,
    recipient: parseEvmAddress(env, 'E2E_RECIPIENT') as Address,
    expectedSender: parseEvmAddress(env, 'E2E_EXPECTED_SENDER') as Address
  }
}

function positiveSafeInteger (env: NodeJS.ProcessEnv, name: string): number {
  const value = parseNonNegativeSafeInteger(env, name)
  if (value <= 0) throw new Error(`${name} must be a positive safe integer`)
  return value
}

function withDefault (env: NodeJS.ProcessEnv, name: string, fallback: string): NodeJS.ProcessEnv {
  return { ...env, [name]: env[name]?.trim() || fallback }
}

function parsePrivateKey (env: NodeJS.ProcessEnv, name: string): Hex {
  const value = parseRequiredString(env, name)
  if (!/^0x[0-9a-f]{64}$/i.test(value)) throw new Error(`${name} must be a 32-byte hex private key`)
  return value as Hex
}

function evmChain (chainId: number, rpcUrl: string) {
  return defineChain({
    id: chainId,
    name: `E2E Chain ${chainId}`,
    nativeCurrency: { name: 'Native token', symbol: 'NATIVE', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  })
}

function isNative (token: string): boolean {
  return NATIVE_TOKENS.has(token.toLowerCase())
}

async function writeScenarioResult (scenario: FundedScenario, value: unknown): Promise<void> {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  await writeE2eResult(RESULT_DIRECTORY, `${scenario}-${timestamp}.json`, value)
}

function scenarioSummary (config: ScenarioConfig): Record<string, unknown> {
  return {
    name: config.scenario,
    sourceChainId: config.sourceChainId,
    destinationChainId: config.destinationChainId,
    fromToken: config.fromToken,
    toToken: config.toToken,
    amount: config.amount,
    recipient: config.recipient
  }
}
