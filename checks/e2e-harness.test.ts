import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ButterPartialExecutionError } from '../src/index.js'
import {
  FUNDED_EXECUTION_CONFIRMATION,
  GuardedTransactionSender,
  NoBroadcastSender,
  assertReadOnlySendBlocked,
  createEphemeralEvmAddress,
  createGuardedEvmWalletClient,
  assertExecutionBudget,
  extractRecoverableSourceId,
  isButterStatusIndexingDelay,
  parseEvmAddress,
  parseNonNegativeBigInt,
  parseNonNegativeSafeInteger,
  parsePositiveBigInt,
  parseRequiredString,
  pollSwidgeStatus,
  serializeE2eResult,
  validateFundedExecution,
  writeE2eResult
} from '../scripts/e2e/harness.js'
import { parseFundedScenarioConfig } from '../scripts/e2e/funded.js'

const SENDER = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'
const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000'

describe('E2E environment parsing', () => {
  it('parses strict values', () => {
    const env = {
      TEXT: 'value',
      POSITIVE: '1',
      ZERO: '0',
      INTEGER: '42',
      ADDRESS: SENDER
    }

    assert.equal(parseRequiredString(env, 'TEXT'), 'value')
    assert.equal(parsePositiveBigInt(env, 'POSITIVE'), 1n)
    assert.equal(parseNonNegativeBigInt(env, 'ZERO'), 0n)
    assert.equal(parseNonNegativeSafeInteger(env, 'INTEGER'), 42)
    assert.equal(parseEvmAddress(env, 'ADDRESS'), SENDER)
    assert.equal(parseRequiredString({ TEXT: '  value  ' }, 'TEXT'), 'value')
  })

  it('rejects missing and invalid values with the variable name', () => {
    assert.throws(() => parseRequiredString({}, 'E2E_API_KEY'), /E2E_API_KEY/)
    assert.throws(() => parseRequiredString({ E2E_API_KEY: '   ' }, 'E2E_API_KEY'), /E2E_API_KEY/)
    assert.throws(() => parsePositiveBigInt({ E2E_INPUT: '0' }, 'E2E_INPUT'), /E2E_INPUT/)
    assert.throws(() => parsePositiveBigInt({ E2E_INPUT: '1.5' }, 'E2E_INPUT'), /E2E_INPUT/)
    assert.throws(() => parseNonNegativeBigInt({ E2E_FEE: '-1' }, 'E2E_FEE'), /E2E_FEE/)
    assert.throws(() => parseNonNegativeSafeInteger({ E2E_CHAIN_ID: '1.5' }, 'E2E_CHAIN_ID'), /E2E_CHAIN_ID/)
    assert.throws(
      () => parseNonNegativeSafeInteger({ E2E_CHAIN_ID: '9007199254740992' }, 'E2E_CHAIN_ID'),
      /E2E_CHAIN_ID/
    )
    assert.throws(() => parseEvmAddress({ E2E_SENDER: '0x1234' }, 'E2E_SENDER'), /E2E_SENDER/)
  })
})

describe('funded execution guard', () => {
  it('requires the exact confirmation string', () => {
    assert.throws(() => validateFundedExecution({
      confirmation: 'yes',
      sender: SENDER,
      expectedSender: SENDER,
      recipient: RECIPIENT
    }), /I_UNDERSTAND_THIS_SENDS_REAL_FUNDS/)
  })

  it('matches the configured sender case-insensitively', () => {
    assert.doesNotThrow(() => validateFundedExecution({
      confirmation: FUNDED_EXECUTION_CONFIRMATION,
      sender: SENDER.toUpperCase(),
      expectedSender: SENDER,
      recipient: RECIPIENT
    }))

    assert.throws(() => validateFundedExecution({
      confirmation: FUNDED_EXECUTION_CONFIRMATION,
      sender: RECIPIENT,
      expectedSender: SENDER,
      recipient: '0x3333333333333333333333333333333333333333'
    }), /sender/i)
  })

  it('rejects an invalid recipient or one equal to the sender', () => {
    assert.throws(() => validateFundedExecution({
      confirmation: FUNDED_EXECUTION_CONFIRMATION,
      sender: SENDER,
      expectedSender: SENDER,
      recipient: 'invalid'
    }), /recipient/i)

    assert.throws(() => validateFundedExecution({
      confirmation: FUNDED_EXECUTION_CONFIRMATION,
      sender: SENDER,
      expectedSender: SENDER,
      recipient: SENDER.toUpperCase()
    }), /recipient/i)
  })
})

