import assert from 'node:assert/strict'
import { it } from 'node:test'
import { encodeFunctionData, erc20Abi } from 'viem'
import ButterSwidgeProtocol, {
  ButterConfigurationError, ButterPartialExecutionError, toEvmPublicClient,
  type EvmPublicClient
} from '../../src/index.ts'
import {
  makeFetch, quoteRoute, crossChainSwapData, sourceChainWithToken,
  ERC20_TOKEN, DEST_TOKEN, ROUTER, VALID_SENDER, VALID_RECIPIENT,
  ERC20_TOKEN_DECIMALS, dummyHash, assertError
} from '../helpers/protocol-fixtures.ts'

const amount = 1500000000000000000n
const approvalHash = dummyHash(10)
const replacementHash = dummyHash(11)
const sourceHash = dummyHash(12)
const options = {
  fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137,
  recipient: VALID_RECIPIENT, fromTokenAmount: amount, slippage: 0.02
}
const approvalTransaction = {
  to: ERC20_TOKEN, value: 0n, chainId: 56,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, amount] })
}

type ReceiptSource = 'viem waiter' | 'account receipt'
type PublicReceipt = Awaited<ReturnType<NonNullable<EvmPublicClient['waitForTransactionReceipt']>>>

function executionHarness (source: ReceiptSource, receipt: unknown) {
  let allowance = 0n
  const sends: unknown[] = []
  const receiptQueries: string[] = []
  const allowanceQueries: unknown[] = []
  const fetch = makeFetch({
    '/route': () => ({ errno: 0, data: [quoteRoute({
      swapFee: { nativeFee: '0', tokenFee: '0' },
      srcChain: sourceChainWithToken(ERC20_TOKEN),
      dstChain: {
        chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6 }, totalAmountOut: '10.25'
      }
    })] }),
    '/swap': () => ({ errno: 0, data: [{
      to: ROUTER, value: '0', chainId: '56', data: crossChainSwapData(ERC20_TOKEN, amount)
    }] })
  })
  const protocol = new ButterSwidgeProtocol({
    getAddress: () => VALID_SENDER,
    getAllowance: async () => allowance,
    sendTransaction: async (transaction: unknown) => {
      sends.push(transaction)
      return sends.length === 1 ? approvalHash : sourceHash
    },
    getTransactionReceipt: async (hash) => {
      assert.equal(source, 'account receipt')
      receiptQueries.push(hash)
      allowance = amount
      return receipt
    }
  }, {
    sourceChainId: 56, entrance: 'wdk', fetch, tokenDecimals: ERC20_TOKEN_DECIMALS,
    maxNativeFee: 0n, now: () => 1000,
    ...(source === 'viem waiter' ? { evm: { publicClient: toEvmPublicClient({
      readContract: async (args) => {
        allowanceQueries.push(args)
        return allowance
      },
      waitForTransactionReceipt: async (args) => {
        assert.deepEqual(args, { hash: approvalHash, confirmations: 1, timeout: 10000 })
        receiptQueries.push(args.hash)
        allowance = amount
        return receipt as PublicReceipt
      },
      getTransactionReceipt: async () => { throw new Error('Unexpected direct receipt query') },
      getTransaction: async () => { throw new Error('Unexpected transaction query') }
    }) } } : {})
  })
  return { protocol, sends, receiptQueries, allowanceQueries }
}

for (const source of ['viem waiter', 'account receipt'] as const) {
  for (const hashField of ['transactionHash', 'hash'] as const) {
    for (const [label, receiptHash, message] of [
      ['cancelled or replaced', replacementHash, 'ERC20 approval receipt belongs to a different transaction'],
      ['empty', '', 'ERC20 approval receipt has an invalid transaction hash'],
      ['truncated', '0xaaaa', 'ERC20 approval receipt has an invalid transaction hash'],
      ['non-hex', `0x${'g'.repeat(64)}`, 'ERC20 approval receipt has an invalid transaction hash'],
      ['numeric', 1, 'ERC20 approval receipt has an invalid transaction hash'],
      ['null', null, 'ERC20 approval receipt has an invalid transaction hash'],
      ['explicitly undefined', undefined, 'ERC20 approval receipt has an invalid transaction hash']
    ] as const) {
      it(`stops after the approval when ${source} returns a ${label} ${hashField}`, async () => {
        const harness = executionHarness(source, { status: 'success', [hashField]: receiptHash })

        await assert.rejects(harness.protocol.swidge(options), (error: unknown) => {
          assertError(error, ButterPartialExecutionError,
            'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
          assert.deepEqual(error.transactions, [{ hash: approvalHash, chain: '56', type: 'approval' }])
          assert.equal(error.failedType, 'approval')
          assertError(error.cause, ButterConfigurationError, message)
          assert.deepEqual(error.cause.details, { hash: approvalHash, receiptHash, hashField })
          return true
        })

        assert.deepEqual(harness.sends, [approvalTransaction])
        assert.deepEqual(harness.receiptQueries, [approvalHash])
      })
    }
  }

  for (const conflictingField of ['transactionHash', 'hash'] as const) {
    it(`rejects conflicting receipt aliases when ${source} reports a different ${conflictingField}`, async () => {
      const harness = executionHarness(source, {
        status: 'success', hash: approvalHash, transactionHash: approvalHash, [conflictingField]: replacementHash
      })

      await assert.rejects(harness.protocol.swidge(options), (error: unknown) => {
        assertError(error, ButterPartialExecutionError,
          'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
        assert.deepEqual(error.transactions, [{ hash: approvalHash, chain: '56', type: 'approval' }])
        assert.equal(error.failedType, 'approval')
        assertError(error.cause, ButterConfigurationError, 'ERC20 approval receipt belongs to a different transaction')
        assert.deepEqual(error.cause.details, { hash: approvalHash, receiptHash: replacementHash, hashField: conflictingField })
        return true
      })

      assert.deepEqual(harness.sends, [approvalTransaction])
      assert.deepEqual(harness.receiptQueries, [approvalHash])
    })
  }

  for (const [label, receipt] of [
    ['matching viem hash', { status: 'success', transactionHash: approvalHash }],
    ['matching ethers hash', { status: 'success', hash: approvalHash }],
    ['matching uppercase hex', { status: 'success', transactionHash: `0x${'A'.repeat(64)}` }],
    ['equivalent hash aliases', { status: 'success', transactionHash: `0x${'A'.repeat(64)}`, hash: approvalHash }],
    ['legacy status-only receipt', { status: 'success' }]
  ] as const) {
    it(`continues after ${source} confirms with a ${label}`, async () => {
      const harness = executionHarness(source, receipt)

      const result = await harness.protocol.swidge(options)

      assert.deepEqual(result.transactions, [
        { hash: approvalHash, chain: '56', type: 'approval' },
        { hash: sourceHash, chain: '56', type: 'source' }
      ])
      assert.equal(result.id, sourceHash)
      assert.deepEqual(harness.receiptQueries, [approvalHash])
      assert.deepEqual(harness.sends, [approvalTransaction, {
        to: ROUTER, value: 0n, data: crossChainSwapData(ERC20_TOKEN, amount), chainId: 56
      }])
      assert.deepEqual(harness.allowanceQueries, source === 'viem waiter' ? Array.from({ length: 2 }, () => ({
        address: ERC20_TOKEN, abi: erc20Abi, functionName: 'allowance', args: [VALID_SENDER, ROUTER]
      })) : [])
    })
  }
}
