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
} from '../../src/index.ts'
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
  dummyHash,
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
} from '../helpers/protocol-fixtures.js'

describe('@butternetwork/wdk-protocol-swidge-butter', () => {
  let account: { getAddress: () => Promise<string>, sendTransaction: (tx: unknown) => Promise<{ hash: string, tx: unknown }> }

  beforeEach(() => {
    account = {
      async getAddress () { return VALID_SENDER },
      async sendTransaction (tx) { return { hash: '0x1111111111111111111111111111111111111111111111111111111111111111', tx } }
    }
  })

  it('reports whether the destination minimum is enforced or only quoted', async () => {
      const fetch = makeFetch({
        '/route': async (url) => ({
          errno: 0,
          message: 'success',
          data: [url.searchParams.get('toChainId') === '56'
            ? quoteRoute({
                srcChain: {
                  chainId: '56',
                  tokenIn: { address: '0x00000000000000000000000000000000000000ab', decimals: 18, symbol: 'BNB' },
                  tokenOut: { address: '0x00000000000000000000000000000000000000cd', decimals: 6, symbol: 'USDT' },
                  totalAmountIn: '1.5',
                  totalAmountOut: '10.25'
                },
                dstChain: undefined
              })
            : quoteRoute()]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
      const base = { fromToken: '0x00000000000000000000000000000000000000ab', toToken: '0x00000000000000000000000000000000000000cd', fromTokenAmount: 1500000000000000000n, slippage: 0.02 }
  
      // Same-chain checks minAmount against the swapAndCall calldata, so the
      // minimum genuinely holds. Cross-chain leaves it in the nested bridge payload,
      // which is trusted to Butter — the caller can now see that difference in code
      // rather than only in the README.
      assert.equal((await protocol.quoteSwidge({ ...base, toChain: 56 })).destinationGuarantees, 'enforced')
      assert.equal((await protocol.quoteSwidge({ ...base, toChain: 137 })).destinationGuarantees, 'quoted-only')
      // Omitted toChain means same-chain.
      assert.equal((await protocol.quoteSwidge(base)).destinationGuarantees, 'enforced')
    })

  it('reports an unroutable pair as a no-route error, not a generic API error', async () => {
      const illiquidFetch = makeFetch({
        '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute({ hasLiquidity: false })] })
      })
      // Butter also signals this in-band: HTTP 200 with errno 2003.
      const noRouteFetch = makeFetch({
        '/route': async () => ({ errno: 2003, message: 'No Route Found' })
      })
      const options = {
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }
      const config = { sourceChainId: 56, entrance: 'wdk', tokenDecimals: DEFAULT_TOKEN_DECIMALS }
  
      await assert.rejects(
        new ButterSwidgeProtocol(undefined, { ...config, fetch: illiquidFetch }).quoteSwidge(options),
        { name: 'ButterNoRouteError', message: 'Butter router returned no liquid route' }
      )
      await assert.rejects(
        new ButterSwidgeProtocol(undefined, { ...config, fetch: noRouteFetch }).quoteSwidge(options),
        { name: 'ButterNoRouteError', message: 'No Route Found' }
      )
      // Still a ButterApiError subclass, so existing catch blocks keep working.
      await assert.rejects(
        new ButterSwidgeProtocol(undefined, { ...config, fetch: noRouteFetch }).quoteSwidge(options),
        { name: 'ButterNoRouteError', message: 'No Route Found' }
      )
    })

  it('sends the same validated slippage to /route and /swap', async () => {
      const fetch = makeFetch({
        '/route': async (url) => {
          assert.equal(url.searchParams.get('slippage'), '200')
          return {
            errno: 0,
            message: 'success',
            data: [quoteRoute({
              swapFee: { nativeFee: '0.01', tokenFee: '0' },
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
          assert.equal(url.searchParams.get('hash'), '0x3333333333333333333333333333333333333333333333333333333333333333')
          assert.equal(url.searchParams.get('slippage'), '200')
          assert.equal(url.searchParams.get('from'), VALID_SENDER)
          assert.equal(url.searchParams.get('receiver'), VALID_RECIPIENT)
          return {
            errno: 0,
            message: 'success',
            data: [{
              to: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A',
              // input 1.5e18 + routerFee 0.01e18 (swapFee.nativeFee) + bridgeFee 0.01e18
              value: '1520000000000000000',
              data: crossChainSwapData(NATIVE_TOKEN, 1500000000000000000n, { nativeFee: 10000000000000000n }),
              chainId: '56',
              method: 'swapAndBridge'
            }]
          }
        }
      })
      const sent: unknown[] = []
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000,
        maxNativeFee: 100000000000000000n,
        evm: {
          walletClient: evmWallet(async (tx) => {
            sent.push(tx)
            return '0x1111111111111111111111111111111111111111111111111111111111111111'
          })
        }
      })
  
      const options = {
        fromToken: NATIVE_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }
      await protocol.quoteSwidge(options)
      const result = await protocol.swidge(options)
  
      assert.equal(result.id, '0x1111111111111111111111111111111111111111111111111111111111111111')
      assert.deepEqual(result.transactions, [{ hash: '0x1111111111111111111111111111111111111111111111111111111111111111', chain: '56', type: 'source' }])
      assert.equal(sent.length, 1)
      assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 1)
    })

  it('prefers a per-call maxNativeFee over the configured one', async () => {
      // Both directions: a per-call cap must be able to loosen a configured one and
      // to tighten it. A single construction-time value cannot fit every trade size,
      // so an override that only ever tightened would not solve the problem.
      for (const [configured, perCall, expected] of [
        [0n, NATIVE_FEE_PART, 'accepted'],
        [NATIVE_FEE_PART, NATIVE_FEE_PART - 1n, 'rejected']
      ] as const) {
        const fetch = nativeFeeFetch()
        const protocol = new ButterSwidgeProtocol(account, {
          sourceChainId: 56,
          entrance: 'wdk',
          fetch,
          maxNativeFee: configured,
          evm: { walletClient: evmWallet(async () => '0x1111111111111111111111111111111111111111111111111111111111111111') }
        })
  
        if (expected === 'accepted') {
          const result = await protocol.swidge(nativeFeeOptions(perCall))
          assert.equal(result.id, '0x1111111111111111111111111111111111111111111111111111111111111111')
        } else {
          await assert.rejects(protocol.swidge(nativeFeeOptions(perCall)), { name: 'ButterTransactionValidationError', message: 'Butter /swap native fee exceeds the configured maxNativeFee' })
        }
      }
    })

  it('rejects a swidge to an unrecognized chain without an explicit recipient', async () => {
      // Butter adds chains between releases of this package. An unlisted chain must
      // not be assumed EVM: if it turns out to be a new non-EVM chain, the WDK default
      // would send a 0x sender as the destination receiver.
      const fetch = makeFetch({})
      const config = {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        maxNativeFee: 0n,
        evm: { walletClient: evmWallet(async () => '0x1111111111111111111111111111111111111111111111111111111111111111') }
      }
      const options = {
        fromToken: NATIVE_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 987654321,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }
  
      await assert.rejects(
        new ButterSwidgeProtocol(account, config).swidge(options),
        { name: 'ButterActionRequiredError', message: 'Butter requires an explicit recipient when the destination chain uses a different or unrecognized address format' }
      )
      assert.equal(fetch.calls.length, 0)
  
      // Declaring it EVM opts back into the WDK recipient default...
      await assert.rejects(
        new ButterSwidgeProtocol(account, { ...config, evmChainIds: [987654321] }).swidge(options),
        // ...so it now gets past the recipient gate and fails at the unstubbed /route.
        { name: 'Error', message: 'unexpected request: /route' }
      )
      // ...as does naming a recipient explicitly.
      await assert.rejects(
        new ButterSwidgeProtocol(account, config).swidge({ ...options, recipient: VALID_RECIPIENT }),
        { name: 'Error', message: 'unexpected request: /route' }
      )
    })

  it('rejects a legacy swap or quote that requests an exact output amount', async () => {
      const fetch = makeFetch({})
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS,
        evm: { walletClient: evmWallet(async () => '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd') }
      })
      const legacyExactOut = {
        tokenIn: '0x00000000000000000000000000000000000000ab',
        tokenOut: '0x00000000000000000000000000000000000000cd',
        tokenOutAmount: 10250000n,
        to: VALID_RECIPIENT
      }
  
      // The base class forwards `tokenOutAmount` as `toTokenAmount`, so this delegation
      // path is the only way exact-out is reachable at all — which is why it needs its
      // own coverage rather than relying on the swidge()-level test.
      await assert.rejects(protocol.swap(legacyExactOut), { name: 'ButterExactOutUnsupportedError', message: 'Butter router does not support exact-out swaps' })
      await assert.rejects(protocol.quoteSwap(legacyExactOut), { name: 'ButterExactOutUnsupportedError', message: 'Butter router does not support exact-out swaps' })
      assert.equal(fetch.calls.length, 0)
    })

  it('sums legacy scalar swap fees across every denomination', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            srcChain: {
              chainId: '56',
              tokenIn: { address: '0x00000000000000000000000000000000000000ab', decimals: 18, symbol: 'BNB' },
              tokenOut: { address: '0x00000000000000000000000000000000000000cd', decimals: 6, symbol: 'USDT' },
              totalAmountIn: '1.5',
              totalAmountOut: '10.25'
            },
            dstChain: undefined
          })]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
      const legacyOptions = {
        tokenIn: '0x00000000000000000000000000000000000000ab',
        tokenOut: '0x00000000000000000000000000000000000000cd',
        tokenInAmount: 1500000000000000000n,
        to: VALID_RECIPIENT
      }
  
      const quote = await protocol.quoteSwidge({
        fromToken: legacyOptions.tokenIn,
        toToken: legacyOptions.tokenOut,
        fromTokenAmount: legacyOptions.tokenInAmount,
        recipient: legacyOptions.to
      })
      const legacy = await protocol.quoteSwap(legacyOptions)
  
      // Known upstream defect (see CHANGELOG "Known upstream issue"): swap() and
      // quoteSwap() do not group by fee type at all — they add every amount together
      // regardless of currency. This pins the behavior so a WDK-side fix is noticed.
      assert.equal(legacy.fee, quote.fees.reduce((acc, fee) => acc + fee.amount, 0n))
      assert.equal(new Set(quote.fees.map((fee) => fee.token)).size, 3)
    })

  it('still resolves swidge status for a source transaction broadcast before a partial failure', async () => {
      const bitcoinChain = '1360095883558913'
      // makeFetch throws on any unregistered path, so falling back to the
      // cross-chain status API instead of the receipt would fail this test loudly.
      const fetch = threeTxAdapterFetch(bitcoinChain, bitcoinChain)
      const protocol = new ButterSwidgeProtocol({
        getAddress: async () => 'btc-sender',
        async sendTransaction (tx) {
          const to = (tx as { to: string }).to
          if (to === 'btc-followup') throw new Error('follow-up rejected')
          return `hash-${to}`
        },
        async getTransactionReceipt (hash) {
          assert.equal(hash, 'hash-btc-deposit')
          return { status: 'success' }
        }
      }, {
        sourceChainId: bitcoinChain,
        entrance: 'wdk',
        fetch,
        transactionAdapters: { [bitcoinChain]: threeTxAdapter }
      })
  
      await assert.rejects(
        protocol.swidge({ fromToken: 'btc', toToken: 'btc', toChain: bitcoinChain, recipient: 'btc-recipient', fromTokenAmount: 100000000n }),
        { name: 'ButterPartialExecutionError', message: 'Butter execution failed after broadcasting 2 transaction(s); do not retry without inspecting them' }
      )
  
      // The swidge is in flight even though swidge() threw, so its kind must have
      // been recorded before the throw for later status routing.
      const callsBefore = fetch.calls.length
      const status = await protocol.getSwidgeStatus('hash-btc-deposit')
      assert.equal(status.status, 'completed')
      assert.equal(fetch.calls.length, callsBefore)
    })

  it('refreshes an expired confirmed quote before execution', async () => {
      let now = 1000
      let routeRequests = 0
      const fetch = makeFetch({
        '/route': async () => {
          routeRequests++
          return {
            errno: 0,
            message: 'success',
            data: [quoteRoute({
              hash: dummyHash(routeRequests + 2),
              timestamp: now,
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
          assert.equal(url.searchParams.get('hash'), '0x4444444444444444444444444444444444444444444444444444444444444444')
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
        now: () => now,
        maxNativeFee: 0n,
        evm: { walletClient: evmWallet(async () => '0x1111111111111111111111111111111111111111111111111111111111111111') }
      })
      const options = {
        fromToken: NATIVE_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }
  
      await protocol.quoteSwidge(options)
      now = 1300
  
      const result = await protocol.swidge(options)
  
      assert.equal(result.id, '0x1111111111111111111111111111111111111111111111111111111111111111')
      assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 2)
    })

  it('re-fetches a route on the execution path when it expires within the execution margin', async () => {
      let now = 1000
      let routeRequests = 0
      const fetch = makeFetch({
        '/route': async () => {
          routeRequests++
          return {
            errno: 0,
            message: 'success',
            data: [quoteRoute({
              hash: dummyHash(routeRequests + 2),
              timestamp: now,
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
          // The nearly-stale route must not be the one /swap is asked to build.
          assert.equal(url.searchParams.get('hash'), '0x4444444444444444444444444444444444444444444444444444444444444444')
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
        fetch,
        now: () => now,
        maxNativeFee: 0n,
        evm: { walletClient: evmWallet(async () => '0x1111111111111111111111111111111111111111111111111111111111111111') }
      })
      const options = {
        fromToken: NATIVE_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }
  
      await protocol.quoteSwidge(options)
      // The route lives until 1300, so 20s remain: not expired, but nowhere near
      // enough to survive the /swap round-trip and the approval wait that follow.
      now = 1280
  
      const result = await protocol.swidge(options)
  
      assert.equal(result.id, '0x1111111111111111111111111111111111111111111111111111111111111111')
      assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 2)
    })

  it('reuses a route on the quote path when it expires within the execution margin', async () => {
      let now = 1000
      let routeRequests = 0
      const fetch = makeFetch({
        '/route': async () => {
          routeRequests++
          return {
            errno: 0,
            message: 'success',
            data: [quoteRoute({
              hash: dummyHash(routeRequests + 2),
              timestamp: now,
              swapFee: { nativeFee: '0', tokenFee: '0' },
              srcChain: sourceChainWithToken(NATIVE_TOKEN),
              dstChain: {
                chainId: '137',
                tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
                totalAmountOut: '10.25'
              }
            })]
          }
        }
      })
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        now: () => now,
        evm: { walletClient: evmWallet(async () => '0x1111111111111111111111111111111111111111111111111111111111111111') }
      })
      const options = {
        fromToken: NATIVE_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }
  
      const first = await protocol.quoteSwidge(options)
      // 30s remain: inside the 45s execution margin but outside the 15s quote
      // margin. A quote is non-binding, so it does not need the larger margin.
      now = 1270
      const second = await protocol.quoteSwidge(options)
  
      assert.equal(second.routeHash, first.routeHash)
      assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 1)
    })

  it('rejects a pinned routeHash that expires within the execution margin', async () => {
      let now = 1000
      const fetch = makeFetch({
        // No /swap handler: makeFetch throws on unregistered paths, so any attempt
        // to execute the nearly-stale pin fails this test loudly.
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            timestamp: now,
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
        fetch,
        now: () => now,
        maxNativeFee: 0n,
        evm: { walletClient: evmWallet(async () => '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd') }
      })
      const options = {
        fromToken: NATIVE_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }
  
      const quote = await protocol.quoteSwidge(options)
      now = 1280
  
      // A pin is the price the caller already approved, so it is never silently
      // re-fetched the way an unpinned execution is — the caller must re-quote.
      await assert.rejects(
        protocol.swidge({ ...options, routeHash: quote.routeHash }),
        { name: 'ButterActionRequiredError', message: 'Pinned Butter quote expires too soon to execute or does not match the request; request a new quote' }
      )
      assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 1)
    })

  it('rejects malicious swap targets outside the router allowlist before signing', async () => {
      const fetch = makeFetch({
        '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute({ contract: '0x000000000000000000000000000000000000dEaD' })] }),
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{ to: '0x000000000000000000000000000000000000dEaD', value: '0x0', data: '0xabcdef', chainId: '56', method: 'swapAndBridge' }]
        })
      })
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS,
        evm: {
          publicClient: { async readContract () { return 0n } },
          walletClient: evmWallet(async () => '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')
        }
      })
  
      const options = {
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '0x0000000000000000000000000000000000000222',
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }
      await protocol.quoteSwidge(options)
      await assert.rejects(protocol.swidge(options), { name: 'ButterTransactionValidationError', message: 'Butter router address is not allowlisted' })
    })

  it('rejects native swap data whose value exceeds the requested input amount', async () => {
      const fetch = makeFetch({
        '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute({ srcChain: sourceChainWithToken(NATIVE_TOKEN) })] }),
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{
            to: '0xEE0319cF0BCa5d09333f9F6277743E8De31bD69A',
            value: '0x29a2241af62c0000',
            data: '0xabcdef',
            chainId: '56',
            method: 'swapAndBridge'
          }]
        })
      })
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000,
        evm: { walletClient: evmWallet(async () => '0x1111111111111111111111111111111111111111111111111111111111111111') }
      })
  
      const options = {
        fromToken: NATIVE_TOKEN,
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '0x0000000000000000000000000000000000000222',
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }
      await protocol.quoteSwidge(options)
      await assert.rejects(protocol.swidge(options), { name: 'ButterTransactionValidationError', message: 'Butter /swap returned malformed or unsupported Router V3 calldata' })
    })

  it('checks ERC20 allowance, approves exact amount, waits, then swaps', async () => {
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
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000,
        tokenDecimals: ERC20_TOKEN_DECIMALS,
        maxNativeFee: 100000000000000000n,
        evm: {
          publicClient: {
            async readContract () { return 0n },
            async waitForTransactionReceipt (args) {
              assert.equal(args.hash, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
              assert.equal(args.timeout, 10_000)
              return { status: 'success' }
            }
          },
          walletClient: evmWallet(async (tx) => {
            sent.push(tx)
            return sent.length === 1 ? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : '0x1111111111111111111111111111111111111111111111111111111111111111'
          })
        }
      })
  
      const options = {
        fromToken: ERC20_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }
      await protocol.quoteSwidge(options)
      const result = await protocol.swidge(options)
  
      assert.deepEqual(result.transactions, [
        { hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', chain: '56', type: 'approval' },
        { hash: '0x1111111111111111111111111111111111111111111111111111111111111111', chain: '56', type: 'source' }
      ])
      assert.equal(sent.length, 2)
      const approval = decodeFunctionData({ abi: erc20Abi, data: (sent[0] as { data: `0x${string}` }).data })
      assert.equal(approval.functionName, 'approve')
      assert.equal(approval.args[1], 1500000000000000000n)
    })

  it('rejects EVM execution without a full WDK account even when an EVM sender is present', async () => {
      // WDK contract: swidge() must throw without a full (send-capable) account,
      // regardless of a configured EVM sender.
      const evm = { walletClient: evmWallet(async () => '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc') }
      const options = { fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 56, recipient: VALID_RECIPIENT, fromTokenAmount: 1500000000000000000n }
  
      const noAccount = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56, entrance: 'wdk', fetch: makeFetch({}), tokenDecimals: ERC20_TOKEN_DECIMALS, evm
      })
      await assert.rejects(noAccount.swidge(options), { name: 'ButterReadOnlyAccountError', message: 'Swidge execution requires an account or signer that can send transactions' })
  
      const readOnlyAccount = new ButterSwidgeProtocol({ async getAddress () { return VALID_SENDER } }, {
        sourceChainId: 56, entrance: 'wdk', fetch: makeFetch({}), tokenDecimals: ERC20_TOKEN_DECIMALS, evm
      })
      await assert.rejects(readOnlyAccount.swidge(options), { name: 'ButterReadOnlyAccountError', message: 'Swidge execution requires an account or signer that can send transactions' })
    })

  it('quotes a token omitted from the advertised catalog by resolving decimals through /findToken', async () => {
      const fetch = makeFetch({
        '/supportedTokenList': async () => ({
          errno: 0,
          message: 'success',
          data: [{ chainId: 56, tokens: [] }]
        }),
        '/findToken': async (url) => {
          assert.equal(url.searchParams.get('chainId'), '56')
          assert.equal(url.searchParams.get('address'), ERC20_TOKEN)
          return { errno: 0, message: 'success', data: [{ chainId: 56, address: ERC20_TOKEN, decimals: 18, symbol: 'FROM' }] }
        },
        '/route': async (url) => {
          assert.equal(url.searchParams.get('amount'), '1.5')
          return {
            errno: 0,
            message: 'success',
            data: [quoteRoute({
              srcChain: sourceChainWithToken(ERC20_TOKEN),
              dstChain: {
                chainId: '137',
                tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' },
                totalAmountOut: '10.25'
              }
            })]
          }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000
      })
      const options = {
        fromToken: ERC20_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }
  
      assert.deepEqual(await protocol.getSupportedTokens({ fromChain: 56 }), [])
      const quote = await protocol.quoteSwidge(options)
  
      assert.equal(quote.fromTokenAmount, 1500000000000000000n)
      // The /findToken lookup is cached: a second quote must not re-query it.
      await protocol.quoteSwidge({ ...options, fromTokenAmount: 1500000000000000000n })
      assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/findToken').length, 1)
    })

  it('caches a Butter token-not-found miss instead of re-querying /findToken', async () => {
      const fetch = makeFetch({
        '/findToken': async () => ({ errno: 2002, message: 'The Token not found' })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch
      })
      const options = { fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }
  
      await assert.rejects(protocol.quoteSwidge(options), { name: 'ButterActionRequiredError', message: 'Token decimals are required for 0x00000000000000000000000000000000000000aa; Butter could not resolve them, configure tokenDecimals' })
      await assert.rejects(protocol.quoteSwidge(options), { name: 'ButterActionRequiredError', message: 'Token decimals are required for 0x00000000000000000000000000000000000000aa; Butter could not resolve them, configure tokenDecimals' })
      assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/findToken').length, 1)
    })

  it('does not resolve decimals from a same-chain /findToken entry for another token', async () => {
      // These decimals become FeeContext.sourceTokenDecimals, the value a
      // source-denominated fee is parsed with against the caller's real base units. A
      // `decimals: 0` answer for a different token understates a fee by orders of
      // magnitude and slips it under a bps cap — the bypass trustedSourceDecimals
      // exists to close, reached through /findToken instead.
      let findTokenCalls = 0
      const fetch = makeFetch({
        '/findToken': async () => {
          findTokenCalls++
          return {
            errno: 0,
            message: 'success',
            // Right chain, wrong token.
            data: [{ chainId: 56, address: DEST_TOKEN, decimals: 0, symbol: 'OTHER' }]
          }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
      const options = { fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 100000000n, slippage: 0.02 }
  
      await assert.rejects(protocol.quoteSwidge(options), { name: 'ButterActionRequiredError', message: 'Token decimals are required for 0x00000000000000000000000000000000000000aa; Butter could not resolve them, configure tokenDecimals' })
      // Inconclusive, not a confirmed miss: caching it would pin every later quote for
      // this token to "configure tokenDecimals" for the life of the process.
      await assert.rejects(protocol.quoteSwidge(options), { name: 'ButterActionRequiredError', message: 'Token decimals are required for 0x00000000000000000000000000000000000000aa; Butter could not resolve them, configure tokenDecimals' })
      assert.equal(findTokenCalls, 2)
    })

  it('rejects malformed matching decimals without caching them', async () => {
      let findTokenCalls = 0
      const fetch = makeFetch({
        '/findToken': async () => {
          findTokenCalls++
          return {
            errno: 0,
            message: 'success',
            data: [{ chainId: 56, address: ERC20_TOKEN, decimals: findTokenCalls === 1 ? 'not-a-number' : 18 }]
          }
        },
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            srcChain: sourceChainWithToken(ERC20_TOKEN),
            dstChain: { chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' }, totalAmountOut: '10.25' }
          })]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
      const options = { fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }
  
      await assert.rejects(
        protocol.quoteSwidge(options),
        { name: 'ButterApiError', message: 'Butter /findToken returned invalid decimals for the requested token' }
      )
      const quote = await protocol.quoteSwidge(options)
      assert.equal(quote.fromTokenAmount, 1n)
      assert.equal(findTokenCalls, 2)
    })

  it('expires a /findToken not-found cache entry after five minutes', async () => {
      let now = 1000
      let findTokenCalls = 0
      const fetch = makeFetch({
        '/findToken': async () => {
          findTokenCalls++
          return findTokenCalls === 1
            ? { errno: 2002, message: 'The Token not found' }
            : { errno: 0, message: 'success', data: [{ chainId: 56, address: ERC20_TOKEN, decimals: 18 }] }
        },
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            srcChain: sourceChainWithToken(ERC20_TOKEN),
            dstChain: { chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' }, totalAmountOut: '10.25' }
          })]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch, now: () => now })
      const options = { fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }
  
      await assert.rejects(protocol.quoteSwidge(options), { name: 'ButterActionRequiredError', message: 'Token decimals are required for 0x00000000000000000000000000000000000000aa; Butter could not resolve them, configure tokenDecimals' })
      now = 1299
      await assert.rejects(protocol.quoteSwidge(options), { name: 'ButterActionRequiredError', message: 'Token decimals are required for 0x00000000000000000000000000000000000000aa; Butter could not resolve them, configure tokenDecimals' })
      assert.equal(findTokenCalls, 1)
  
      now = 1300
      const quote = await protocol.quoteSwidge(options)
      assert.equal(quote.fromTokenAmount, 1n)
      assert.equal(findTokenCalls, 2)
    })

  it('pins an approved quote by routeHash and skips re-quoting at execution', async () => {
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
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{
            to: ROUTER,
            value: '1500000000000000000',
            data: crossChainSwapData(NATIVE_TOKEN, 1500000000000000000n),
            chainId: '56',
            method: 'swapAndBridge'
          }]
        })
      })
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        now: () => 1000,
        maxNativeFee: 0n,
        evm: { walletClient: evmWallet(async () => '0x1111111111111111111111111111111111111111111111111111111111111111') }
      })
      const options = {
        fromToken: NATIVE_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }
  
      const quote = await protocol.quoteSwidge(options)
      assert.equal(quote.routeHash, '0x3333333333333333333333333333333333333333333333333333333333333333')
      const result = await protocol.swidge({ ...options, routeHash: quote.routeHash })
  
      assert.equal(result.id, '0x1111111111111111111111111111111111111111111111111111111111111111')
      // Only the quote called /route; the pinned execution reused that route.
      assert.equal(fetch.calls.filter(({ url }) => url.pathname === '/route').length, 1)
    })

  it('rejects exact-out before requesting a route or sending a transaction', async () => {
      const fetch = makeFetch({})
      const sent: unknown[] = []
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS,
        evm: {
          walletClient: evmWallet(async (tx) => {
            sent.push(tx)
            return '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
          })
        }
      })
      const exactOut = {
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: VALID_RECIPIENT,
        toTokenAmount: 10250000n,
        slippage: 0.02
      }
  
      // Butter's /route documents type=exactOut, but the default production endpoint
      // rejects it (errno 2000) and the docs specify `amount` only as "amount of
      // source token", leaving the exactOut denomination undefined. Rejecting up front
      // beats advertising a feature that does not work.
      await assert.rejects(protocol.quoteSwidge(exactOut), { name: 'ButterExactOutUnsupportedError', message: 'Butter router does not support exact-out swaps' })
      await assert.rejects(protocol.swidge(exactOut), { name: 'ButterExactOutUnsupportedError', message: 'Butter router does not support exact-out swaps' })
      assert.equal(fetch.calls.length, 0)
      assert.equal(sent.length, 0)
    })

  it('rejects both amounts and neither amount', async () => {
      const fetch = makeFetch({})
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
      const base = { fromToken: '0x00000000000000000000000000000000000000ab', toToken: '0x00000000000000000000000000000000000000cd', toChain: 137, slippage: 0.02 }
  
      // WDK: exact-in requires fromTokenAmount, exact-out requires toTokenAmount,
      // not both.
      await assert.rejects(protocol.quoteSwidge({
        ...base,
        fromTokenAmount: 1500000000000000000n,
        toTokenAmount: 10250000n
      } as never), { name: 'ButterExactOutUnsupportedError', message: 'Butter router does not support exact-out swaps' })
      await assert.rejects(protocol.quoteSwidge(base as never), { name: 'ButterUnsupportedError', message: 'fromTokenAmount is required' })
      assert.equal(fetch.calls.length, 0)
    })

  it('rejects zero and unsafe numeric exact-in amounts before requesting a route', async () => {
      const fetch = makeFetch({})
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
      const base = {
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '0x0000000000000000000000000000000000000222',
        slippage: 0.02
      }
  
      await assert.rejects(protocol.quoteSwidge({ ...base, fromTokenAmount: 0n }), { name: 'ButterUnsupportedError', message: 'fromTokenAmount must be greater than zero' })
      await assert.rejects(
        protocol.quoteSwidge({ ...base, fromTokenAmount: Number.MAX_SAFE_INTEGER + 1 } as never),
        { name: 'ButterUnsupportedError', message: 'fromTokenAmount must use bigint base units when it exceeds safe integer precision' }
      )
      assert.equal(fetch.calls.length, 0)
    })

  it('does not reject a refundAddress that differs from the sender before requesting a route', async () => {
      const quoteFetch = makeFetch({
        '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute()] })
      })
      const quoteProtocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch: quoteFetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
      await quoteProtocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        fromTokenAmount: 1500000000000000000n,
        refundAddress: VALID_RECIPIENT,
        slippage: 0.02
      })
  
      // Execution used to short-circuit here, because refundAddress had to equal the
      // sender. That promise was never checked against the calldata, so it is now
      // verified downstream instead: the request goes out and the refund destination
      // is compared with what Butter actually encodes.
      const executionFetch = makeFetch({
        '/route': async () => ({ errno: 2003, message: 'No Route Found' })
      })
      const executionProtocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch: executionFetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS,
        evm: { walletClient: evmWallet(async () => '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd') }
      })
      await assert.rejects(executionProtocol.swidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        fromTokenAmount: 1500000000000000000n,
        refundAddress: VALID_RECIPIENT,
        slippage: 0.02
      }), { name: 'ButterNoRouteError', message: 'No Route Found' })
      assert.deepEqual(executionFetch.calls.map(({ url }) => url.pathname), ['/route'])
    })

  it('executes non-EVM swap data through the configured adapter without EVM router validation', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            contract: undefined,
            srcChain: {
              chainId: '1360095883558913',
              tokenIn: { address: 'btc', decimals: 8, symbol: 'BTC' },
              totalAmountIn: '1.5',
              totalAmountOut: '1.5'
            }
          })]
        }),
        '/swap': async () => ({
          errno: 0,
          message: 'success',
          data: [{ to: 'btc-address', value: '1000', memo: 'memo', chainId: '1360095883558913' }]
        })
      })
      const sent: unknown[] = []
      const protocol = new ButterSwidgeProtocol({
        async getAddress () { return 'btc-sender' },
        async sendTransaction (tx) {
          sent.push(tx)
          return { hash: 'btc-tx' }
        }
      }, {
        sourceChainId: '1360095883558913',
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000,
        transactionAdapters: {
          '1360095883558913': (swapTx) => ({
            to: swapTx.to,
            value: BigInt(swapTx.value),
            memo: swapTx.memo
          })
        }
      })
  
      const options = {
        fromToken: 'btc',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '0x0000000000000000000000000000000000000222',
        fromTokenAmount: 150000000n,
        slippage: 0.04
      }
      await protocol.quoteSwidge(options)
      const result = await protocol.swidge(options)
  
      assert.deepEqual(sent, [{ to: 'btc-address', value: 1000n, memo: 'memo' }])
      assert.equal(result.id, 'btc-tx')
    })

  it('reports externally advertised TON metadata as a generic quote-only chain', async () => {
      let requestedSlippage: string | null = null
      const fetch = makeFetch({
        '/supportedChainInfo': async () => ({
          errno: 0,
          message: 'success',
          data: [{ id: '999', type: 'TON', name: 'TON', nativeToken: '{"symbol":"TON","decimals":9}' }]
        }),
        '/api/queryChainList': async () => ({ code: 200, message: 'success', data: { chains: [] } }),
        '/route': async (url) => {
          requestedSlippage = url.searchParams.get('slippage')
          return {
            errno: 0,
            message: 'success',
            data: [quoteRoute({
              bridgeFee: undefined,
              gasFee: undefined,
              swapFee: undefined,
              srcChain: sourceChainWithToken('0x00000000000000000000000000000000000000ab'),
              dstChain: {
                chainId: '999',
                tokenOut: { address: '0x00000000000000000000000000000000000000cd', decimals: 6, symbol: 'TON' },
                totalAmountOut: '10.25'
              }
            })]
          }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      const chains = await protocol.getSupportedChains()
      await protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 999,
        fromTokenAmount: 1500000000000000000n
      })
  
      assert.equal(requestedSlippage, '150')
      assert.equal((chains[0] as { execution?: string }).execution, 'quote-only')
    })

  it('still applies the strict slippage floor for a dropped BTC-like chain', async () => {
      const fetch = makeFetch({
        // Bitcoin-like by name — so the 300 bps floor applies — but missing
        // `nativeToken`, so the chain itself is dropped from the listing. Its id
        // is not one of the built-in strict chain constants, so the floor can
        // only come from discovery having classified it before the filter.
        '/supportedChainInfo': async () => ({
          errno: 0,
          message: 'success',
          data: [{ id: '998', type: 'EVM', name: 'Bitcoin Sidechain' }]
        }),
        '/api/queryChainList': async () => ({ code: 200, message: 'success', data: { chains: [] } }),
        '/route': async (url) => {
          // 300, not the 150 bps cross-chain floor that would apply otherwise.
          assert.equal(url.searchParams.get('slippage'), '300')
          return {
            errno: 0,
            message: 'success',
            data: [quoteRoute({
              bridgeFee: undefined,
              gasFee: undefined,
              swapFee: undefined,
              srcChain: sourceChainWithToken('0x00000000000000000000000000000000000000ab'),
              dstChain: {
                chainId: '998',
                tokenOut: { address: '0x00000000000000000000000000000000000000cd', decimals: 6, symbol: 'BTCS' },
                totalAmountOut: '10.25'
              }
            })]
          }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      const chains = await protocol.getSupportedChains()
      await protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 998,
        fromTokenAmount: 1500000000000000000n
      })
  
      assert.deepEqual(chains, [])
    })

  it('routes same-chain status to the receipt without explicit chain hints after executing', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            bridgeFee: undefined,
            gasFee: undefined,
            swapFee: undefined,
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
          data: [{
            to: ROUTER,
            value: '0',
            data: sameChainSwapDataFor(ERC20_TOKEN, 1500000000000000000n),
            chainId: '56',
            method: 'swapAndCall'
          }]
        })
      })
      const protocol = new ButterSwidgeProtocol(account, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: ERC20_TOKEN_DECIMALS,
        evm: {
          publicClient: {
            readContract: async () => 1500000000000000000n,
            getTransactionReceipt: async () => ({ status: 'success' })
          },
          walletClient: evmWallet(async () => '0x1111111111111111111111111111111111111111111111111111111111111111')
        }
      })
  
      const result = await protocol.swidge({
        fromToken: ERC20_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 56,
        recipient: VALID_RECIPIENT,
        fromTokenAmount: 1500000000000000000n
      })
  
      const callsBefore = fetch.calls.length
      // No fromChain/toChain hints: the provider must remember this was same-chain
      // and derive status from the receipt, not query the cross-chain API.
      const status = await protocol.getSwidgeStatus(result.id)
      assert.equal(status.status, 'completed')
      assert.equal(fetch.calls.length, callsBefore)
    })

  it('does not report an unrelated (non-Router) transaction as a completed swidge', async () => {
      const NON_ROUTER = '0x00000000000000000000000000000000000000ff'
      const fetch = makeFetch({}) // cross API has no record; must not resolve to completed
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        evm: {
          publicClient: {
            readContract: async () => 0n,
            // swapAndCall-shaped calldata but to a NON-allowlisted address.
            getTransaction: async () => ({ input: sameChainSwapDataFor(ERC20_TOKEN, 1000n), to: NON_ROUTER }),
            getTransactionReceipt: async () => ({ status: 'success' })
          }
        }
      })
  
      // No hints: must not be attributed as a same-chain Butter swidge.
      await assert.rejects(protocol.getSwidgeStatus('0x1111111111111111111111111111111111111111111111111111111111111111'), { name: 'Error', message: 'unexpected request: /api/queryBridgeInfoBySourceHash' })
      // Explicit same-chain hints must not bypass the Router attribution check.
      await assert.rejects(
        protocol.getSwidgeStatus('0x1111111111111111111111111111111111111111111111111111111111111111', { fromChain: 56, toChain: 56 }),
        { name: 'ButterApiError', message: 'Cannot verify a same-chain Butter swidge: source transaction is not an allowlisted Router swapAndCall on this chain (configure evm.publicClient.getTransaction)' }
      )
    })

  it('maps all canonical WDK status strings and rejects an empty id', async () => {
      const states = ['pending', 'action-required', 'completed', 'failed', 'refund-pending', 'refunded', 'cancelled', 'expired', 'partial'] as const
      let index = 0
      const fetch = makeFetch({
        '/api/queryBridgeInfoBySourceHash': async () => ({
          code: 200,
          message: 'success',
          data: { info: { state: states[index++], sourceHash: `id-${index}` } }
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      for (const expected of states) {
        assert.equal((await protocol.getSwidgeStatus(`id-${index + 1}`)).status, expected)
      }
      await assert.rejects(protocol.getSwidgeStatus(''), { name: 'ButterApiError', message: 'A non-empty swidge id is required' })
      assert.equal(fetch.calls.length, states.length)
    })

  it('bounds the /findToken cache and promotes cache hits in LRU order', async () => {
    const calls = new Map<string, number>()
    const fetch = makeFetch({
      '/findToken': async (url) => {
        const token = String(url.searchParams.get('address'))
        calls.set(token, (calls.get(token) ?? 0) + 1)
        return { errno: 2002, message: 'The Token not found' }
      }
    })
    const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })

    const quoteUnknown = async (fromToken: string) => {
      await assert.rejects(
        protocol.quoteSwidge({ fromToken, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }),
        {
          name: 'ButterActionRequiredError',
          message: `Token decimals are required for ${fromToken}; Butter could not resolve them, configure tokenDecimals`
        }
      )
    }
    for (let index = 0; index < 256; index++) await quoteUnknown(`token-${index}`)
    await quoteUnknown('token-0')
    await quoteUnknown('token-256')
    await quoteUnknown('token-0')
    await quoteUnknown('token-1')

    assert.deepEqual(Object.fromEntries(calls), {
      'token-0': 1,
      'token-1': 2,
      'token-256': 1,
      ...Object.fromEntries(Array.from({ length: 254 }, (_, index) => [`token-${index + 2}`, 1]))
    })
  })
})