describe('execution budgets', () => {
  const budget = {
    input: 1n,
    maxInput: 2n,
    maxNativeFee: 0n,
    maxNetworkFeeBps: 0n,
    maxProtocolFeeBps: 0n,
    maxTotalGasFee: 10n,
    chainId: 1
  }

  it('accepts a bounded execution budget', () => {
    assert.doesNotThrow(() => assertExecutionBudget(budget))
  })

  it('rejects a zero or excessive input', () => {
    assert.throws(() => assertExecutionBudget({ ...budget, input: 0n }), /input/i)
    assert.throws(() => assertExecutionBudget({ ...budget, input: 3n }), /maxInput/)
  })

  it('rejects negative fee limits and invalid chain ids', () => {
    for (const name of ['maxNativeFee', 'maxNetworkFeeBps', 'maxProtocolFeeBps', 'maxTotalGasFee'] as const) {
      assert.throws(() => assertExecutionBudget({ ...budget, [name]: -1n }), new RegExp(name))
    }
    assert.throws(() => assertExecutionBudget({ ...budget, chainId: 0 }), /chainId/)
    assert.throws(() => assertExecutionBudget({ ...budget, chainId: 1.5 }), /chainId/)
  })
})

describe('guarded transaction sender', () => {
  it('rejects a cumulative gas overrun before calling the real sender', async () => {
    let calls = 0
    const guarded = new GuardedTransactionSender({
      maxTotalGasFee: 20n,
      maxValue: 10n,
      send: async () => {
        calls += 1
        return '0xhash'
      }
    })

    await guarded.send({ gas: 3n, feePerGas: 5n, value: 0n })
    await assert.rejects(guarded.send({ gas: 2n, feePerGas: 5n, value: 0n }), /gas/i)
    assert.equal(calls, 1)
  })

  it('rejects excessive value before calling the real sender', async () => {
    let calls = 0
    const guarded = new GuardedTransactionSender({
      maxTotalGasFee: 100n,
      maxValue: 5n,
      send: async () => {
        calls += 1
        return '0xhash'
      }
    })

    await assert.rejects(guarded.send({ gas: 1n, feePerGas: 1n, value: 6n }), /value/i)
    assert.equal(calls, 0)
  })

  it('calls the real sender once and returns its hash when within budget', async () => {
    let calls = 0
    const guarded = new GuardedTransactionSender({
      maxTotalGasFee: 100n,
      maxValue: 5n,
      send: async (transaction) => {
        calls += 1
        assert.equal(transaction.value, 5n)
        return '0xhash'
      }
    })

    assert.equal(await guarded.send({ gas: 2n, feePerGas: 3n, value: 5n }), '0xhash')
    assert.equal(calls, 1)
    assert.equal(guarded.committedMaximumGasFee, 6n)
  })
})

