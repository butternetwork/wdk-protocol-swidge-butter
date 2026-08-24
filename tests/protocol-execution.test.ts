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

  it('executes without requiring a previous quote', async () => {
      const sent: unknown[] = []
      const fetch = makeFetch({
        '/route': async (url) => {
          assert.deepEqual(Object.fromEntries(url.searchParams), {
            fromChainId: '56',
            toChainId: '137',
            amount: '1.5',
            tokenInAddress: NATIVE_TOKEN,
            tokenOutAddress: DEST_TOKEN,
            type: 'exactIn',
            slippage: '200',
            receiver: VALID_RECIPIENT,
            entrance: 'wdk'
          })
          return {
            errno: 0,
            message: 'success',
            data: [quoteRoute({
              swapFee: { nativeFee: '0', tokenFee: '0' },
              srcChain: sourceChainWithToken(NATIVE_TOKEN),
              dstChain: {
                chainId: '137',
                tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
                totalAmountOut: '10.25'
              }
            })]
          }
        },
        '/swap': async (url) => {
          assert.deepEqual(Object.fromEntries(url.searchParams), {
            hash: '0x3333333333333333333333333333333333333333333333333333333333333333',
            slippage: '200',
            from: VALID_SENDER,
            receiver: VALID_RECIPIENT
          })
          return {
            errno: 0,
            message: 'success',
            data: [{
              to: ROUTER,
              value: '1500000000000000000',
              data: crossChainSwapData(NATIVE_TOKEN, 1500000000000000000n),
              chainId: '56',
              method: 'swapAndBridge'
            }]
          }
        }
      })
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        maxNativeFee: 0n,
        evm: {
          walletClient: evmWallet(async (transaction) => {
            sent.push(transaction)
            return '0x1111111111111111111111111111111111111111111111111111111111111111'
          })
        }
      })
  
      const result = await protocol.swidge({
        fromToken: NATIVE_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
  
      assert.deepEqual(result, {
        id: '0x1111111111111111111111111111111111111111111111111111111111111111',
        hash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        fees: [
          {
            type: 'protocol',
            amount: 250000n,
            token: '0x00000000000000000000000000000000000000ee',
            chain: '56',
            included: true,
            description: 'Butter outbound bridge fee'
          },
          {
            type: 'network',
            amount: 100000000000000n,
            token: 'BNB',
            chain: '56',
            included: false,
            description: 'Estimated source chain gas fee'
          }
        ],
        transactions: [{
          hash: '0x1111111111111111111111111111111111111111111111111111111111111111',
          chain: '56',
          type: 'source'
        }],
        fromTokenAmount: 1500000000000000000n,
        toTokenAmount: 10250000n,
        toTokenAmountMin: 9500000n
      })
      assert.deepEqual(sent, [{
        to: ROUTER,
        value: 1500000000000000000n,
        data: crossChainSwapData(NATIVE_TOKEN, 1500000000000000000n),
        chainId: 56
      }])
    })

  it('falls back to the configured maxNativeFee when the call omits it', async () => {
      const fetch = nativeFeeFetch()
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        // One wei below the fee the calldata spends, so a call that silently ignored
        // the configured cap would succeed here instead of failing.
        maxNativeFee: NATIVE_FEE_PART - 1n,
        evm: { walletClient: evmWallet(async () => '0x1111111111111111111111111111111111111111111111111111111111111111') }
      })
  
      await assert.rejects(protocol.swidge(nativeFeeOptions()), { name: 'ButterTransactionValidationError', message: 'Butter /swap native fee exceeds the configured maxNativeFee' })
    })

  it('treats the former TON chain id as an unknown destination family', async () => {
      const fetch = makeFetch({})
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        maxNativeFee: 0n,
        evm: { walletClient: evmWallet(async () => '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd') }
      })
  
      await assert.rejects(protocol.swidge({
        fromToken: NATIVE_TOKEN,
        toToken: DEST_TOKEN,
        toChain: FORMER_TON_CHAIN_ID,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }), {
        name: 'ButterActionRequiredError',
        message: 'Butter requires an explicit recipient when the destination chain uses a different or unrecognized address format',
        details: {
          sourceChainId: '56',
          sourceFamily: 'evm',
          destinationChainId: FORMER_TON_CHAIN_ID,
          destinationFamily: 'unknown'
        }
      })
      assert.equal(fetch.calls.length, 0)
    })

  it('defaults the recipient to the sender for a same-family cross-chain swidge', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            swapFee: { nativeFee: '0', tokenFee: '0' },
            srcChain: sourceChainWithToken(NATIVE_TOKEN),
            dstChain: {
              chainId: '137',
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountOut: '10.25'
            }
          })]
        }),
        '/swap': async (url) => {
          // EVM -> EVM keeps the WDK default documented in the integration guide.
          assert.equal(url.searchParams.get('receiver'), VALID_SENDER)
          return {
            errno: 0,
            message: 'success',
            data: [{
              to: ROUTER,
              value: '1500000000000000000',
              data: crossChainSwapData(NATIVE_TOKEN, 1500000000000000000n, { destinationReceiver: VALID_SENDER }),
              chainId: '56',
              method: 'swapAndBridge'
            }]
          }
        }
      })
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        maxNativeFee: 0n,
        evm: { walletClient: evmWallet(async () => '0x1111111111111111111111111111111111111111111111111111111111111111') }
      })
  
      const result = await protocol.swidge({
        fromToken: NATIVE_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
  
      assert.equal(result.id, '0x1111111111111111111111111111111111111111111111111111111111111111')
    })

  it('rejects a multi-transaction adapter result that does not classify each transaction, broadcasting nothing', async () => {
      const bitcoinChain = '1360095883558913'
      let n = 0
      const protocol = new ButterSwidgeProtocol({
        getAddress: async () => 'btc-sender',
        sendTransaction: async () => `btc-hash-${++n}`
      }, {
        sourceChainId: bitcoinChain,
        entrance: 'wdk',
        fetch: multiTxAdapterFetch(bitcoinChain),
        transactionAdapters: { [bitcoinChain]: (tx) => tx } // bare, untyped
      })
  
      await assert.rejects(
        protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
        { name: 'ButterUnsupportedError', message: 'Adapter returned multiple transactions without an explicit type; return { transaction, type } for each so the source transaction is identifiable' }
      )
      // Classification runs before any send, so a rejected result leaves nothing
      // broadcast — a retry cannot double-execute an already-sent leg.
      assert.equal(n, 0)
    })

  it('rejects a multi-transaction adapter that declares more than one source, broadcasting nothing', async () => {
      const bitcoinChain = '1360095883558913'
      let n = 0
      const protocol = new ButterSwidgeProtocol({
        getAddress: async () => 'btc-sender',
        sendTransaction: async () => `btc-hash-${++n}`
      }, {
        sourceChainId: bitcoinChain,
        entrance: 'wdk',
        fetch: multiTxAdapterFetch(bitcoinChain),
        // Every leg claims to be the primary source: ambiguous, must be rejected.
        transactionAdapters: { [bitcoinChain]: (tx) => ({ transaction: tx, type: 'source' as const }) }
      })
  
      await assert.rejects(
        protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
        { name: 'ButterUnsupportedError', message: 'Adapter must produce exactly one source transaction, but produced 2' }
      )
      assert.equal(n, 0)
    })

  it('rejects an adapter that declares an illegal transaction type, broadcasting nothing', async () => {
      const bitcoinChain = '1360095883558913'
      let n = 0
      const protocol = new ButterSwidgeProtocol({
        getAddress: async () => 'btc-sender',
        sendTransaction: async () => `btc-hash-${++n}`
      }, {
        sourceChainId: bitcoinChain,
        entrance: 'wdk',
        fetch: multiTxAdapterFetch(bitcoinChain),
        transactionAdapters: {
          [bitcoinChain]: (tx) => tx.to === 'btc-deposit'
            ? { transaction: tx, type: 'source' as const }
            : { transaction: tx, type: 'primary' as never } // not a SwidgeTransaction role
        }
      })
  
      await assert.rejects(
        protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
        { name: 'ButterUnsupportedError', message: 'Adapter returned an unknown transaction type: primary' }
      )
      assert.equal(n, 0)
    })

  it('uses the adapter-declared primary (source) transaction as the swidge id', async () => {
      const bitcoinChain = '1360095883558913'
      let n = 0
      const protocol = new ButterSwidgeProtocol({
        getAddress: async () => 'btc-sender',
        sendTransaction: async () => `btc-hash-${++n}`
      }, {
        sourceChainId: bitcoinChain,
        entrance: 'wdk',
        fetch: multiTxAdapterFetch(bitcoinChain),
        transactionAdapters: {
          [bitcoinChain]: (tx) => tx.to === 'btc-deposit'
            ? { transaction: tx, type: 'source' as const }
            : { transaction: tx, type: 'other' as const }
        }
      })
  
      const result = await protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n })
      // The deposit (source) is the second send → 'btc-hash-2', and is the id.
      assert.equal(result.id, 'btc-hash-2')
      assert.deepEqual(result.transactions?.map((tx) => tx.type), ['other', 'source'])
    })

  it('reports the broadcast adapter transaction when it reports an unusable fee', async () => {
      const bitcoinChain = '1360095883558913'
      let n = 0
      const protocol = new ButterSwidgeProtocol({
        getAddress: async () => 'btc-sender',
        // A number fee passes `< 0n` and would poison the bigint total with a raw
        // TypeError raised outside the loop, discarding every broadcast hash.
        sendTransaction: async () => ({ hash: `btc-hash-${++n}`, fee: 1 as unknown as bigint })
      }, {
        sourceChainId: bitcoinChain,
        entrance: 'wdk',
        fetch: multiTxAdapterFetch(bitcoinChain),
        transactionAdapters: {
          [bitcoinChain]: (tx) => tx.to === 'btc-deposit'
            ? { transaction: tx, type: 'source' as const }
            : { transaction: tx, type: 'other' as const }
        }
      })
  
      await assert.rejects(
        protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
        (error: unknown) => {
          assertError(error, ButterPartialExecutionError, 'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
          assert.deepEqual(error.transactions, [{ hash: 'btc-hash-1', chain: bitcoinChain, type: 'other' }])
          assertError(error.cause, ButterApiError, 'Transaction sender reported a non-bigint fee')
          return true
        }
      )
      // The second leg must not go out after the first one failed validation.
      assert.equal(n, 1)
    })

  it('reports the first adapter leg when a later one returns an illegal hash', async () => {
      const bitcoinChain = '1360095883558913'
      let n = 0
      const protocol = new ButterSwidgeProtocol({
        getAddress: async () => 'btc-sender',
        // An adapter is host-supplied too, so the declared string hash is not a
        // runtime guarantee; the already-broadcast first leg must survive it.
        sendTransaction: async () => ++n === 1 ? 'btc-hash-1' : { hash: 123 as unknown as string }
      }, {
        sourceChainId: bitcoinChain,
        entrance: 'wdk',
        fetch: multiTxAdapterFetch(bitcoinChain),
        transactionAdapters: {
          [bitcoinChain]: (tx) => tx.to === 'btc-deposit'
            ? { transaction: tx, type: 'source' as const }
            : { transaction: tx, type: 'other' as const }
        }
      })
  
      await assert.rejects(
        protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
        (error: unknown) => {
          assertError(error, ButterPartialExecutionError, 'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
          assert.deepEqual(error.transactions, [{ hash: 'btc-hash-1', chain: bitcoinChain, type: 'other' }])
          assertError(error.cause, ButterConfigurationError, 'Transaction sender did not return a hash')
          return true
        }
      )
      assert.equal(n, 2)
    })

  it('reports the already-broadcast transactions when an adapter send fails mid-sequence', async () => {
      const bitcoinChain = '1360095883558913'
      const attempted: string[] = []
      const rejected = new Error('wallet rejected the deposit')
      const protocol = new ButterSwidgeProtocol({
        getAddress: async () => 'btc-sender',
        async sendTransaction (tx) {
          const to = (tx as { to: string }).to
          attempted.push(to)
          if (to === 'btc-deposit') throw rejected
          return `hash-${to}`
        }
      }, {
        sourceChainId: bitcoinChain,
        entrance: 'wdk',
        fetch: threeTxAdapterFetch(bitcoinChain, '137'),
        transactionAdapters: { [bitcoinChain]: threeTxAdapter }
      })
  
      await assert.rejects(
        protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
        (error: unknown) => {
          assertError(error, ButterPartialExecutionError, 'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
          // The first leg is already on-chain; its hash must survive the failure so
          // the caller can inspect it instead of retrying into a double execution.
          assert.deepEqual(error.transactions, [{ hash: 'hash-btc-approval', chain: bitcoinChain, type: 'approval' }])
          assert.equal(error.cause, rejected)
          assert.equal(error.failedType, 'source')
          return true
        }
      )
      // Execution stops at the failure: the follow-up leg is never attempted.
      assert.deepEqual(attempted, ['btc-approval', 'btc-deposit'])
    })

  it('propagates the original error unwrapped when the first adapter send fails', async () => {
      const bitcoinChain = '1360095883558913'
      const rejected = new ButterConfigurationError('wallet is locked')
      const protocol = new ButterSwidgeProtocol({
        getAddress: async () => 'btc-sender',
        async sendTransaction () { throw rejected }
      }, {
        sourceChainId: bitcoinChain,
        entrance: 'wdk',
        fetch: threeTxAdapterFetch(bitcoinChain, '137'),
        transactionAdapters: { [bitcoinChain]: threeTxAdapter }
      })
  
      await assert.rejects(
        protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: 137, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
        (error: unknown) => {
          // Nothing was broadcast, so this is an ordinary failure — wrapping it as
          // partial execution would tell the caller to inspect a chain state that
          // does not exist, and would break callers matching the underlying type.
          assert.equal(error, rejected)
          return true
        }
      )
    })

  it('applies per-call fee limits before requesting swap data', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            bridgeFee: undefined,
            gasFee: { amount: '0.1', symbol: 'BNB' },
            swapFee: { nativeFee: '0', tokenFee: '0' },
            srcChain: sourceChainWithToken(NATIVE_TOKEN),
            dstChain: {
              chainId: '137',
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountOut: '10.25'
            }
          })]
        })
      })
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        maxNetworkFeeBps: 700,
        evm: { walletClient: evmWallet(async () => '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd') }
      })
  
      await assert.rejects(protocol.swidge({
        fromToken: NATIVE_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }, { maxNetworkFeeBps: 600 }), { name: 'ButterFeeLimitExceededError', message: 'Butter network fee exceeds the configured limit' })
      assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/swap').length, 0)
    })

  it('enforces the network fee cap against the caller amount, not a route-inflated input', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            // Route CLAIMS input 100 (=> gas 1/100 = 100 bps), but the user requests 1.
            gasFee: { amount: '1', symbol: 'BNB', inUSD: '1' },
            swapFee: { nativeFee: '0', tokenFee: '0' },
            bridgeFee: undefined,
            srcChain: {
              chainId: '56',
              tokenIn: { address: NATIVE_TOKEN, decimals: 18, symbol: 'BNB' },
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountIn: '100',
              totalAmountOut: '100'
            },
            dstChain: undefined,
            totalAmountInUSD: '100'
          })]
        })
      })
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000,
        maxNetworkFeeBps: 100,
        evm: { walletClient: evmWallet(async () => '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd') }
      })
  
      // Real ratio is gas 1 / input 1 = 10000 bps, which must exceed the 100 bps cap.
      await assert.rejects(protocol.swidge({
        fromToken: NATIVE_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 56,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1000000000000000000n
      }), { name: 'ButterFeeLimitExceededError', message: 'Butter network fee exceeds the configured limit' })
      assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/swap').length, 0)
    })

  it('does not accept native Router calldata for the removed ton token alias', async () => {
      const sent: unknown[] = []
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            srcChain: {
              chainId: '56',
              tokenIn: { address: 'ton', decimals: 18, symbol: 'TON' },
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountIn: '1.5',
              totalAmountOut: '10.25'
            },
            dstChain: undefined
          })]
        }),
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{
            to: ROUTER,
            value: '0',
            chainId: '56',
            data: sameChainSwapDataFor(NATIVE_TOKEN, 1500000000000000000n)
          }]
        })
      })
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: { ton: 18 },
        evm: {
          walletClient: evmWallet(async (tx) => {
            sent.push(tx)
            return '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
          })
        }
      })
  
      await assert.rejects(protocol.swidge({
        fromToken: 'ton',
        toToken: DEST_TOKEN,
        fromTokenAmount: 1500000000000000000n,
        recipient: VALID_RECIPIENT,
        slippage: 0.02
      }), {
        name: 'ButterTransactionValidationError',
        message: 'Butter Router source token does not match quote',
        details: { expected: 'ton', actual: NATIVE_TOKEN }
      })
      assert.deepEqual(sent, [])
    })

  it('reduces an oversized ERC20 allowance to the exact input via approve(0) then approve(amount)', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            gasFee: undefined,
            bridgeFee: undefined,
            swapFee: { nativeFee: '0', tokenFee: '0' },
            srcChain: {
              chainId: '56',
              tokenIn: { address: ERC20_TOKEN, decimals: 18, symbol: 'FROM' },
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountIn: '1.5',
              totalAmountOut: '10.25'
            },
            dstChain: undefined
          })]
        }),
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{ to: ROUTER, value: '0', data: sameChainSwapDataFor(ERC20_TOKEN, 1500000000000000000n), chainId: '56', method: 'swapAndCall' }]
        })
      })
      const sent: Array<{ data: `0x${string}` }> = []
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        now: () => 1000,
        tokenDecimals: ERC20_TOKEN_DECIMALS,
        evm: {
          publicClient: {
            // Existing allowance (2e18) exceeds the input (1.5e18).
            async readContract () { return 2000000000000000000n },
            async waitForTransactionReceipt () { return { status: 'success' } }
          },
          walletClient: evmWallet(async (tx) => { sent.push(tx as { data: `0x${string}` }); return '0x' + sent.length })
        }
      })
  
      const result = await protocol.swidge({
        fromToken: ERC20_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 56,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n
      })
  
      // Reset to 0, set to exact input, then swap.
      assert.equal(sent.length, 3)
      // Mapped rather than indexed so the elements stay non-optional under
      // noUncheckedIndexedAccess.
      assert.deepEqual(
        sent.slice(0, 2).map((tx) => decodeFunctionData({ abi: erc20Abi, data: tx.data }).args),
        [[ROUTER, 0n], [ROUTER, 1500000000000000000n]]
      )
      assert.deepEqual((result.transactions ?? []).map((tx) => tx.type), ['approval', 'approval', 'source'])
    })

  it('reports both broadcast approvals when the EVM swap send fails after them', async () => {
      const rejected = new Error('swap send rejected')
      const protocol = protocolFailingOnSend(account, 3, rejected)
  
      await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
        assertError(error, ButterPartialExecutionError, 'Butter execution failed after broadcasting 2 transaction(s); do not retry without inspecting them')
        assert.deepEqual(error.transactions, [
          { hash: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', chain: '56', type: 'approval' },
          { hash: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', chain: '56', type: 'approval' }
        ])
        assert.equal(error.cause, rejected)
        assert.equal(error.failedType, 'source')
        return true
      })
    })

  it('reports the broadcast approve(0) when the follow-up approve(amount) fails', async () => {
      const rejected = new Error('second approval rejected')
      const protocol = protocolFailingOnSend(account, 2, rejected)
  
      await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
        assertError(error, ButterPartialExecutionError, 'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
        // The allowance is now 0 on-chain: the caller must see that leg, or a
        // retry would re-run approve(0) against state it does not know about.
        assert.deepEqual(error.transactions, [{ hash: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', chain: '56', type: 'approval' }])
        assert.equal(error.cause, rejected)
        // The failure was in the approval stage, not the swap — preserved end to end.
        assert.equal(error.failedType, 'approval')
        return true
      })
    })

  it('propagates the original error unwrapped when the first EVM approval fails', async () => {
      const rejected = new ButterConfigurationError('wallet is locked')
      const protocol = protocolFailingOnSend(account, 1, rejected)
  
      await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
        // Nothing reached the chain, so this stays an ordinary failure.
        assert.equal(error, rejected)
        return true
      })
    })

  it('refuses ERC20 execution when no receipt source can confirm the approval', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            gasFee: undefined,
            bridgeFee: undefined,
            swapFee: { nativeFee: '0', tokenFee: '0' },
            srcChain: {
              chainId: '56',
              tokenIn: { address: ERC20_TOKEN, decimals: 18, symbol: 'FROM' },
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountIn: '1.5',
              totalAmountOut: '10.25'
            },
            dstChain: undefined
          })]
        }),
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{ to: ROUTER, value: '0', data: sameChainSwapDataFor(ERC20_TOKEN, 1500000000000000000n), chainId: '56', method: 'swapAndCall' }]
        })
      })
      const sent: unknown[] = []
      // account (beforeEach) has no getTransactionReceipt; publicClient has no
      // waitForTransactionReceipt → the approval could not be confirmed.
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        now: () => 1000,
        tokenDecimals: ERC20_TOKEN_DECIMALS,
        evm: {
          publicClient: { async readContract () { return 0n } },
          walletClient: evmWallet(async (tx) => { sent.push(tx); return '0x' + sent.length })
        }
      })
  
      await assert.rejects(
        protocol.swidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 56, recipient: VALID_RECIPIENT, fromTokenAmount: 1500000000000000000n }),
        { name: 'ButterConfigurationError', message: 'ERC20 approval requires a receipt source to confirm before the swap: provide evm.publicClient.waitForTransactionReceipt or a WDK account with getTransactionReceipt' }
      )
      // Nothing was submitted — no fire-and-forget approval.
      assert.equal(sent.length, 0)
    })

  it('rejects built-in EVM execution without an explicit EVM sender', async () => {
      // A bare WDK account cannot carry swap calldata: its Transaction type is only
      // { to, value }. EVM Router execution requires evm.walletClient/evm.sendTransaction.
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch: makeFetch({}),
        tokenDecimals: ERC20_TOKEN_DECIMALS
      })
      await assert.rejects(
        protocol.swidge({
          fromToken: ERC20_TOKEN,
          toToken: DEST_TOKEN,
          toChain: 56,
          recipient: VALID_RECIPIENT,
          fromTokenAmount: 1500000000000000000n
        }),
        { name: 'ButterReadOnlyAccountError', message: 'Butter EVM Router execution requires evm.walletClient to carry the swap calldata; the WDK account cannot (its Transaction type is only { to, value })' }
      )
    })

  it('executes with the example-style config: full WDK account + toEvmWalletClient', async () => {
      // Mirrors examples/swap.ts: a full WDK account (address + receipts) plus a
      // viem wallet client adapted via toEvmWalletClient. Guards against the example
      // regressing past the full-account execution precheck.
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            gasFee: undefined,
            bridgeFee: undefined,
            swapFee: { nativeFee: '0', tokenFee: '0' },
            srcChain: {
              chainId: '56',
              tokenIn: { address: NATIVE_TOKEN, decimals: 18, symbol: 'BNB' },
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountIn: '1.5',
              totalAmountOut: '10.25'
            },
            dstChain: undefined
          })]
        }),
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{ to: ROUTER, value: '1500000000000000000', data: sameChainSwapDataFor(NATIVE_TOKEN, 1500000000000000000n), chainId: '56', method: 'swapAndCall' }]
        })
      })
      const wdkAccount = {
        async getAddress () { return VALID_SENDER },
        async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') },
        async getTransactionReceipt () { return { status: 'success' } }
      }
      const protocol = new ButterSwidgeProtocol(wdkAccount, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        now: () => 1000,
        evm: {
          walletClient: toEvmWalletClient({ account: { address: VALID_SENDER }, sendTransaction: async () => '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}` })
        }
      })
  
      const result = await protocol.swidge({
        fromToken: NATIVE_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 56,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n
      })
      assert.equal(result.id, '0x1111111111111111111111111111111111111111111111111111111111111111')
    })

  it('executes ERC20 swidge with an explicit EVM sender, confirming approval via the account receipt', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            swapFee: { nativeFee: '0.01', tokenFee: '0' },
            srcChain: sourceChainWithToken(ERC20_TOKEN),
            dstChain: {
              chainId: '137',
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountOut: '10.25'
            }
          })]
        }),
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{
            to: ROUTER,
            // ERC20 input (no native) + routerFee 0.01e18 + bridgeFee 0.01e18
            value: '20000000000000000',
            data: crossChainSwapData(ERC20_TOKEN, 1500000000000000000n, { nativeFee: 10000000000000000n }),
            chainId: '56',
            method: 'swapAndBridge'
          }]
        })
      })
      const sent: unknown[] = []
      const receiptQueries: string[] = []
      // A full account (WDK-required) supplies the address and confirms the approval
      // receipt; the explicit EVM sender carries the calldata. account.sendTransaction
      // must never be used for EVM calldata.
      const accountOnly = {
        async getAddress () { return VALID_SENDER },
        async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') },
        async getTransactionReceipt (hash: string) {
          receiptQueries.push(hash)
          return { status: 'success' }
        }
      }
      const protocol = new ButterSwidgeProtocol(accountOnly, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000,
        tokenDecimals: ERC20_TOKEN_DECIMALS,
        maxNativeFee: 100000000000000000n,
        evm: {
          walletClient: evmWallet(async (tx) => {
            sent.push(tx)
            return sent.length === 1 ? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : '0x1111111111111111111111111111111111111111111111111111111111111111'
          })
        }
      })
  
      const result = await protocol.swidge({
        fromToken: ERC20_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
  
      // Without a publicClient the allowance read is skipped: an approval is
      // always submitted and confirmed via the account's own receipt lookup.
      assert.deepEqual(result.transactions, [
        { hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain: '56', type: 'approval' },
        { hash: '0x1111111111111111111111111111111111111111111111111111111111111111', chain: '56', type: 'source' }
      ])
      assert.equal(result.id, '0x1111111111111111111111111111111111111111111111111111111111111111')
      assert.equal(sent.length, 2)
      assert.deepEqual(receiptQueries, ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
      const approval = decodeFunctionData({ abi: erc20Abi, data: (sent[0] as { data: `0x${string}` }).data })
      assert.equal(approval.functionName, 'approve')
      assert.deepEqual(approval.args, [ROUTER, 1500000000000000000n])
    })

  it('reports the measured source gas fee when the EVM sender returns per-tx fees', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            gasFee: { amount: '0.0001', symbol: 'BNB' },
            swapFee: { nativeFee: '0', tokenFee: '0' },
            bridgeFee: undefined,
            srcChain: {
              chainId: '56',
              tokenIn: { address: ERC20_TOKEN, decimals: 18, symbol: 'FROM' },
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountIn: '1.5',
              totalAmountOut: '10.25'
            },
            dstChain: undefined
          })]
        }),
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{ to: ROUTER, value: '0', data: sameChainSwapDataFor(ERC20_TOKEN, 1500000000000000000n), chainId: '56', method: 'swapAndCall' }]
        })
      })
      let sends = 0
      const localAccount = {
        async getAddress () { return VALID_SENDER },
        async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') },
        async getTransactionReceipt () { return { status: 'success' } }
      }
      const protocol = new ButterSwidgeProtocol(localAccount, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: ERC20_TOKEN_DECIMALS,
        evm: {
          walletClient: evmWallet(async () => {
            sends++
            return sends === 1 ? { hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fee: 21000n } : { hash: '0x1111111111111111111111111111111111111111111111111111111111111111', fee: 50000n }
          })
        }
      })
  
      const result = await protocol.swidge({
        fromToken: ERC20_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 56,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n
      })
  
      // The estimated gas fee (0.0001e18) is replaced by the measured total
      // (approval 21000 + source 50000).
      const network = result.fees.find((fee) => fee.type === 'network')
      assert.equal(network?.amount, 71000n)
    })

  it('keeps the route gas estimate when only some sends report a fee', async () => {
      let sends = 0
      const localAccount = {
        async getAddress () { return VALID_SENDER },
        async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') },
        async getTransactionReceipt () { return { status: 'success' } }
      }
      const protocol = new ButterSwidgeProtocol(localAccount, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch: sameChainErc20Fetch(),
        tokenDecimals: ERC20_TOKEN_DECIMALS,
        evm: {
          walletClient: evmWallet(async () => {
            sends++
            // Approval reports a fee; the source send returns only a hash.
            return sends === 1 ? { hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fee: 21000n } : '0x1111111111111111111111111111111111111111111111111111111111111111'
          })
        }
      })
  
      const result = await protocol.swidge({
        fromToken: ERC20_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 56,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n
      })
  
      // Not every send was measured, so the network fee stays the route estimate
      // (0.0001e18), never a partial 21000.
      const network = result.fees.find((fee) => fee.type === 'network')
      assert.equal(network?.amount, 100000000000000n)
    })

  it('reports the broadcast approval when the sender returns a negative gas fee', async () => {
      const protocol = erc20FeeProtocol(async () => ({ hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fee: -1n }))
  
      await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
        // The fee is unusable but the approval is already on-chain: the hash is
        // what the caller needs, so it must not be lost to the fee check.
        assertError(error, ButterPartialExecutionError, 'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
        assert.deepEqual(error.transactions, [{ hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain: '56', type: 'approval' }])
        assert.equal(error.failedType, 'approval')
        assertError(error.cause, ButterApiError, 'Transaction sender reported a negative fee')
        return true
      })
    })

  it('reports the broadcast approval when the sender returns a non-bigint gas fee', async () => {
      // A host wallet client is plain JS at runtime, so `fee` can be a number; it
      // slips past a bare `< 0n` test and would otherwise surface as a TypeError
      // from the bigint sum, with no transactions attached.
      const protocol = erc20FeeProtocol(async () => ({ hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fee: 1 as unknown as bigint }))
  
      await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
        assertError(error, ButterPartialExecutionError, 'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
        assert.deepEqual(error.transactions, [{ hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain: '56', type: 'approval' }])
        assertError(error.cause, ButterApiError, 'Transaction sender reported a non-bigint fee')
        return true
      })
    })

  it('reports both legs when the source send reports an unusable fee', async () => {
      let sends = 0
      const protocol = erc20FeeProtocol(async () => {
        sends++
        return sends === 1 ? { hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fee: 21000n } : { hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fee: -1n }
      })
  
      await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
        assertError(error, ButterPartialExecutionError, 'Butter execution failed after broadcasting 2 transaction(s); do not retry without inspecting them')
        assert.deepEqual(error.transactions, [
          { hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain: '56', type: 'approval' },
          { hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', chain: '56', type: 'source' }
        ])
        assert.equal(error.failedType, 'source')
        return true
      })
    })

  it('propagates unwrapped when the sender returns no hash at all', async () => {
      // Broadcast, but unidentifiable — there is no hash to report, so this stays
      // an ordinary configuration failure rather than a partial execution.
      const protocol = erc20FeeProtocol(async () => ({ fee: 21000n }))
  
      await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
        assertError(error, ButterConfigurationError, 'Transaction sender did not return a hash')
        return true
      })
    })

  it('rejects an empty transaction hash instead of executing with an empty id', async () => {
      // An empty string is truthy-adjacent enough to slip through a bare `!hash`
      // test, and `''.toLowerCase()` never throws — so this used to resolve
      // successfully with an unusable `id: ''`.
      const protocol = erc20FeeProtocol(async () => '')
  
      await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
        assertError(error, ButterConfigurationError, 'Transaction sender returned an empty transaction hash')
        return true
      })
    })

  it('rejects a non-string transaction hash rather than failing later on toLowerCase', async () => {
      // A host wallet client is plain JS at runtime, so `hash` can be a number. It
      // used to be recorded as-is and then blow up in rememberOperationKind — and
      // because the partial-execution reporter calls that too, the report itself
      // threw and the caller got a bare TypeError.
      const protocol = erc20FeeProtocol(async () => ({ hash: 123 as unknown as string, fee: 1n }))
  
      await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
        assertError(error, ButterConfigurationError, 'Transaction sender did not return a hash')
        return true
      })
    })

  it('reports the broadcast approval when the source send returns an illegal hash', async () => {
      let sends = 0
      const protocol = erc20FeeProtocol(async () => {
        sends++
        return sends === 1 ? { hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fee: 21000n } : { hash: 123 as unknown as string }
      })
  
      await assert.rejects(protocol.swidge(sameChainErc20Options), (error: unknown) => {
        // The approval is on-chain and identifiable; only the source hash is
        // unusable, so the caller still gets what was broadcast.
        assertError(error, ButterPartialExecutionError, 'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
        assert.deepEqual(error.transactions, [{ hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain: '56', type: 'approval' }])
        assert.equal(error.failedType, 'source')
        assertError(error.cause, ButterConfigurationError, 'Transaction sender did not return a hash')
        return true
      })
    })

  it('times out when an account-confirmed approval never lands', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            swapFee: { nativeFee: '0', tokenFee: '0' },
            srcChain: sourceChainWithToken(ERC20_TOKEN),
            dstChain: {
              chainId: '137',
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountOut: '10.25'
            }
          })]
        }),
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{
            to: ROUTER,
            value: '0',
            data: crossChainSwapData(ERC20_TOKEN, 1500000000000000000n),
            chainId: '56',
            method: 'swapAndBridge'
          }]
        })
      })
      const protocol = new ButterSwidgeProtocol({
        async getAddress () { return VALID_SENDER },
        async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') },
        async getTransactionReceipt () { return null }
      }, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000,
        maxNativeFee: 0n,
        tokenDecimals: ERC20_TOKEN_DECIMALS,
        evm: { walletClient: evmWallet(async () => '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), approvalTimeoutMs: 20 }
      })
  
      await assert.rejects(protocol.swidge({
        fromToken: ERC20_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }), (error: unknown) => {
        // The approval is already broadcast and may still land, so the timeout is
        // reported as a partial execution carrying its hash — not a bare timeout.
        assertError(error, ButterPartialExecutionError, 'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
        assert.deepEqual(error.transactions, [{ hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain: '56', type: 'approval' }])
        assert.equal(error.failedType, 'approval')
        assertError(error.cause, ButterConfigurationError, 'Timed out waiting for the ERC20 approval to confirm')
        return true
      })
    })

  it('bounds a public-client approval wait and reports the broadcast hash', async () => {
      const protocol = new ButterSwidgeProtocol({
        async getAddress () { return VALID_SENDER },
        async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') }
      }, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch: sameChainErc20Fetch(),
        tokenDecimals: ERC20_TOKEN_DECIMALS,
        evm: {
          approvalTimeoutMs: 5,
          walletClient: evmWallet(async () => '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
          publicClient: {
            async readContract () { return 0n },
            async waitForTransactionReceipt (args) {
              assert.equal(args.timeout, 5)
              return await new Promise(() => {})
            }
          }
        }
      })
  
      await assert.rejects(Promise.race([protocol.swidge(sameChainErc20Options), failAfter(100)]), (error: unknown) => {
        assertError(error, ButterPartialExecutionError, 'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
        assert.deepEqual(error.transactions, [{ hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain: '56', type: 'approval' }])
        assert.equal(error.failedType, 'approval')
        assertError(error.cause, ButterConfigurationError, 'Timed out waiting for the ERC20 approval to confirm')
        return true
      })
    })

  it('bounds a single fallback receipt lookup and reports the broadcast hash', async () => {
      const protocol = new ButterSwidgeProtocol({
        async getAddress () { return VALID_SENDER },
        async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') },
        async getTransactionReceipt () { return await new Promise(() => {}) }
      }, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch: sameChainErc20Fetch(),
        tokenDecimals: ERC20_TOKEN_DECIMALS,
        evm: {
          approvalTimeoutMs: 5,
          walletClient: evmWallet(async () => '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
        }
      })
  
      await assert.rejects(Promise.race([protocol.swidge(sameChainErc20Options), failAfter(100)]), (error: unknown) => {
        assertError(error, ButterPartialExecutionError, 'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
        assert.deepEqual(error.transactions, [{ hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain: '56', type: 'approval' }])
        assert.equal(error.failedType, 'approval')
        assertError(error.cause, ButterConfigurationError, 'Timed out waiting for the ERC20 approval to confirm')
        return true
      })
    })

  it('does not send the swap when the approval receipt has an unknown status (fail-closed)', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            swapFee: { nativeFee: '0', tokenFee: '0' },
            srcChain: sourceChainWithToken(ERC20_TOKEN),
            dstChain: {
              chainId: '137',
              tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
              totalAmountOut: '10.25'
            }
          })]
        }),
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{ to: ROUTER, value: '0', data: crossChainSwapData(ERC20_TOKEN, 1500000000000000000n), chainId: '56', method: 'swapAndBridge' }]
        })
      })
      const sent: unknown[] = []
      const protocol = new ButterSwidgeProtocol({
        async getAddress () { return VALID_SENDER },
        async sendTransaction () { throw new Error('account.sendTransaction must not carry EVM calldata') },
        // Present but uninterpretable status must NOT be treated as confirmed.
        async getTransactionReceipt () { return {} }
      }, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000,
        maxNativeFee: 0n,
        tokenDecimals: ERC20_TOKEN_DECIMALS,
        evm: {
          walletClient: evmWallet(async (tx) => { sent.push(tx); return '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
          approvalTimeoutMs: 20
        }
      })
  
      await assert.rejects(protocol.swidge({
        fromToken: ERC20_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }), (error: unknown) => {
        assertError(error, ButterPartialExecutionError, 'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
        assert.deepEqual(error.transactions, [{ hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain: '56', type: 'approval' }])
        assert.equal(error.failedType, 'approval')
        assertError(error.cause, ButterConfigurationError, 'Timed out waiting for the ERC20 approval to confirm')
        return true
      })
      // Only the approval was submitted; the swap must not follow an unconfirmed approval.
      assert.equal(sent.length, 1)
    })

  it('aborts the swap when the ERC20 approval reverts', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            swapFee: { nativeFee: '0', tokenFee: '0' },
            srcChain: sourceChainWithToken(ERC20_TOKEN),
            dstChain: { chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' }, totalAmountOut: '10.25' }
          })]
        }),
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{ to: ROUTER, value: '0', data: crossChainSwapData(ERC20_TOKEN, 1500000000000000000n), chainId: '56', method: 'swapAndBridge' }]
        })
      })
      const sent: unknown[] = []
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        now: () => 1000,
        maxNativeFee: 0n,
        tokenDecimals: ERC20_TOKEN_DECIMALS,
        evm: {
          publicClient: {
            async readContract () { return 0n },
            async waitForTransactionReceipt () { return { status: 'reverted' } }
          },
          walletClient: evmWallet(async (tx) => { sent.push(tx); return '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
        }
      })
  
      await assert.rejects(
        protocol.swidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, recipient: VALID_RECIPIENT, fromTokenAmount: 1500000000000000000n, slippage: 0.02 }),
        (error: unknown) => {
          // The reverted approval is a real on-chain transaction; report its hash
          // rather than discarding it with the stack frame.
          assertError(error, ButterPartialExecutionError, 'Butter execution failed after broadcasting 1 transaction(s); do not retry without inspecting them')
          assert.deepEqual(error.transactions, [{ hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain: '56', type: 'approval' }])
          assert.equal(error.failedType, 'approval')
          assertError(error.cause, ButterConfigurationError, 'ERC20 approval transaction reverted')
          return true
        }
      )
      // Only the approval was sent; the swap must not follow a reverted approval.
      assert.equal(sent.length, 1)
    })

  it('rejects EVM execution with no full account before any network call', async () => {
      const fetch = makeFetch({})
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        evm: { walletClient: evmWallet(async () => '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd') }
      })
  
      await assert.rejects(
        protocol.swidge({ fromToken: NATIVE_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }),
        { name: 'ButterReadOnlyAccountError', message: 'Swidge execution requires an account or signer that can send transactions' }
      )
      assert.equal(fetch.calls.length, 0)
    })

  it('rejects when account and evm.walletClient sender addresses diverge', async () => {
      const fetch = makeFetch({
        '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute()] })
      })
      const protocol = new ButterSwidgeProtocol({ getAddress: async () => VALID_SENDER, sendTransaction: async () => '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' }, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS,
        evm: { walletClient: { account: { address: VALID_RECIPIENT }, sendTransaction: async () => '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' } }
      })
  
      await assert.rejects(
        protocol.swidge({ fromToken: '0x00000000000000000000000000000000000000ab', toToken: '0x00000000000000000000000000000000000000cd', toChain: 137, fromTokenAmount: 1500000000000000000n, slippage: 0.02 }),
        { name: 'ButterConfigurationError', message: 'Account address and evm.walletClient account address differ; configure a single sender' }
      )
    })

  it('rejects a stale or unknown pinned routeHash instead of silently re-quoting', async () => {
      const fetch = makeFetch({
        '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute()] })
      })
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        now: () => 1000,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS,
        evm: { walletClient: evmWallet(async () => '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd') }
      })
  
      // No prior quote cached this hash: execution must fail, not re-quote.
      await assert.rejects(
        protocol.swidge({
          fromToken: '0x00000000000000000000000000000000000000ab',
          toToken: '0x00000000000000000000000000000000000000cd',
          toChain: 137,
          recipient: VALID_RECIPIENT,
          fromTokenAmount: 1500000000000000000n,
          slippage: 0.02,
          routeHash: '0x8888888888888888888888888888888888888888888888888888888888888888'
        }),
        { name: 'ButterActionRequiredError', message: 'Pinned Butter quote expires too soon to execute or does not match the request; request a new quote' }
      )
      assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 0)
      assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/swap').length, 0)
    })

  it('rejects read-only execution before requesting a route', async () => {
      const fetch = makeFetch({})
      const protocol = new ButterSwidgeProtocol({ getAddress: async () => VALID_SENDER }, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch
      })
  
      await assert.rejects(protocol.swidge({
        fromToken: NATIVE_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        fromTokenAmount: 1n,
        slippage: 0.02
      }), { name: 'ButterReadOnlyAccountError', message: 'Swidge execution requires an account or signer that can send transactions' })
      assert.equal(fetch.calls.length, 0)
    })

  it('executes the former TON chain id through a generic adapter', async () => {
      let requestedSlippage: string | null = null
      const fetch = makeFetch({
        '/route': async (url) => {
          requestedSlippage = url.searchParams.get('slippage')
          return {
            errno: 0,
            message: 'success',
            data: [quoteRoute({
              contract: undefined,
              bridgeFee: undefined,
              gasFee: undefined,
              swapFee: undefined,
              minAmountOut: { amount: '1.9', symbol: 'OUT' },
              srcChain: {
                chainId: FORMER_TON_CHAIN_ID,
                tokenIn: { address: 'asset', decimals: 6, symbol: 'ASSET' },
                tokenOut: { address: 'out', decimals: 6, symbol: 'OUT' },
                totalAmountIn: '1',
                totalAmountOut: '2'
              },
              dstChain: undefined
            })]
          }
        },
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{
            to: 'adapter-target',
            value: '1000',
            memo: 'generic-unknown-chain',
            chainId: FORMER_TON_CHAIN_ID
          }]
        })
      })
      const sent: unknown[] = []
      const protocol = new ButterSwidgeProtocol({
        async getAddress () { return 'unknown-chain-sender' },
        async sendTransaction (tx) {
          sent.push(tx)
          return { hash: 'unknown-chain-hash' }
        }
      }, {
        sourceChainId: FORMER_TON_CHAIN_ID,
        entrance: 'wdk',
        fetch,
        now: () => 1000,
        tokenDecimals: { asset: 6 },
        transactionAdapters: {
          [FORMER_TON_CHAIN_ID]: (swapTx) => ({
            to: swapTx.to,
            value: BigInt(swapTx.value),
            memo: swapTx.memo
          })
        }
      })
  
      const result = await protocol.swidge({
        fromToken: 'asset',
        toToken: 'out',
        fromTokenAmount: 1000000n,
        recipient: 'unknown-chain-recipient',
        slippage: 0.02
      })
  
      assert.equal(requestedSlippage, '200')
      assert.deepEqual(sent, [{
        to: 'adapter-target',
        value: 1000n,
        memo: 'generic-unknown-chain'
      }])
      assert.equal(result.id, 'unknown-chain-hash')
      assert.equal(result.hash, 'unknown-chain-hash')
      assert.deepEqual(result.fees, [{
        type: 'network',
        amount: 0n,
        token: 'native',
        chain: FORMER_TON_CHAIN_ID,
        included: false,
        description: 'Butter reported no fees for this route'
      }])
      assert.deepEqual(result.transactions, [{
        hash: 'unknown-chain-hash',
        chain: FORMER_TON_CHAIN_ID,
        type: 'source'
      }])
      assert.equal(result.fromTokenAmount, 1000000n)
      assert.equal(result.toTokenAmount, 2000000n)
      assert.equal(result.toTokenAmountMin, 1900000n)
    })

  for (const recipient of [undefined, '', '   '] as const) {
      it(`rejects a cross-VM swidge with recipient ${JSON.stringify(recipient)}`, async () => {
        // The WDK default (recipient = the account address) would send an EVM address
        // as the Solana destination receiver. `makeFetch` throws on any request, so
        // this also proves the rejection happens before /route.
        const fetch = makeFetch({})
        const protocol = new ButterSwidgeProtocol(account, {
          sourceChainId: 56,
          entrance: 'wdk',
          fetch,
          maxNativeFee: 0n,
          evm: { walletClient: evmWallet(async () => '0x1111111111111111111111111111111111111111111111111111111111111111') }
        })
  
        await assert.rejects(
          protocol.swidge({
            fromToken: NATIVE_TOKEN,
            toToken: 'So11111111111111111111111111111111111111112',
            toChain: SOLANA_CHAIN_ID,
            ...(recipient !== undefined ? { recipient } : {}),
            fromTokenAmount: 1500000000000000000n,
            slippage: 0.02
          }),
          { name: 'ButterActionRequiredError', message: 'Butter requires an explicit recipient when the destination chain uses a different or unrecognized address format' }
        )
        assert.equal(fetch.calls.length, 0)
      })
    }
})
