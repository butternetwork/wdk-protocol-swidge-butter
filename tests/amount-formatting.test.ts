import assert from 'node:assert/strict'
import { it } from 'node:test'
import { formatTokenAmount } from '../src/index.ts'

for (const amount of ['', ' ', '\t\n', '1.5', 'abc', '1e6', '0x10', '0b10', '0o10', '+1', '-1', '1 000', '1_000']) {
  it(`rejects invalid decimal base-unit string ${JSON.stringify(amount)} with a Butter API error`, () => {
    assert.throws(() => formatTokenAmount(amount, 6), {
      name: 'ButterApiError',
      message: `Invalid token amount: ${amount}`
    })
  })
}

for (const [amount, decimals, expected] of [
  ['0', 6, '0'],
  ['0000', 6, '0'],
  [' 1000000 ', 6, '1'],
  ['\t001234500\n', 6, '1.2345'],
  ['1', 18, '0.000000000000000001'],
  ['123456789012345678901234567890', 18, '123456789012.34567890123456789'],
  ['42', 0, '42'],
  [1000000, 6, '1'],
  [1000000n, 6, '1'],
  [0n, 6, '0']
] as const) {
  it(`formats ${String(amount)} base units exactly with ${decimals} decimals`, () => {
    assert.equal(formatTokenAmount(amount, decimals), expected)
  })
}

for (const amount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
  it(`rejects unsafe numeric base units ${amount} with a Butter API error`, () => {
    assert.throws(() => formatTokenAmount(amount, 6), {
      name: 'ButterApiError',
      message: `Unsafe numeric token amount: ${amount}; use bigint base units`
    })
  })
}

it('rejects negative bigint base units with a Butter API error', () => {
  assert.throws(() => formatTokenAmount(-1n, 6), {
    name: 'ButterApiError',
    message: 'Invalid token amount: -1'
  })
})