describe('guarded viem wallet client', () => {
  it('prepares and sends an EIP-1559 transaction within budget', async () => {
    const sent: unknown[] = []
    const client = createGuardedEvmWalletClient({
      account: { address: SENDER },
      prepareTransactionRequest: async (transaction) => ({
        ...(transaction as object),
        gas: 2n,
        maxFeePerGas: 3n,
        value: 4n
      }),
      sendTransaction: async (transaction) => {
        sent.push(transaction)
        return '0xhash'
      }
    }, { maxTotalGasFee: 6n, maxValue: 4n })

    assert.equal(await client.sendTransaction({ to: RECIPIENT }), '0xhash')
    assert.equal(sent.length, 1)
  })

  it('re-prepares an automatically selected zero-price EIP-1559 transaction as legacy', async () => {
    const preparations: unknown[] = []
    const sent: unknown[] = []
    const legacyRequest = {
      to: RECIPIENT,
      type: 'legacy',
      gas: 2n,
      gasPrice: 3n,
      value: 4n
    }
    const client = createGuardedEvmWalletClient({
      account: { address: SENDER },
      prepareTransactionRequest: async (transaction) => {
        preparations.push(transaction)
        if (preparations.length === 1) {
          return {
            ...(transaction as object),
            type: 'eip1559',
            gas: 2n,
            maxFeePerGas: 0n,
            maxPriorityFeePerGas: 0n,
            value: 4n
          }
        }
        return legacyRequest
      },
      sendTransaction: async (transaction) => {
        sent.push(transaction)
        return '0xhash'
      }
    }, { maxTotalGasFee: 6n, maxValue: 4n })

    assert.equal(await client.sendTransaction({ to: RECIPIENT }), '0xhash')
    assert.deepEqual(preparations, [
      { to: RECIPIENT },
      { to: RECIPIENT, type: 'legacy' }
    ])
    assert.deepEqual(sent, [legacyRequest])
  })

  it('preserves an explicitly requested zero-price EIP-1559 transaction', async () => {
    const preparations: unknown[] = []
    const sent: unknown[] = []
    const client = createGuardedEvmWalletClient({
      account: { address: SENDER },
      prepareTransactionRequest: async (transaction) => {
        preparations.push(transaction)
        return {
          ...(transaction as object),
          gas: 2n,
          maxFeePerGas: 0n,
          maxPriorityFeePerGas: 0n,
          value: 0n
        }
      },
      sendTransaction: async (transaction) => {
        sent.push(transaction)
        return '0xhash'
      }
    }, { maxTotalGasFee: 0n, maxValue: 0n })
    const transaction = { to: RECIPIENT, type: 'eip1559' }

    assert.equal(await client.sendTransaction(transaction), '0xhash')
    assert.deepEqual(preparations, [transaction])
    assert.equal(sent.length, 1)
  })

  it('uses legacy gasPrice and rejects over budget before signing', async () => {
    let sends = 0
    const client = createGuardedEvmWalletClient({
      account: { address: SENDER },
      prepareTransactionRequest: async () => ({ gas: 3n, gasPrice: 4n, value: 0n }),
      sendTransaction: async () => {
        sends += 1
        return '0xhash'
      }
    }, { maxTotalGasFee: 11n, maxValue: 0n })

    await assert.rejects(client.sendTransaction({ to: RECIPIENT }), /gas budget/i)
    assert.equal(sends, 0)
  })

  it('rejects an unpriced prepared transaction before signing', async () => {
    let sends = 0
    const client = createGuardedEvmWalletClient({
      account: { address: SENDER },
      prepareTransactionRequest: async () => ({ gas: 3n, value: 0n }),
      sendTransaction: async () => {
        sends += 1
        return '0xhash'
      }
    }, { maxTotalGasFee: 100n, maxValue: 0n })

    await assert.rejects(client.sendTransaction({ to: RECIPIENT }), /fee per gas/i)
    assert.equal(sends, 0)
  })
})

describe('read-only transaction boundary', () => {
  it('generates a fresh valid EVM address for each read-only run', () => {
    const first = createEphemeralEvmAddress()
    const second = createEphemeralEvmAddress()

    assert.match(first, /^0x[0-9a-f]{40}$/i)
    assert.match(second, /^0x[0-9a-f]{40}$/i)
    assert.notEqual(first, second)
  })

  it('records exactly one attempted transaction and proves no broadcast occurred', async () => {
    const sender = new NoBroadcastSender(SENDER)
    const transaction = { to: RECIPIENT, value: 1n, data: '0x1234', chainId: 1 }

    let cause: unknown
    try {
      await sender.sendTransaction(transaction)
    } catch (error) {
      cause = error
    }

    assertReadOnlySendBlocked(cause, sender, 0)
    assert.deepEqual(sender.attempts, [transaction])
  })

  it('rejects the proof when the WDK account sender was called', async () => {
    const sender = new NoBroadcastSender(SENDER)

    let cause: unknown
    try {
      await sender.sendTransaction({ to: RECIPIENT })
    } catch (error) {
      cause = error
    }

    assert.throws(() => assertReadOnlySendBlocked(cause, sender, 1), /WDK account/i)
  })
})

