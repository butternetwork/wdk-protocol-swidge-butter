import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  isAddress,
  parseAbi,
  parseAbiParameters,
  stringToHex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  zeroHash
} from 'viem'
import ButterSwidgeProtocol, {
  ButterActionRequiredError,
  ButterApiError,
  ButterConfigurationError,
  ButterExactOutUnsupportedError,
  ButterFeeLimitExceededError,
  ButterNoRouteError,
  ButterPartialExecutionError,
  ButterReadOnlyAccountError,
  ButterTransactionValidationError,
  ButterUnsupportedError,
  parseTokenAmount,
  toButterSlippage,
  toEvmWalletClient,
  toEvmPublicClient
} from '../src/index.ts'
import {
  jsonResponse,
  failAfter,
  assertError,
  makeFetch,
  quoteRoute,
  NATIVE_TOKEN,
  ERC20_TOKEN,
  DEST_TOKEN,
  VALID_SENDER,
  VALID_RECIPIENT,
  ROUTER,
  SOLANA_CHAIN_ID,
  FORMER_TON_CHAIN_ID,
  DEFAULT_TOKEN_DECIMALS,
  ERC20_TOKEN_DECIMALS,
  evmWallet,
  routerV3Abi,
  swapParamAbi,
  bridgeParamAbi,
  bridgeAdapterParamAbi,
  remoteSwapAndCallAbi,
  crossChainSwapData,
  feeParamAbi,
  encodeFeeData,
  sourceChainWithToken,
  sameChainSwapDataFor,
  NATIVE_FEE_PART,
  nativeFeeFetch,
  nativeFeeOptions,
  multiTxAdapterFetch,
  threeTxAdapterFetch,
  threeTxAdapter,
  oversizedAllowanceFetch,
  protocolFailingOnSend,
  sameChainErc20Options,
  sameChainErc20Fetch,
  erc20FeeProtocol
} from './helpers/protocol-fixtures.js'

