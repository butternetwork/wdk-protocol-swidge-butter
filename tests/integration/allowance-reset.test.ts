import assert from 'node:assert/strict'
import { it } from 'node:test'
import { setImmediate as flushAsyncWork } from 'node:timers/promises'
import { decodeFunctionData, encodeFunctionData, erc20Abi } from 'viem'
import ButterSwidgeProtocol, {
  ButterPartialExecutionError, ButterConfigurationError,
  type ButterAccount
} from '../../src/index.ts'
import {
  sameChainErc20Fetch, sameChainErc20Options, ERC20_TOKEN, ERC20_TOKEN_DECIMALS,
  ROUTER, VALID_SENDER, dummyHash, assertError, makeFetch, quoteRoute,
  sourceChainWithToken, DEST_TOKEN, crossChainSwapData
} from '../helpers/protocol-fixtures.ts'

const amount = sameChainErc20Options.fromTokenAmount

function approval (value: bigint) {
  return {
    to: ERC20_TOKEN, value: 0n, chainId: 56,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, value] })
  }
}

interface HarnessOptions {
  reader?: 'account' | 'public' | 'none'
  readError?: Error
  failSend?: number
  failReceipt?: number
  receipts?: boolean
  crossChain?: boolean
  noOpApproval?: number
  observed?: (allowance: bigint, confirmations: number) => Promise<bigint>
  receiptDelayMs?: number
  timeoutMs?: number
  publicWaiter?: boolean
}

function harness (initial: bigint, settings: HarnessOptions = {}) {
  let allowance = initial
  let attempts = 0
  let confirmations = 0
  const sent: ReturnType<typeof approval>[] = []
  const events: string[] = []
  const pending = new Map<string, bigint>()
  const sendError = new Error('Approval send rejected')
  const reader = settings.reader ?? 'account'
  const account: ButterAccount = {
    getAddress: () => VALID_SENDER,
    async sendTransaction (raw: unknown) {
      const tx = raw as ReturnType<typeof approval>
      attempts++
      if (attempts === settings.failSend) throw sendError
      const hash = dummyHash(attempts)
      if (tx.to === ERC20_TOKEN) {
        const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data as `0x${string}` })
        assert.equal(decoded.functionName, 'approve')
        const [spender, value] = decoded.args as readonly [string, bigint]
        assert.equal(spender, ROUTER)
        if (allowance !== 0n && value !== 0n) throw new Error('USDT requires allowance reset')
        pending.set(hash, value)
        events.push(`approve:${value}`)
      } else {
        assert.equal(allowance, amount)
        assert.equal(pending.size, 0)
        events.push('swap')
      }
      sent.push(tx)
      return { hash, fee: 10n }
    }
  }
  if (reader !== 'none') {
    account.getAllowance = async function (token, spender) {
      assert.equal(this, account)
      assert.deepEqual([token, spender], [ERC20_TOKEN, ROUTER])
      events.push('account-read')
      if (settings.readError) throw settings.readError
      return settings.observed ? settings.observed(allowance, confirmations) : allowance
    }
  }
  if (settings.receipts !== false) {
    account.getTransactionReceipt = async hash => {
      confirmations++
      events.push(`confirm:${hash}`)
      if (settings.receiptDelayMs) await new Promise(resolve => setTimeout(resolve, settings.receiptDelayMs))
      if (confirmations === settings.failReceipt) return { status: 'reverted', transactionHash: hash }
      if (confirmations !== settings.noOpApproval) allowance = pending.get(hash)!
      pending.delete(hash)
      return { status: 'success', transactionHash: hash }
    }
  }
  const fetch = settings.crossChain ? makeFetch({
    '/route': () => ({ errno: 0, data: [quoteRoute({
      swapFee: { nativeFee: '0', tokenFee: '0' }, srcChain: sourceChainWithToken(ERC20_TOKEN),
      dstChain: { chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6 }, totalAmountOut: '10.25' }
    })] }),
    '/swap': () => ({ errno: 0, data: [{
      to: ROUTER, value: '0', chainId: '56', data: crossChainSwapData(ERC20_TOKEN, amount)
    }] })
  }) : sameChainErc20Fetch()
  const protocol = new ButterSwidgeProtocol(account, {
    sourceChainId: 56, entrance: 'wdk', tokenDecimals: ERC20_TOKEN_DECIMALS, fetch,
    now: () => 1000, maxNativeFee: 0n,
    evm: {
      approvalTimeoutMs: settings.timeoutMs ?? 10000,
      ...(reader === 'public' ? { publicClient: {
      async readContract (args) {
        assert.deepEqual(args, {
          address: ERC20_TOKEN, abi: erc20Abi, functionName: 'allowance', args: [VALID_SENDER, ROUTER]
        })
        events.push('public-read')
        if (settings.readError) throw settings.readError
        return settings.observed ? settings.observed(allowance, confirmations) : allowance
      },
      ...(settings.publicWaiter ? {
        waitForTransactionReceipt: async ({ hash }: { hash: string }) => account.getTransactionReceipt!(hash) as Promise<{ status: 'success' }>
      } : {})
    } } : {})
    }
  })
  return { protocol, sent, events, sendError }
}