describe('status polling', () => {
  it('recognizes only explicit Butter info-null indexing delays', () => {
    const indexingDelay = Object.assign(new Error('missing state'), {
      name: 'ButterApiError',
      details: { id: '0xsource', data: { info: null } }
    })
    const missingInfo = Object.assign(new Error('missing state'), {
      name: 'ButterApiError',
      details: { id: '0xsource', data: {} }
    })
    const malformedInfo = Object.assign(new Error('missing state'), {
      name: 'ButterApiError',
      details: { id: '0xsource', data: { info: {} } }
    })
    const unrelated = Object.assign(new Error('network unavailable'), {
      details: { id: '0xsource', data: { info: null } }
    })

    assert.equal(isButterStatusIndexingDelay(indexingDelay), true)
    assert.equal(isButterStatusIndexingDelay(missingInfo), false)
    assert.equal(isButterStatusIndexingDelay(malformedInfo), false)
    assert.equal(isButterStatusIndexingDelay(unrelated), false)
    assert.equal(isButterStatusIndexingDelay({ name: 'ButterApiError', details: { data: { info: null } } }), false)
  })

  it('polls non-terminal statuses until completion', async () => {
    const statuses = ['pending', 'action-required', 'refund-pending', 'completed'] as const
    let currentTime = 0
    let queries = 0

    const result = await pollSwidgeStatus({
      query: async () => ({ status: statuses[queries++]! }),
      intervalMs: 10,
      timeoutMs: 100,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds }
    })

    assert.equal(result.status, 'completed')
    assert.equal(queries, 4)
  })

  it('retries selected query errors until completion', async () => {
    const indexingDelay = new Error('status is not indexed yet')
    let currentTime = 0
    let queries = 0

    const result = await pollSwidgeStatus({
      query: async () => {
        queries += 1
        if (queries === 1) throw indexingDelay
        if (queries === 2) return { status: 'pending' as const }
        return { status: 'completed' as const }
      },
      retryOnError: (cause) => cause === indexingDelay,
      intervalMs: 10,
      timeoutMs: 100,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds }
    })

    assert.equal(result.status, 'completed')
    assert.equal(queries, 3)
    assert.equal(currentTime, 20)
  })

  it('propagates query errors that are not selected for retry', async () => {
    const infrastructureError = new Error('status API unavailable')
    let sleeps = 0

    await assert.rejects(pollSwidgeStatus({
      query: async () => { throw infrastructureError },
      retryOnError: () => false,
      intervalMs: 10,
      timeoutMs: 100,
      now: () => 0,
      sleep: async () => { sleeps += 1 }
    }), (cause: unknown) => cause === infrastructureError)

    assert.equal(sleeps, 0)
  })

  it('bounds repeated retryable query errors by the polling timeout', async () => {
    const indexingDelay = new Error('status is not indexed yet')
    let currentTime = 0
    let queries = 0

    await assert.rejects(pollSwidgeStatus({
      query: async () => {
        queries += 1
        throw indexingDelay
      },
      retryOnError: (cause) => cause === indexingDelay,
      intervalMs: 10,
      timeoutMs: 20,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds }
    }), /timed out/i)

    assert.equal(queries, 2)
    assert.equal(currentTime, 20)
  })

  it('throws immediately for terminal failure statuses', async () => {
    for (const status of ['failed', 'refunded', 'cancelled', 'expired', 'partial'] as const) {
      let sleeps = 0
      await assert.rejects(pollSwidgeStatus({
        query: async () => ({ status }),
        intervalMs: 10,
        timeoutMs: 100,
        now: () => 0,
        sleep: async () => { sleeps += 1 }
      }), new RegExp(status))
      assert.equal(sleeps, 0)
    }
  })

  it('throws on timeout without real sleeping', async () => {
    let currentTime = 0
    await assert.rejects(pollSwidgeStatus({
      query: async () => ({ status: 'pending' as const }),
      intervalMs: 10,
      timeoutMs: 20,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds }
    }), /timed out/i)
  })

  it('times out a query that never resolves without real sleeping', async () => {
    let currentTime = 0
    const polling = pollSwidgeStatus({
      query: async () => await new Promise<never>(() => {}),
      intervalMs: 10,
      timeoutMs: 20,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds }
    })

    const outcome = await Promise.race([
      polling.then(() => 'unexpected completion', (error: unknown) => error),
      new Promise<string>((resolve) => setImmediate(() => resolve('query remained unbounded')))
    ])

    assert.ok(outcome instanceof Error, String(outcome))
    assert.match(outcome.message, /timed out/i)
  })

  it('times out when a query returns completed after the deadline', async () => {
    let currentTime = 0

    await assert.rejects(pollSwidgeStatus({
      query: async () => {
        currentTime = 21
        return { status: 'completed' as const }
      },
      intervalMs: 10,
      timeoutMs: 20,
      now: () => currentTime,
      sleep: async () => { assert.fail('an immediately completed query must not sleep') }
    }), /timed out/i)
  })
})

