import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  assertExecutionConfirmed,
  butterAuthFromEnv,
  butterIntegrationFromEnv,
  positiveBigIntFromEnv,
  requestButterRoute
} from '../examples/shared.ts'

describe('example configuration', () => {
  it('uses optional authentication only when both Butter credentials are absent', () => {
    assert.deepEqual(butterAuthFromEnv({}), { authMode: 'optional' })
    assert.deepEqual(butterAuthFromEnv({
      BUTTER_API_KEY_ID: 'key',
      BUTTER_API_SECRET: 'secret'
    }), {
      authMode: 'required',
      apiKeyId: 'key',
      apiSecret: 'secret'
    })
  })

  it('rejects partial Butter credentials', () => {
    assert.throws(
      () => butterAuthFromEnv({ BUTTER_API_KEY_ID: 'key' }),
      /must be provided together/
    )
    assert.throws(
      () => butterAuthFromEnv({ BUTTER_API_SECRET: 'secret' }),
      /must be provided together/
    )
  })

  it('requires a dedicated Butter integration for route requests', () => {
    assert.throws(() => butterIntegrationFromEnv({}), /BUTTER_ENTRANCE is required/)
    assert.throws(
      () => butterIntegrationFromEnv({ BUTTER_ENTRANCE: 'partner' }),
      /BUTTER_API_KEY_ID is required/
    )
    assert.deepEqual(butterIntegrationFromEnv({
      BUTTER_ENTRANCE: 'partner',
      BUTTER_API_KEY_ID: 'key',
      BUTTER_API_SECRET: 'secret'
    }), {
      entrance: 'partner',
      authMode: 'required',
      apiKeyId: 'key',
      apiSecret: 'secret'
    })
  })

  it('requires an exact confirmation before a real transaction example can run', () => {
    assert.throws(() => assertExecutionConfirmed({}), /CONFIRM_EXECUTION/)
    assert.throws(
      () => assertExecutionConfirmed({ CONFIRM_EXECUTION: 'yes' }),
      /CONFIRM_EXECUTION/
    )
    assert.doesNotThrow(() => assertExecutionConfirmed({
      CONFIRM_EXECUTION: 'I_UNDERSTAND_THIS_SENDS_A_REAL_TRANSACTION'
    }))
  })

  it('parses positive integer base-unit amounts without number precision loss', () => {
    assert.equal(positiveBigIntFromEnv('FROM_TOKEN_AMOUNT', { FROM_TOKEN_AMOUNT: '1000000000000000000' }), 1000000000000000000n)
    assert.equal(positiveBigIntFromEnv('FROM_TOKEN_AMOUNT', {}, 1n), 1n)
    assert.throws(() => positiveBigIntFromEnv('FROM_TOKEN_AMOUNT', { FROM_TOKEN_AMOUNT: '0' }), /positive integer/)
    assert.throws(() => positiveBigIntFromEnv('FROM_TOKEN_AMOUNT', { FROM_TOKEN_AMOUNT: '1.5' }), /positive integer/)
  })
})