describe('@butternetwork/wdk-protocol-swidge-butter', () => {
  let account: { getAddress: () => Promise<string>, sendTransaction: (tx: unknown) => Promise<{ hash: string, tx: unknown }> }

  beforeEach(() => {
    account = {
      async getAddress () { return VALID_SENDER },
      async sendTransaction (tx) { return { hash: '0x1111111111111111111111111111111111111111111111111111111111111111', tx } }
    }
  })

  it('accepts a Bitcoin txid that differs only by case', async () => {
      // BTC and Tron txids are bare 64-hex with no 0x prefix. Treating them with the
      // token-identifier rule made two casings of one txid look like two transactions.
      const txid = 'AbCdEf0123456789'.repeat(4)
      const fetch = makeFetch({
        '/api/queryBridgeInfoBySourceHash': async () => ({
          code: 200,
          message: 'success',
          data: { info: { state: 1, sourceHash: txid.toLowerCase(), toHash: '0x2222222222222222222222222222222222222222222222222222222222222222', fromChain: { chainId: '1360095883558913' }, toChain: { chainId: '137' } } }
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: '1360095883558913', entrance: 'wdk', fetch })
  
      const status = await protocol.getSwidgeStatus(txid)
  
      assert.deepEqual(status, {
        status: 'completed',
        transactions: [
          { hash: txid.toLowerCase(), chain: '1360095883558913', type: 'source' },
          {
            hash: '0x2222222222222222222222222222222222222222222222222222222222222222',
            chain: '137',
            type: 'destination'
          }
        ]
      })
    })

  it('does not treat a differently cased source hash as the same operation', async () => {
      // Two Base58 signatures differing only in case are two transactions. Comparing
      // them loosely reported one's status for the other and returned a hash the
      // caller never asked about.
      const requested = 'AbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGHJK'
      const reported = 'abcdefghjklmnpqrstuvwxyz123456789abcdefghjk'
      const fetch = makeFetch({
        '/api/queryBridgeInfoBySourceHash': async () => ({
          code: 200,
          message: 'success',
          data: { info: { state: 1, sourceHash: reported, toHash: '0x2222222222222222222222222222222222222222222222222222222222222222', fromChain: { chainId: '56' }, toChain: { chainId: '137' } } }
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      await assert.rejects(
        protocol.getSwidgeStatus(requested),
        { name: 'ButterApiError', message: 'Butter status sourceHash does not match requested id' }
      )
    })

  it('maps and validates source-hash status responses', async () => {
      const fetch = makeFetch({
        '/api/queryBridgeInfoBySourceHash': async (url) => {
          assert.equal(url.searchParams.get('hash'), '0x1111111111111111111111111111111111111111111111111111111111111111')
          return {
            code: 200,
            message: 'success',
            data: {
              info: {
                state: 1,
                sourceHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
                toHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
                fromChain: { chainId: '56' },
                toChain: { chainId: '137' }
              }
            }
          }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch
      })
  
      const status = await protocol.getSwidgeStatus('0x1111111111111111111111111111111111111111111111111111111111111111', { fromChain: 56, toChain: 137 })
  
      assert.equal(status.status, 'completed')
      assert.deepEqual(status.transactions, [
        { hash: '0x1111111111111111111111111111111111111111111111111111111111111111', chain: '56', type: 'source' },
        { hash: '0x2222222222222222222222222222222222222222222222222222222222222222', chain: '137', type: 'destination' }
      ])
    })

  it('maps order-id status responses without treating the order id as a source hash', async () => {
      const fetch = makeFetch({
        '/api/queryCrossInfoByOrderId': async (url) => {
          assert.equal(url.searchParams.get('orderId'), 'order-1')
          return {
            code: 200,
            message: 'success',
            data: {
              info: {
                state: 1,
                sourceHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
                toHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
                fromChain: { chainId: '56' },
                toChain: { chainId: '137' }
              }
            }
          }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch
      })
  
      const status = await protocol.getSwidgeStatus('order-1', { byOrderId: true, fromChain: 56, toChain: 137 })
  
      assert.equal(status.status, 'completed')
      assert.deepEqual(status.transactions, [
        { hash: '0x1111111111111111111111111111111111111111111111111111111111111111', chain: '56', type: 'source' },
        { hash: '0x2222222222222222222222222222222222222222222222222222222222222222', chain: '137', type: 'destination' }
      ])
    })

  it('maps documented Butter states and conservatively treats unknown states as pending', async () => {
      const cases: Array<[unknown, string]> = [
        [0, 'pending'],
        ['crossing', 'pending'],
        [1, 'completed'],
        [6, 'refunded'],
        // Undocumented/intermediate codes must not be reported as terminal: an
        // in-flight relaying state (2) or any unknown code stays pending.
        [2, 'pending'],
        [3, 'pending'],
        [99, 'pending'],
        ['weird-state', 'pending']
      ]
      for (const [state, expected] of cases) {
        const fetch = makeFetch({
          '/api/queryBridgeInfoBySourceHash': async () => ({
            code: 200,
            message: 'success',
            data: { info: { state, sourceHash: '0x1111111111111111111111111111111111111111111111111111111111111111' } }
          })
        })
        const protocol = new ButterSwidgeProtocol(undefined, {
          sourceChainId: 56,
          entrance: 'wdk',
          apiKeyId: 'key',
          apiSecret: 'secret',
          fetch
        })
  
        assert.equal((await protocol.getSwidgeStatus('0x1111111111111111111111111111111111111111111111111111111111111111')).status, expected)
      }
    })

  it('rejects a status response with no swidge info or state', async () => {
      for (const [data, message] of [
        [{}, 'Butter returned no swidge for the requested id'],
        [{ info: {} }, 'Butter returned no swidge for the requested id'],
        [{ info: { sourceHash: '0x1111111111111111111111111111111111111111111111111111111111111111' } }, 'Butter status response is missing a state']
      ] as const) {
        const fetch = makeFetch({
          '/api/queryBridgeInfoBySourceHash': async () => ({ code: 200, message: 'success', data })
        })
        const protocol = new ButterSwidgeProtocol(undefined, {
          sourceChainId: 56,
          entrance: 'wdk',
          apiKeyId: 'key',
          apiSecret: 'secret',
          fetch
        })
  
        await assert.rejects(protocol.getSwidgeStatus('0x1111111111111111111111111111111111111111111111111111111111111111'), { name: 'ButterApiError', message })
      }
    })

  it('does not fabricate a source transaction from an order id when Butter omits the source hash', async () => {
      const fetch = makeFetch({
        '/api/queryCrossInfoByOrderId': async (url) => {
          assert.equal(url.searchParams.get('orderId'), 'order-123')
          return { code: 200, message: 'success', data: { info: { state: 0 } } }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      const result = await protocol.getSwidgeStatus('order-123', { byOrderId: true })
      assert.equal(result.status, 'pending')
      // The order id must not be surfaced as a (fake) source transaction hash.
      assert.deepEqual(result.transactions, [])
    })

  it('uses the queried source hash when Butter omits it on a bySourceHash lookup', async () => {
      const fetch = makeFetch({
        '/api/queryBridgeInfoBySourceHash': async () => ({ code: 200, message: 'success', data: { info: { state: 1 } } })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      const result = await protocol.getSwidgeStatus('0x1111111111111111111111111111111111111111111111111111111111111111')
      assert.equal(result.status, 'completed')
      assert.deepEqual(result.transactions, [{ hash: '0x1111111111111111111111111111111111111111111111111111111111111111', type: 'source' }])
    })

  it('parses an array-shaped status response and a scalar chain id', async () => {
      const fetch = makeFetch({
        '/api/queryBridgeInfoBySourceHash': async () => ({
          code: 200,
          message: 'success',
          // Array shape + fromChain/toChain as bare scalars rather than objects.
          data: [{ state: 1, sourceHash: '0x1111111111111111111111111111111111111111111111111111111111111111', toHash: '0x7777777777777777777777777777777777777777777777777777777777777777', fromChain: 56, toChain: 137 }]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      const result = await protocol.getSwidgeStatus('0x1111111111111111111111111111111111111111111111111111111111111111')
      assert.equal(result.status, 'completed')
      assert.deepEqual(result.transactions, [
        { hash: '0x1111111111111111111111111111111111111111111111111111111111111111', chain: '56', type: 'source' },
        { hash: '0x7777777777777777777777777777777777777777777777777777777777777777', chain: '137', type: 'destination' }
      ])
    })

  it('derives same-chain swidge status from the transaction receipt', async () => {
      const cases: Array<[unknown, string]> = [
        [{ status: 'success' }, 'completed'],
        [{ status: 'reverted' }, 'failed'],
        [null, 'pending']
      ]
      for (const [receipt, expected] of cases) {
        const fetch = makeFetch({})
        const protocol = new ButterSwidgeProtocol(undefined, {
          sourceChainId: 56,
          entrance: 'wdk',
          fetch,
          evm: {
            publicClient: {
              async readContract () { return 0n },
              async getTransaction () { return { input: sameChainSwapDataFor(ERC20_TOKEN, 1n), to: ROUTER } },
              async getTransactionReceipt () { return receipt as never }
            }
          }
        })
  
        const result = await protocol.getSwidgeStatus('0x1111111111111111111111111111111111111111111111111111111111111111', { fromChain: 56, toChain: 56 })
        assert.equal(result.status, expected)
        // No cross-chain API is queried for a same-chain status.
        assert.equal(fetch.calls.length, 0)
      }
    })

  it('fails closed on a same-chain receipt with an unknown or missing status', async () => {
      // A mined receipt whose status we cannot interpret must NOT be reported as
      // completed (fail-open); it maps conservatively to pending.
      const cases: Array<[unknown, string]> = [
        [{ status: '0x2' }, 'pending'],
        [{ status: 2 }, 'pending'],
        [{}, 'pending'],
        [{ status: '0x1' }, 'completed'],
        [{ status: 1 }, 'completed'],
        [{ status: true }, 'completed'],
        [{ status: '0x0' }, 'failed'],
        [{ status: false }, 'failed']
      ]
      for (const [receipt, expected] of cases) {
        const protocol = new ButterSwidgeProtocol(undefined, {
          sourceChainId: 56,
          entrance: 'wdk',
          fetch: makeFetch({}),
          evm: {
            publicClient: {
              async readContract () { return 0n },
              async getTransaction () { return { input: sameChainSwapDataFor(ERC20_TOKEN, 1n), to: ROUTER } },
              async getTransactionReceipt () { return receipt as never }
            }
          }
        })
        const result = await protocol.getSwidgeStatus('0x1111111111111111111111111111111111111111111111111111111111111111', { fromChain: 56, toChain: 56 })
        assert.equal(result.status, expected, `receipt ${JSON.stringify(receipt)} -> ${expected}`)
      }
    })

  it('routes same-chain status statelessly by decoding a swapAndCall source tx (no hints, fresh instance)', async () => {
      const fetch = makeFetch({}) // the cross-chain API must not be called
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        evm: {
          publicClient: {
            readContract: async () => 0n,
            getTransaction: async () => ({ input: sameChainSwapDataFor(ERC20_TOKEN, 1000n), to: ROUTER }),
            getTransactionReceipt: async () => ({ status: 'success' })
          }
        }
      })
  
      const status = await protocol.getSwidgeStatus('0x1111111111111111111111111111111111111111111111111111111111111111')
      assert.equal(status.status, 'completed')
      assert.equal(fetch.calls.length, 0)
    })

  it('routes cross-chain status to the cross API when the source tx is swapAndBridge (no hints)', async () => {
      let appCalled = false
      const fetch = makeFetch({
        '/api/queryBridgeInfoBySourceHash': async () => {
          appCalled = true
          return { code: 200, message: 'ok', data: { state: 1, fromChain: { chainId: '56' }, toChain: { chainId: '137' }, sourceHash: '0x1111111111111111111111111111111111111111111111111111111111111111', toHash: '0x7777777777777777777777777777777777777777777777777777777777777777' } }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        evm: {
          publicClient: {
            readContract: async () => 0n,
            getTransaction: async () => ({ input: crossChainSwapData(ERC20_TOKEN, 1000n), to: ROUTER })
          }
        }
      })
  
      const status = await protocol.getSwidgeStatus('0x1111111111111111111111111111111111111111111111111111111111111111')
      assert.equal(appCalled, true)
      assert.equal(status.status, 'completed')
    })

  it('requires a receipt source for same-chain status', async () => {
      const fetch = makeFetch({})
      // Attribution succeeds (Router swapAndCall) but there is no receipt source.
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        evm: { publicClient: { readContract: async () => 0n, getTransaction: async () => ({ input: sameChainSwapDataFor(ERC20_TOKEN, 1n), to: ROUTER }) } }
      })
  
      await assert.rejects(
        protocol.getSwidgeStatus('0x1111111111111111111111111111111111111111111111111111111111111111', { fromChain: 56, toChain: 56 }),
        { name: 'ButterConfigurationError', message: 'Same-chain swidge status requires evm.publicClient or an account with getTransactionReceipt' }
      )
    })

  it('propagates an infrastructure error from Router attribution instead of silently falling back to the cross API', async () => {
      // Had attribution swallowed the RPC error, the id would fall through to the
      // cross API and resolve as completed. The node fault must surface instead.
      const fetch = makeFetch({
        '/api/queryBridgeInfoBySourceHash': async () => ({
          code: 200, message: 'success', data: { info: { state: 'completed', sourceHash: '0x1111111111111111111111111111111111111111111111111111111111111111' } }
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        evm: {
          publicClient: {
            readContract: async () => 0n,
            getTransaction: async () => { throw new Error('RPC unavailable') }
          }
        }
      })
  
      await assert.rejects(protocol.getSwidgeStatus('0x1111111111111111111111111111111111111111111111111111111111111111'), { name: 'Error', message: 'RPC unavailable' })
    })
})