for (const reader of ['account', 'public'] as const) {
  for (const initial of [0n, amount - 1n, amount, amount + 1n, 2n ** 256n - 1n]) {
    it(`executes USDT-like authorization from ${initial} with the ${reader} reader`, async () => {
      const { protocol, sent, events } = harness(initial, { reader })
      const values = initial === amount ? [] : initial === 0n ? [amount] : [0n, amount]

      const result = await protocol.swidge(sameChainErc20Options)

      assert.deepEqual(sent.slice(0, -1), values.map(approval))
      assert.equal(sent.at(-1)?.to, ROUTER)
      assert.deepEqual(events, [
        `${reader}-read`,
        ...values.flatMap((value, i) => [`approve:${value}`, `confirm:${dummyHash(i + 1)}`, `${reader}-read`]), 'swap'
      ])
      assert.equal(result.id, dummyHash(values.length + 1))
      assert.deepEqual(result.transactions, [
        ...values.map((_, i) => ({ hash: dummyHash(i + 1), chain: '56', type: 'approval' })),
        { hash: dummyHash(values.length + 1), chain: '56', type: 'source' }
      ])
      assert.equal(result.fees.find(fee => fee.type === 'network')?.amount, BigInt(values.length + 1) * 10n)
    })
  }

  it(`propagates the ${reader} allowance read error without fallback or broadcasts`, async () => {
    const readError = new Error('Allowance RPC unavailable')
    const { protocol, sent, events } = harness(0n, { reader, readError })

    await assert.rejects(protocol.swidge(sameChainErc20Options), error => {
      assert.equal(error, readError)
      return true
    })

    assert.deepEqual(sent, [])
    assert.deepEqual(events, [`${reader}-read`])
  })
}

it('rejects missing allowance readers before broadcasting but permits quoting', async () => {
  const { protocol, sent, events } = harness(0n, { reader: 'none' })

  const quote = await protocol.quoteSwidge(sameChainErc20Options)
  await assert.rejects(protocol.swidge(sameChainErc20Options), {
    name: 'ButterConfigurationError',
    message: 'ERC20 execution requires an allowance reader: provide evm.publicClient or an account with getAllowance'
  })

  assert.equal(quote.fromTokenAmount, amount)
  assert.deepEqual(sent, [])
  assert.deepEqual(events, [])
})

it('uses an exact account allowance without requiring approval receipts', async () => {
  const { protocol, sent, events } = harness(amount, { receipts: false })

  const result = await protocol.swidge(sameChainErc20Options)

  assert.equal(result.id, dummyHash(1))
  assert.equal(sent.length, 1)
  assert.deepEqual(events, ['account-read', 'swap'])
})

it('requires receipt confirmation before resetting an account allowance', async () => {
  const { protocol, sent } = harness(amount + 1n, { receipts: false })

  await assert.rejects(protocol.swidge(sameChainErc20Options), {
    name: 'ButterConfigurationError',
    message: 'ERC20 approval requires a receipt source to confirm before the swap: provide evm.publicClient.waitForTransactionReceipt or a WDK account with getTransactionReceipt'
  })

  assert.deepEqual(sent, [])
})