describe('probe HTTP requests', () => {
  it('rejects credential-bearing HTTP overrides before fetching', async () => {
    let calls = 0

    await assert.rejects(requestButterRoute({}, {
      env: { BUTTER_ROUTER_BASE_URL: 'http://example.test', BUTTER_API_KEY_ID: 'test-key', BUTTER_API_SECRET: 'test-secret' },
      fetch: async () => { calls++; throw new Error('must not fetch') }
    }), { name: 'Error', message: 'Butter API credentials require HTTPS base URLs' })

    assert.equal(calls, 0)
  })

  it('sends authenticated HTTPS requests with encoded parameters and an abort signal', async () => {
    const calls: Array<{ url: string, method: string | undefined, headers: Record<string, string> | undefined, aborted: boolean | undefined }> = []
    const response = { errno: 0, data: [] }

    const result = await requestButterRoute({ amount: '10', affiliate: 'name:1' }, {
      env: { BUTTER_ROUTER_BASE_URL: 'https://example.test', BUTTER_API_KEY_ID: 'test-key', BUTTER_API_SECRET: 'test-secret' },
      fetch: async (url, init) => {
        calls.push({ url, method: init?.method, headers: init?.headers, aborted: init?.signal?.aborted })
        return { ok: true, status: 200, json: async () => response }
      }
    })

    assert.deepEqual(result, response)
    assert.deepEqual(calls, [{
      url: 'https://example.test/route?amount=10&affiliate=name%3A1', method: 'GET',
      headers: { 'x-api-key-id': 'test-key', Authorization: 'Bearer test-secret' }, aborted: false
    }])
  })

  for (const phase of ['fetch', 'json']) {
    it(`times out and aborts a stalled ${phase} even when the injected operation ignores its signal`, async () => {
      let signal: AbortSignal | undefined

      await assert.rejects(requestButterRoute({}, {
        env: {}, timeoutMs: 5,
        fetch: async (_url, init) => {
          signal = init?.signal
          if (phase === 'fetch') return await new Promise<never>(() => {})
          return { ok: true, status: 200, json: async () => await new Promise<never>(() => {}) }
        }
      }), { name: 'Error', message: 'Butter /route request timed out' })

      assert.equal(signal?.aborted, true)
    })
  }

  it('reports HTTP failure without parsing an error page as JSON', async () => {
    let parsed = false
    let signal: AbortSignal | undefined

    await assert.rejects(requestButterRoute({}, {
      env: {},
      fetch: async (_url, init) => {
        signal = init?.signal
        return { ok: false, status: 503, json: async () => { parsed = true; throw new Error('HTML') } }
      }
    }), { name: 'Error', message: 'Butter /route failed with HTTP 503' })

    assert.equal(parsed, false)
    assert.equal(signal?.aborted, true)
  })

  it('allows an unauthenticated HTTP diagnostic endpoint without attaching credentials', async () => {
    let headers: Record<string, string> | undefined

    const result = await requestButterRoute({ type: 'exactOut' }, {
      env: { BUTTER_ROUTER_BASE_URL: 'http://localhost:1234' },
      fetch: async (_url, init) => {
        headers = init?.headers
        return { ok: true, status: 200, json: async () => ({ errno: 2000 }) }
      }
    })

    assert.deepEqual(result, { errno: 2000 })
    assert.deepEqual(headers, {})
  })

  it('prints raw fee components without equating Base58 addresses, symbols or summary currencies', async () => {
    const bridgeFee = {
      chainId: '1360108768460801', amount: '3', address: 'DifferentSummaryMint', symbol: 'TOKEN',
      in: { amount: '1', token: { address: 'AbCdMint', symbol: 'TOKEN', decimals: 6 } },
      out: { amount: '2', token: { address: 'abcdMint', symbol: 'TOKEN', decimals: 6 } },
      affiliate: { amount: '0', token: { symbol: 'TOKEN' } }
    }
    const script = `
      process.env.BUTTER_API_KEY_ID = 'test-key'
      process.env.BUTTER_API_SECRET = 'test-secret'
      process.env.BUTTER_ROUTER_BASE_URL = 'https://example.test'
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ errno: 0, data: [{ bridgeFee: ${JSON.stringify(bridgeFee)} }] }) })
      await import(${JSON.stringify(new URL('../examples/probe-fee-model.ts', import.meta.url).href)})
    `

    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script])
    const result = JSON.parse(stdout)

    assert.deepEqual(result.bridgeFee, bridgeFee)
    assert.equal(Object.hasOwn(result, 'componentsShareOneToken'), false)
    assert.equal(Object.hasOwn(result, 'verdict'), false)
  })
})

describe('example execution errors', () => {
  const approval = { hash: `0x${'1'.repeat(64)}`, chain: '56', type: 'approval' }
  const secondApproval = { hash: `0x${'2'.repeat(64)}`, chain: '56', type: 'approval' }
  const source = { hash: `0x${'3'.repeat(64)}`, chain: '56', type: 'source' }

  for (const { transactions, failedType } of [
    { transactions: [approval], failedType: 'approval' },
    { transactions: [approval, secondApproval], failedType: 'source' },
    { transactions: [approval, secondApproval, source], failedType: 'source' },
    { transactions: [source], failedType: undefined }
  ]) {
    it(`reports ${transactions.length} broadcast hashes and failure role ${failedType}`, async () => {
      const script = `
        import { ButterPartialExecutionError } from '@butternetwork/wdk-protocol-swidge-butter'
        import { runExample } from ${JSON.stringify(new URL('../examples/shared.ts', import.meta.url).href)}
        const transactions = ${JSON.stringify(transactions)}
        transactions[0].privateKey = 'must-not-leak'
        const cause = new Error('secret cause must-not-leak')
        const error = new ButterPartialExecutionError(transactions, cause, ${JSON.stringify(failedType)})
        error.details.apiSecret = 'must-not-leak'
        runExample(async () => { throw error })
      `

      await assert.rejects(
        promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script]),
        (error: unknown) => {
          const failure = error as { code: number, stdout: string, stderr: string }
          assert.equal(failure.code, 1)
          assert.equal(failure.stdout, '')
          assert.deepEqual(JSON.parse(failure.stderr), {
            name: 'ButterPartialExecutionError',
            message: `Butter execution failed after broadcasting ${transactions.length} transaction(s); do not retry without inspecting them`,
            transactions,
            ...(failedType != null ? { failedType } : {})
          })
          return true
        }
      )
    })
  }

  it('keeps ordinary errors as messages on stderr with exit code 1', async () => {
    const script = `
      import { runExample } from ${JSON.stringify(new URL('../examples/shared.ts', import.meta.url).href)}
      runExample(async () => { throw new Error('ordinary failure') })
    `
    await assert.rejects(
      promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script]),
      (error: unknown) => {
        const failure = error as { code: number, stdout: string, stderr: string }
        assert.deepEqual({ code: failure.code, stdout: failure.stdout, stderr: failure.stderr }, {
          code: 1, stdout: '', stderr: 'ordinary failure\n'
        })
        return true
      }
    )
  })

  it('keeps successful results on stdout without error output', async () => {
    const script = `
      import { runExample, printJson } from ${JSON.stringify(new URL('../examples/shared.ts', import.meta.url).href)}
      runExample(async () => { printJson({ hash: ${JSON.stringify(source.hash)}, fee: 1n }) })
    `
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script])
    assert.deepEqual(JSON.parse(stdout), { hash: source.hash, fee: '1' })
    assert.equal(stderr, '')
  })
})