describe('partial execution recovery', () => {
  it('extracts the source transaction id without retrying execution', () => {
    const error = new ButterPartialExecutionError([
      { hash: '0xapproval', chain: 1, type: 'approval' },
      { hash: '0xsource', chain: 1, type: 'source' }
    ], new Error('destination failed'), 'destination')

    assert.equal(extractRecoverableSourceId(error), '0xsource')
  })

  it('refuses to retry an approval-only partial execution', () => {
    assert.throws(() => extractRecoverableSourceId({
      transactions: [{ hash: '0xapproval', chain: 1, type: 'approval' }]
    }), /approval.*no source.*do not retry/i)
  })
})

describe('E2E result serialization', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, {
      recursive: true,
      force: true
    })))
  })

  it('serializes bigints and recursively removes sensitive fields', () => {
    const json = serializeE2eResult({
      amount: 123n,
      privateKey: 'secret-1',
      apiKey: 'secret-4',
      nested: {
        BUTTER_API_SECRET: 'secret-2',
        requestAuthorization: 'secret-3',
        BUTTER_API_KEY: 'secret-5',
        'x-api-key-id': 'secret-6',
        safe: 'visible',
        key: 'visible-key',
        monkey: 'visible-monkey',
        apiKeyboard: 'visible-api-keyboard'
      }
    })

    assert.deepEqual(JSON.parse(json), {
      amount: '123',
      nested: {
        safe: 'visible',
        key: 'visible-key',
        monkey: 'visible-monkey',
        apiKeyboard: 'visible-api-keyboard'
      }
    })
    assert.doesNotMatch(json, /secret-[1-6]/)
  })

  it('preserves actionable error details without serializing a stack', () => {
    const json = serializeE2eResult({ error: new Error('do not retry swidge') })

    assert.deepEqual(JSON.parse(json), {
      error: { name: 'Error', message: 'do not retry swidge' }
    })
    assert.doesNotMatch(json, /at .*e2e/i)
  })

  it('writes only to the explicitly supplied directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'butter-e2e-result-'))
    temporaryDirectories.push(directory)

    const outputPath = await writeE2eResult(directory, 'result.json', { amount: 1n })

    assert.equal(outputPath, join(directory, 'result.json'))
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), { amount: '1' })
  })
})

describe('E2E command and CI safety', () => {
  it('uses a viable default amount without relaxing the protocol fee cap', async () => {
    const runner = await readFile(join(process.cwd(), 'scripts/e2e/read-only.test.ts'), 'utf8')
    const example = await readFile(join(process.cwd(), '.env.e2e.example'), 'utf8')

    assert.match(runner, /withDefault\('E2E_READ_AMOUNT', '10000000000000000'\)/)
    assert.match(example, /^E2E_READ_AMOUNT=10000000000000000$/m)
    assert.match(runner, /withDefault\('E2E_READ_MAX_PROTOCOL_FEE_BPS', '1000'\)/)
    assert.match(example, /^E2E_READ_MAX_PROTOCOL_FEE_BPS=1000$/m)
  })

  it('keeps the pull-request workflow read-only and secret-free', async () => {
    const workflow = await readFile(join(process.cwd(), '.github/workflows/e2e.yml'), 'utf8')

    assert.match(workflow, /pull_request:/)
    assert.doesNotMatch(workflow, /pull_request_target/)
    assert.match(workflow, /vars\.BUTTER_E2E_ENTRANCE/)
    assert.doesNotMatch(workflow, /secrets\./)
    assert.doesNotMatch(workflow, /PRIVATE_KEY/)
  })

  it('keeps the read-only runner anonymous when funded credentials share its env file', async () => {
    const runner = await readFile(join(process.cwd(), 'scripts/e2e/read-only.test.ts'), 'utf8')

    assert.doesNotMatch(runner, /BUTTER_API_KEY_ID|BUTTER_API_SECRET/)
    assert.match(runner, /authMode:\s*'optional'/)
  })

  it('provides no aggregate command that could run every funded scenario', async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }

    assert.equal(packageJson.scripts?.['test:e2e'], undefined)
    assert.match(packageJson.scripts?.['test:e2e:read-only'] ?? '', /read-only\.test\.ts/)
    assert.match(packageJson.scripts?.['test:e2e:same-native'] ?? '', /same-native\.test\.ts/)
    assert.match(packageJson.scripts?.['test:e2e:same-erc20'] ?? '', /same-erc20\.test\.ts/)
    assert.match(packageJson.scripts?.['test:e2e:cross-native'] ?? '', /cross-native\.test\.ts/)
  })
})