for (const [label, settings, count] of [
  ['reset send', { failSend: 1 }, 0],
  ['reset confirmation', { failReceipt: 1 }, 1],
  ['replacement approval send', { failSend: 2 }, 1],
  ['replacement approval confirmation', { failReceipt: 2 }, 2]
] as const) {
  it(`stops USDT-like execution after ${label} fails and preserves broadcast hashes`, async () => {
    const { protocol, sent, sendError } = harness(amount + 1n, settings)

    await assert.rejects(protocol.swidge(sameChainErc20Options), error => {
      if (count === 0) {
        assert.equal(error, sendError)
      } else {
        assertError(error, ButterPartialExecutionError,
          `Butter execution failed after broadcasting ${count} transaction(s); do not retry without inspecting them`)
        assert.deepEqual(error.transactions, Array.from({ length: count }, (_, i) => ({
          hash: dummyHash(i + 1), chain: '56', type: 'approval'
        })))
        assert.equal(error.failedType, 'approval')
        if ('failSend' in settings) assert.equal(error.cause, sendError)
        else assertError(error.cause, ButterConfigurationError, 'ERC20 approval transaction reverted')
      }
      return true
    })

    assert.deepEqual(sent, [approval(0n), approval(amount)].slice(0, count))
  })
}

it('resets account allowances before an EVM cross-chain swap', async () => {
  const { protocol, sent, events } = harness(amount + 1n, { crossChain: true })

  const result = await protocol.swidge({ ...sameChainErc20Options, toChain: 137, slippage: 0.02 })

  assert.equal(result.id, dummyHash(3))
  assert.deepEqual(sent.slice(0, 2), [approval(0n), approval(amount)])
  assert.deepEqual(events, [
    'account-read', 'approve:0', `confirm:${dummyHash(1)}`, 'account-read',
    `approve:${amount}`, `confirm:${dummyHash(2)}`, 'account-read', 'swap'
  ])
})

