import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertExecutionConfirmed,
  butterAuthFromEnv,
  butterIntegrationFromEnv,
  positiveBigIntFromEnv
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
