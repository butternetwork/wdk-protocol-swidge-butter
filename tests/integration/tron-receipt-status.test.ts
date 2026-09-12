import { it } from 'node:test'
import assert from 'node:assert/strict'
import ButterSwidgeProtocol from '../../src/index.ts'
import { makeFetch } from '../helpers/protocol-fixtures.ts'

const chain = '728126428'
const hash = 'a'.repeat(64)
const token = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const sender = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'
const options = { fromToken: 'native', toToken: token, toChain: chain, fromTokenAmount: 1000000n, slippage: 0.01 }
const source = { hash, chain, type: 'source' }

function setup (receipts: unknown[], { missingGetter = false, crossChain = false, partial = false } = {}) {
  const queried: string[] = []
  const sent: unknown[] = []
  const destination = crossChain ? '56' : chain
  const fetch = makeFetch({
    '/route': () => ({ errno: 0, data: [{
      hash: 'tron-route', timestamp: 1000,
      srcChain: {
        chainId: chain, tokenIn: { address: 'native', decimals: 6 },
        tokenOut: { address: token, decimals: 6 }, totalAmountIn: '1', totalAmountOut: '1'
      },
      ...(crossChain ? { dstChain: {
        chainId: destination, tokenOut: { address: token, decimals: 6 }, totalAmountOut: '1'
      } } : {}),
      minAmountOut: { amount: '0.99' }, swapFee: { nativeFee: '0', tokenFee: '0' }
    }] }),
    '/swap': () => ({ errno: 0, data: [
      { to: sender, value: '0', data: 'source', chainId: chain },
      ...(partial ? [{ to: sender, value: '0', data: 'after', chainId: chain }] : [])
    ] }),
    '/api/queryBridgeInfoBySourceHash': () => ({ code: 200, data: { state: 1, sourceHash: hash, fromChain: chain, toChain: destination } })
  })
  const account = {
    getAddress: () => sender,
    sendTransaction: async (tx: unknown) => {
      sent.push(tx)
      if (partial && sent.length === 2) throw new Error('Later send failed')
      return hash
    },
    ...(!missingGetter ? { async getTransactionReceipt (id: string): Promise<unknown> {
      assert.equal(this, account)
      queried.push(id)
      const receipt = receipts.shift()
      if (receipt instanceof Error) throw receipt
      return receipt
    } } : {})
  }
  const protocol = new ButterSwidgeProtocol(account, {
    sourceChainId: chain, entrance: 'wdk', fetch, now: () => 1000,
    transactionAdapters: { [chain]: tx => ({
      transaction: { step: tx.data }, type: tx.data === 'source' ? 'source' : 'destination'
    }) },
    evm: { publicClient: {
      readContract: async () => 0n,
      getTransactionReceipt: async () => { throw new Error('Tron must not query EVM receipts') }
    } }
  })
  return { protocol, queried, sent, fetch }
}

const cases: { label: string, receipt: unknown, status: string }[] = [
  { label: 'contract success', receipt: { receipt: { result: 'SUCCESS' } }, status: 'completed' },
  { label: 'official top-level success', receipt: { result: 'SUCESS', receipt: { result: 'SUCCESS' } }, status: 'completed' },
  { label: 'top-level failure', receipt: { result: 'FAILED' }, status: 'failed' },
  { label: 'failure beats success', receipt: { result: 'FAILED', receipt: { result: 'SUCCESS' }, status: 1 }, status: 'failed' },
  { label: 'normalized success', receipt: { status: 'success' }, status: 'completed' },
  { label: 'normalized failure', receipt: { status: 'reverted' }, status: 'failed' },
  ...['REVERT', 'BAD_JUMP_DESTINATION', 'OUT_OF_MEMORY', 'PRECOMPILED_CONTRACT',
    'STACK_TOO_SMALL', 'STACK_TOO_LARGE', 'ILLEGAL_OPERATION', 'STACK_OVERFLOW',
    'OUT_OF_ENERGY', 'OUT_OF_TIME', 'JVM_STACK_OVER_FLOW', 'UNKNOWN', 'TRANSFER_FAILED', 'INVALID_CODE'
  ].map(result => ({ label: result, receipt: { result: 'SUCESS', receipt: { result }, status: 1 }, status: 'failed' })),
  ...[null, undefined, {}, [], 'SUCCESS', 1, true,
    { receipt: {} }, { receipt: null, status: 1 }, { receipt: undefined, status: 1 },
    { receipt: [], status: 1 }, { receipt: 'SUCCESS', status: 1 },
    ...['DEFAULT', 'FUTURE_RESULT', 'success', 1, null, undefined, {}, []].map(result => ({ receipt: { result }, status: 1 })),
    ...[null, undefined, 'SUCCESS', 'FUTURE_RESULT', 0, {}, []].map(result => ({ result, receipt: { result: 'SUCCESS' }, status: 1 })),
    { result: 'SUCESS', status: 1 }
  ].map((receipt, index) => ({ label: `unknown receipt ${index}`, receipt, status: 'pending' }))
]