for (const reader of ['account', 'public'] as const) {
  for (const [label, initial, noOpApproval, expected, actual] of [
    ['reset has no effect', amount + 1n, 1, 0n, amount + 1n],
    ['amount approval has no effect', 0n, 1, amount, 0n],
    ['amount approval after reset has no effect', amount + 1n, 2, amount, 0n]
  ] as const) {
    it(`preserves approval hashes when ${label} with the ${reader} reader`, async t => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
      const { protocol, sent, events } = harness(initial, { reader, noOpApproval, timeoutMs: 2500, publicWaiter: true })

      const failure = assert.rejects(protocol.swidge(sameChainErc20Options), error => {
        assertError(error, ButterPartialExecutionError,
          `Butter execution failed after broadcasting ${noOpApproval} transaction(s); do not retry without inspecting them`)
        assert.equal(error.failedType, 'approval')
        assert.deepEqual(error.transactions, Array.from({ length: noOpApproval }, (_, i) => ({
          hash: dummyHash(i + 1), chain: '56', type: 'approval'
        })))
        assertError(error.cause, ButterConfigurationError, 'Timed out waiting for the ERC20 allowance to match the approval')
        assert.deepEqual(error.cause.details, {
          hash: dummyHash(noOpApproval), token: ERC20_TOKEN, spender: ROUTER,
          expectedAllowance: expected.toString(), actualAllowance: actual.toString(), timeoutMs: 2500
        })
        return true
      })
      await flushAsyncWork()
      t.mock.timers.tick(2000)
      await flushAsyncWork()
      t.mock.timers.tick(500)
      await failure

      const values = initial === 0n ? [amount] : [0n, amount].slice(0, noOpApproval)
      assert.deepEqual(sent, values.map(approval))
      assert.deepEqual(events, [
        `${reader}-read`,
        ...values.flatMap((value, i) => [`approve:${value}`, `confirm:${dummyHash(i + 1)}`, `${reader}-read`]),
        `${reader}-read`
      ])
    })
  }

  it(`waits for delayed ${reader} allowance visibility with a fresh budget for each approval`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
    const seen = new Set<number>()
    const { protocol, sent, events } = harness(amount + 1n, {
      reader, timeoutMs: 3000, publicWaiter: true,
      observed: async (allowance, confirmations) => {
        if (confirmations > 0 && !seen.has(confirmations)) {
          seen.add(confirmations)
          return allowance + 1n
        }
        return allowance
      }
    })

    const execution = protocol.swidge(sameChainErc20Options)
    await flushAsyncWork()
    assert.deepEqual(sent, [approval(0n)])
    t.mock.timers.tick(2000)
    await flushAsyncWork()
    assert.deepEqual(sent, [approval(0n), approval(amount)])
    t.mock.timers.tick(2000)
    const result = await execution

    assert.equal(result.id, dummyHash(3))
    assert.deepEqual(events, [
      `${reader}-read`, 'approve:0', `confirm:${dummyHash(1)}`, `${reader}-read`, `${reader}-read`,
      `approve:${amount}`, `confirm:${dummyHash(2)}`, `${reader}-read`, `${reader}-read`, 'swap'
    ])
  })

  for (const mode of ['RPC fault', 'hung read', 'too small', 'too large'] as const) {
    it(`stops after approval on ${mode} from the ${reader} reader`, async t => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
      const rpcError = new Error('Allowance RPC unavailable after confirmation')
      const { protocol, sent, events } = harness(0n, {
        reader, timeoutMs: 1000, publicWaiter: true,
        observed: async (allowance, confirmations) => {
          if (confirmations === 0) return allowance
          if (mode === 'RPC fault') throw rpcError
          if (mode === 'hung read') return new Promise<bigint>(() => {})
          return mode === 'too small' ? amount - 1n : amount + 1n
        }
      })

      const failure = assert.rejects(protocol.swidge(sameChainErc20Options), error => {
        assertError(error, ButterPartialExecutionError,
          'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
        assert.equal(error.failedType, 'approval')
        assert.deepEqual(error.transactions, [{ hash: dummyHash(1), chain: '56', type: 'approval' }])
        if (mode === 'RPC fault') assert.equal(error.cause, rpcError)
        else {
          assertError(error.cause, ButterConfigurationError, 'Timed out waiting for the ERC20 allowance to match the approval')
          assert.deepEqual(error.cause.details, {
            hash: dummyHash(1), token: ERC20_TOKEN, spender: ROUTER,
            expectedAllowance: amount.toString(), timeoutMs: 1000,
            ...(mode === 'hung read' ? {} : { actualAllowance: (mode === 'too small' ? amount - 1n : amount + 1n).toString() })
          })
        }
        return true
      })
      await flushAsyncWork()
      if (mode !== 'RPC fault') t.mock.timers.tick(1000)
      await failure

      assert.deepEqual(sent, [approval(amount)])
      assert.deepEqual(events, [`${reader}-read`, `approve:${amount}`, `confirm:${dummyHash(1)}`, `${reader}-read`])
    })
  }

  it(`shares the receipt and allowance timeout for the ${reader} reader`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
    const { protocol, sent, events } = harness(0n, {
      reader, timeoutMs: 2500, receiptDelayMs: 2000, noOpApproval: 1, publicWaiter: true
    })
    const failure = assert.rejects(protocol.swidge(sameChainErc20Options), error => {
      assertError(error, ButterPartialExecutionError,
        'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
      assertError(error.cause, ButterConfigurationError, 'Timed out waiting for the ERC20 allowance to match the approval')
      assert.equal(Date.now(), 3500)
      return true
    })
    await flushAsyncWork()
    t.mock.timers.tick(2000)
    await flushAsyncWork()
    t.mock.timers.tick(500)
    await failure

    assert.deepEqual(sent, [approval(amount)])
    assert.deepEqual(events, [`${reader}-read`, `approve:${amount}`, `confirm:${dummyHash(1)}`, `${reader}-read`])
  })
}