describe('funded scenario configuration', () => {
  it('rejects an amount above the explicit input cap', () => {
    const env = sameNativeEnvironment()
    env.E2E_SAME_NATIVE_AMOUNT = '11'
    env.E2E_SAME_NATIVE_MAX_INPUT = '10'

    assert.throws(() => parseFundedScenarioConfig('same-native', env), /MAX_INPUT/)
  })

  it('enforces same-chain and cross-chain topology before RPC access', () => {
    assert.throws(() => parseFundedScenarioConfig('same-native', {
      ...sameNativeEnvironment(),
      E2E_SAME_NATIVE_DESTINATION_CHAIN_ID: '137'
    }), /identical source and destination/i)

    assert.throws(() => parseFundedScenarioConfig('cross-native', crossNativeEnvironment('56')), /different source/i)
  })

  it('enforces the configured source-token kind', () => {
    assert.throws(() => parseFundedScenarioConfig('same-native', {
      ...sameNativeEnvironment(),
      E2E_SAME_NATIVE_FROM_TOKEN: RECIPIENT
    }), /native source token/i)

    assert.throws(() => parseFundedScenarioConfig('same-erc20', sameErc20Environment(NATIVE_TOKEN)), /ERC20 source token/i)
  })

  it('rejects fee caps above 100 percent', () => {
    assert.throws(() => parseFundedScenarioConfig('same-native', {
      ...sameNativeEnvironment(),
      E2E_SAME_NATIVE_MAX_PROTOCOL_FEE_BPS: '10001'
    }), /MAX_PROTOCOL_FEE_BPS.*10000/)
  })
})

function sameNativeEnvironment (): NodeJS.ProcessEnv {
  return scenarioEnvironment('E2E_SAME_NATIVE', '56', '56', NATIVE_TOKEN)
}

function sameErc20Environment (fromToken = RECIPIENT): NodeJS.ProcessEnv {
  return scenarioEnvironment('E2E_SAME_ERC20', '56', '56', fromToken)
}

function crossNativeEnvironment (destinationChainId = '137'): NodeJS.ProcessEnv {
  return scenarioEnvironment('E2E_CROSS_NATIVE', '56', destinationChainId, NATIVE_TOKEN)
}

function scenarioEnvironment (
  prefix: string,
  sourceChainId: string,
  destinationChainId: string,
  fromToken: string
): NodeJS.ProcessEnv {
  return {
    [`${prefix}_SOURCE_CHAIN_ID`]: sourceChainId,
    [`${prefix}_DESTINATION_CHAIN_ID`]: destinationChainId,
    [`${prefix}_SOURCE_RPC_URL`]: 'https://source.invalid',
    [`${prefix}_DESTINATION_RPC_URL`]: 'https://destination.invalid',
    [`${prefix}_FROM_TOKEN`]: fromToken,
    [`${prefix}_TO_TOKEN`]: RECIPIENT,
    [`${prefix}_AMOUNT`]: '10',
    [`${prefix}_MAX_INPUT`]: '10',
    [`${prefix}_MAX_NATIVE_FEE`]: '1',
    [`${prefix}_MAX_TOTAL_GAS_FEE`]: '1',
    [`${prefix}_MAX_NETWORK_FEE_BPS`]: '100',
    [`${prefix}_MAX_PROTOCOL_FEE_BPS`]: '100',
    E2E_RECIPIENT: RECIPIENT,
    E2E_EXPECTED_SENDER: SENDER
  }
}