for (const { label, receipt, status } of cases) {
  it(`reports Tron ${label} through the recorded same-chain operation`, async () => {
    const { protocol, queried, sent, fetch } = setup([receipt])

    const result = await protocol.swidge(options)
    const actual = await protocol.getSwidgeStatus(result.id)

    assert.equal(result.id, hash)
    assert.deepEqual(actual, { status, transactions: receipt == null ? [] : [source] })
    assert.deepEqual(queried, [hash])
    assert.deepEqual(sent, [{ step: 'source' }])
    assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/route', '/swap'])
  })
}

for (const [result, status] of [['SUCCESS', 'completed'], ['REVERT', 'failed']] as const) {
  it(`updates a pending Tron operation to ${status}`, async () => {
    const { protocol, queried } = setup([null, { receipt: { result } }])
    await protocol.swidge(options)

    const pending = await protocol.getSwidgeStatus(hash)
    const terminal = await protocol.getSwidgeStatus(hash)

    assert.deepEqual(pending, { status: 'pending', transactions: [] })
    assert.deepEqual(terminal, { status, transactions: [source] })
    assert.deepEqual(queried, [hash, hash])
  })
}

it('requires a Tron account receipt getter even when an EVM client is configured', async () => {
  const { protocol } = setup([], { missingGetter: true })
  await protocol.swidge(options)

  await assert.rejects(protocol.getSwidgeStatus(hash), {
    name: 'ButterConfigurationError',
    message: 'Tron same-chain swidge status requires an account with getTransactionReceipt'
  })
})

it('propagates Tron receipt RPC errors unchanged', async () => {
  const error = new Error('Tron RPC timeout')
  const { protocol, queried } = setup([error])
  await protocol.swidge(options)

  await assert.rejects(protocol.getSwidgeStatus(hash), { name: 'Error', message: 'Tron RPC timeout' })

  assert.deepEqual(queried, [hash])
})

it('rejects conflicting Tron chain hints before querying the account', async () => {
  const { protocol, queried } = setup([])
  await protocol.swidge(options)

  await assert.rejects(protocol.getSwidgeStatus(hash, { fromChain: '56' }), {
    name: 'ButterApiError', message: 'Butter status source chain does not match request hints'
  })
  await assert.rejects(protocol.getSwidgeStatus(hash, { toChain: '56' }), {
    name: 'ButterApiError', message: 'Butter status destination chain does not match request hints'
  })

  assert.deepEqual(queried, [])
})

it('queries Butter for recorded Tron cross-chain operations', async () => {
  const { protocol, queried, fetch } = setup([], { crossChain: true })
  await protocol.swidge({ ...options, toChain: '56', slippage: 0.02, recipient: '0x1111111111111111111111111111111111111111', maxNativeFee: 0n })

  const actual = await protocol.getSwidgeStatus(hash)

  assert.deepEqual(actual, { status: 'completed', transactions: [source] })
  assert.deepEqual(queried, [])
  assert.deepEqual(fetch.calls.map(({ url }) => url.pathname), ['/route', '/swap', '/api/queryBridgeInfoBySourceHash'])
})

it('queries Tron receipts for a source recorded after partial execution', async () => {
  const { protocol, sent, queried } = setup([{ receipt: { result: 'SUCCESS' } }], { partial: true })
  await assert.rejects(protocol.swidge(options), {
    name: 'ButterPartialExecutionError', message: 'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them'
  })

  const actual = await protocol.getSwidgeStatus(hash)

  assert.deepEqual(actual, { status: 'completed', transactions: [source] })
  assert.deepEqual(queried, [hash])
  assert.deepEqual(sent, [{ step: 'source' }, { step: 'after' }])
})
