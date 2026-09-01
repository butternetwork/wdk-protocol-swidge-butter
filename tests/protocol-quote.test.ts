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

  it('quotes through /route with auth headers and maps amounts, fees, and expiry', async () => {
      const fetch = makeFetch({
        '/route': async (url, init) => {
          assert.equal(url.searchParams.get('fromChainId'), '56')
          assert.equal(url.searchParams.get('toChainId'), '137')
          assert.equal(url.searchParams.get('amount'), '1.5')
          assert.equal(url.searchParams.get('tokenInAddress'), '0x00000000000000000000000000000000000000ab')
          assert.equal(url.searchParams.get('tokenOutAddress'), '0x00000000000000000000000000000000000000cd')
          assert.equal(url.searchParams.get('type'), 'exactIn')
          assert.equal(url.searchParams.get('slippage'), '200')
          assert.equal(url.searchParams.get('receiver'), '0x0000000000000000000000000000000000000222')
          assert.equal(url.searchParams.get('entrance'), 'wdk')
          // Unconfigured affiliate/referrer are omitted entirely, so an existing
          // integrator's outgoing query and route cache key are unchanged.
          assert.equal(url.searchParams.get('affiliate'), null)
          assert.equal(url.searchParams.get('referrer'), null)
          assert.equal(init.headers?.['x-api-key-id'], 'key')
          assert.equal(init.headers?.Authorization, 'Bearer secret')
          return { errno: 0, message: 'success', data: [quoteRoute()] }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      const quote = await protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '0x0000000000000000000000000000000000000222',
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
  
      assert.deepEqual(quote, {
        fromTokenAmount: 1500000000000000000n,
        toTokenAmount: 10250000n,
        toTokenAmountMin: 9500000n,
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
          },
          {
            type: 'protocol',
            amount: 20000000000000000n,
            token: '0x00000000000000000000000000000000000000ab',
            chain: '56',
            included: true,
            description: 'Butter token swap fee'
          }
        ],
        estimatedDuration: 120,
        expiry: 1300,
        routeHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
        destinationGuarantees: 'quoted-only'
      })
    })

  it('sends the configured affiliate and referrer to /route', async () => {
      const fetch = makeFetch({
        '/route': async (url) => {
          // Surrounding whitespace is trimmed rather than forwarded verbatim.
          assert.equal(url.searchParams.get('affiliate'), 'butter-wdk:10')
          assert.equal(url.searchParams.get('referrer'), '0x00000000000000000000000000000000000000dd')
          return { errno: 0, message: 'success', data: [quoteRoute()] }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        now: () => 1000,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS,
        affiliate: ' butter-wdk:10 ',
        referrer: ' 0x00000000000000000000000000000000000000dd '
      })
  
      await protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '0x0000000000000000000000000000000000000222',
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
  
      assert.equal(fetch.calls.length, 1)
    })

  it('rejects a Solana same-chain route without a referrer', async () => {
      // Butter documents `referrer` as mandatory here, so the request could never be
      // valid; `makeFetch` throws on any request, proving none was attempted.
      const fetch = makeFetch({})
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: SOLANA_CHAIN_ID,
        entrance: 'wdk',
        fetch,
        now: () => 1000
      })
  
      await assert.rejects(
        protocol.quoteSwidge({
          fromToken: 'sol',
          toToken: 'So11111111111111111111111111111111111111112',
          toChain: SOLANA_CHAIN_ID,
          recipient: 'GsbwXfJraMomNxBcjK9jSDLo6Uc3ByBcpUckuFqVjhWH',
          fromTokenAmount: 1000000000n,
          slippage: 0.02
        }),
        { name: 'ButterConfigurationError', message: 'Butter requires a referrer for Solana same-chain routes; set config.referrer' }
      )
      assert.equal(fetch.calls.length, 0)
    })

  it('rejects a malformed affiliate at construction', () => {
      const fetch = makeFetch({})
      const config = { sourceChainId: 56, entrance: 'wdk', fetch } as const
  
      // Butter substitutes its own default affiliate wallet whenever the parameter
      // is unusable, so a malformed value would otherwise hand the integrator's
      // share away on a successful swap, with no error to notice.
      for (const [affiliate, message] of [
        [':10', 'affiliate must be formatted as "<nickname>" or "<nickname>:<rate>"'],
        ['butter:', 'affiliate rate must be a non-negative number'],
        ['butter:abc', 'affiliate rate must be a non-negative number'],
        ['butter:-1', 'affiliate rate must be a non-negative number'],
        ['butter wdk', 'affiliate must be formatted as "<nickname>" or "<nickname>:<rate>"'],
        ['a:1:2', 'affiliate must be formatted as "<nickname>" or "<nickname>:<rate>"']
      ] as const) {
        assert.throws(
          () => new ButterSwidgeProtocol(undefined, { ...config, affiliate }),
          { name: 'ButterConfigurationError', message }
        )
      }
  
    })

  it('does not surface priceImpact from per-leg data (unit/aggregation unconfirmed)', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            dstChain: {
              chainId: '137',
              tokenOut: { address: '0x00000000000000000000000000000000000000cd', decimals: 6, symbol: 'USDT' },
              totalAmountOut: '10.25',
              // Per-leg impacts on both ends: no authoritative aggregate, so we do
              // not surface an arbitrary leg's value.
              route: [{ priceImpact: '0.0123' }, { priceImpact: '0.02' }]
            }
          })]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      const quote = await protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '0x0000000000000000000000000000000000000222',
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
  
      assert.equal(quote.priceImpact, undefined)
      assert.equal(Object.hasOwn(quote, 'priceImpact'), false)
    })

  it('does not resolve the sender address when quoting a non-Solana route', async () => {
      let getAddressCalls = 0
      const localAccount = {
        async getAddress () { getAddressCalls++; return VALID_SENDER },
        async sendTransaction () { return '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' }
      }
      const fetch = makeFetch({ '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute()] }) })
      const protocol = new ButterSwidgeProtocol(localAccount, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        now: () => 1000,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      await protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '0x0000000000000000000000000000000000000222',
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
  
      assert.equal(getAddressCalls, 0)
    })

  it('falls back to the next candidate when the best route has no liquidity', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          // Butter orders candidates best-output-first. Taking [0] unconditionally
          // failed the whole request whenever the top one lacked liquidity.
          data: [
            quoteRoute({ hash: '0x6666666666666666666666666666666666666666666666666666666666666666', hasLiquidity: false }),
            quoteRoute({ hash: '0x5555555555555555555555555555555555555555555555555555555555555555' })
          ]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      const quote = await protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
  
      assert.equal(quote.routeHash, '0x5555555555555555555555555555555555555555555555555555555555555555')
    })

  it('still validates the chosen candidate against the request', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          // Falling back must not skip the chain/token consistency checks: the only
          // liquid candidate here goes to the wrong destination chain.
          data: [
            quoteRoute({ hasLiquidity: false }),
            quoteRoute({
              dstChain: { chainId: '10', tokenOut: { address: '0x00000000000000000000000000000000000000cd', decimals: 6, symbol: 'USDT' }, totalAmountOut: '10.25' }
            })
          ]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      await assert.rejects(protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }), { name: 'ButterApiError', message: 'Butter route destination chain does not match request' })
    })

  it('rejects a cross-chain route that is missing dstChain', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            // Cross-chain request but a same-chain-shaped route (no dstChain).
            dstChain: undefined,
            srcChain: {
              chainId: '56',
              tokenIn: { address: '0x00000000000000000000000000000000000000ab', decimals: 18, symbol: 'BNB' },
              tokenOut: { address: '0x00000000000000000000000000000000000000cd', decimals: 6, symbol: 'USDT' },
              totalAmountIn: '1.5',
              totalAmountOut: '10.25'
            }
          })]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        now: () => 1000,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      await assert.rejects(protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '0x0000000000000000000000000000000000000222',
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }), { name: 'ButterApiError', message: 'Butter cross-chain route is missing dstChain' })
    })

  it('does not accept a source-leg tokenOut for a cross-chain destination', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            srcChain: {
              chainId: '56',
              tokenIn: { address: '0x00000000000000000000000000000000000000ab', decimals: 18 },
              tokenOut: { address: '0x00000000000000000000000000000000000000cd', decimals: 6 },
              totalAmountIn: '1.5',
              totalAmountOut: '10.25'
            },
            dstChain: { chainId: '137', totalAmountOut: '10.25' }
          })]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      await assert.rejects(protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }), { name: 'ButterApiError', message: 'Butter route is missing destination token address' })
    })

  it('uses an earlier Butter route timestamp without allowing it to extend the local TTL', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({ timestamp: 900 })]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      const quote = await protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '0x0000000000000000000000000000000000000222',
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
  
      assert.equal(quote.expiry, 1200)
    })

  it('caps a future Butter route timestamp to the local quote TTL', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({ timestamp: 999999 })]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      const quote = await protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '0x0000000000000000000000000000000000000222',
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
  
      assert.equal(quote.expiry, 1300)
    })

  it('treats a blank same-family recipient as absent', async () => {
      const fetch = makeFetch({
        '/route': async (url) => {
          assert.equal(url.searchParams.get('receiver'), null)
          return { errno: 0, message: 'success', data: [quoteRoute()] }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      await protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '   ',
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
    })

  it('quotes a cross-VM route without requiring a recipient', async () => {
      // A quote is non-binding and asking a price without a destination address is
      // the normal first step, so the cross-VM requirement is execution-only.
      const solanaToken = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      const fetch = makeFetch({
        '/route': async (url) => {
          assert.equal(url.searchParams.get('receiver'), null)
          return {
            errno: 0,
            message: 'success',
            data: [quoteRoute({
              swapFee: { nativeFee: '0', tokenFee: '0' },
              srcChain: sourceChainWithToken(NATIVE_TOKEN),
              dstChain: {
                chainId: SOLANA_CHAIN_ID,
                tokenOut: { address: solanaToken, decimals: 6, symbol: 'USDC' },
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
        now: () => 1000
      })
  
      const quote = await protocol.quoteSwidge({
        fromToken: NATIVE_TOKEN,
        toToken: solanaToken,
        toChain: SOLANA_CHAIN_ID,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
  
      assert.equal(quote.toTokenAmount, 10250000n)
    })

  it('resolves configured decimals whatever case the address is written in', async () => {
      // Only the query was normalized, never the configuration keys, so a checksummed
      // entry was unreachable from the equivalent lowercase request and the decimals
      // were reported missing. A successful /findToken had been covering for it.
      const checksummed = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01'
      const fetch = makeFetch({
        '/route': async (url) => {
          assert.equal(url.searchParams.get('amount'), '1.5')
          return { errno: 0, message: 'success', data: [quoteRoute({
            srcChain: {
              chainId: '56',
              tokenIn: { address: checksummed.toLowerCase(), decimals: 18, symbol: 'TKN' },
              tokenOut: { address: '0x00000000000000000000000000000000000000cd', decimals: 6, symbol: 'USDT' },
              totalAmountIn: '1.5',
              totalAmountOut: '10.25'
            },
            dstChain: undefined
          })] }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        // Configured checksummed, requested lowercase, and no /findToken to fall back on.
        tokenDecimals: { [checksummed]: 18, '0x00000000000000000000000000000000000000cd': 6 }
      })
  
      const quote = await protocol.quoteSwidge({
        fromToken: checksummed.toLowerCase(),
        toToken: '0x00000000000000000000000000000000000000cd',
        fromTokenAmount: 1500000000000000000n
      })
  
      assert.equal(quote.toTokenAmount, 10250000n)
    })

  it('resolves a native token from nativeTokenDecimals, not tokenDecimals', async () => {
      // Symbolic ids never reach the tokenDecimals map: decimalsFor answers them from
      // the chain-aware native-token check and nativeTokenDecimals first. This pins
      // where a native token's decimals actually come from, so the unreachable branch
      // is not reintroduced in normalizeTokenKey.
      const fetch = makeFetch({
        '/route': async (url) => {
          assert.equal(url.searchParams.get('amount'), '1.5')
          return { errno: 0, message: 'success', data: [quoteRoute({
            srcChain: {
              chainId: '56',
              tokenIn: { address: 'native', decimals: 9, symbol: 'NATIVE' },
              tokenOut: { address: '0x00000000000000000000000000000000000000cd', decimals: 6, symbol: 'USDT' },
              totalAmountIn: '1.5',
              totalAmountOut: '10.25'
            },
            dstChain: undefined
          })] }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        // Deliberately conflicting: the tokenDecimals entry is ignored for a native id.
        nativeTokenDecimals: { 56: 9 },
        tokenDecimals: { native: 18, '0x00000000000000000000000000000000000000cd': 6 }
      })
  
      const quote = await protocol.quoteSwidge({
        fromToken: 'native',
        toToken: '0x00000000000000000000000000000000000000cd',
        fromTokenAmount: 1500000000n
      })
  
      assert.equal(quote.toTokenAmount, 10250000n)
    })

  it('rejects conflicting tokenDecimals entries for one token', () => {
      // Which decimals apply would otherwise depend on object key order, and decimals
      // decide amounts.
      assert.throws(
        () => new ButterSwidgeProtocol(undefined, {
          sourceChainId: 56,
          entrance: 'wdk',
          fetch: makeFetch({}),
          tokenDecimals: {
            '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01': 18,
            '0xabcdef0123456789abcdef0123456789abcdef01': 6
          }
        }),
        { name: 'ButterConfigurationError', message: 'tokenDecimals has conflicting entries for the same token' }
      )
    })

  it('rejects slippage below Butter cross-chain floor instead of silently increasing it', () => {
      assert.throws(() => toButterSlippage(0.01, { crossChain: true }), { name: 'ButterActionRequiredError', message: 'Butter requires at least 150 bps slippage for this route' })
    })

  it('enforces minAmountOut locally when Butter has no request parameter for it', async () => {
      const fetch = makeFetch({
        '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute()] })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        now: () => 1000,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      await assert.rejects(
        protocol.quoteSwidge({
          fromToken: '0x00000000000000000000000000000000000000ab',
          toToken: '0x00000000000000000000000000000000000000cd',
          toChain: 137,
          recipient: '0x0000000000000000000000000000000000000222',
          fromTokenAmount: 1500000000000000000n,
          minAmountOut: 9600000n,
          slippage: 0.02
        }),
        { name: 'ButterActionRequiredError', message: 'Butter route minimum output is below requested minAmountOut' }
      )
    })

  it('rejects route responses that do not match the requested source token', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            srcChain: {
              chainId: '56',
              tokenIn: { address: '0x00000000000000000000000000000000000000ef', decimals: 18, symbol: 'BNB' },
              totalAmountIn: '1.5',
              totalAmountOut: '1.5'
            }
          })]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      await assert.rejects(
        protocol.quoteSwidge({
          fromToken: '0x00000000000000000000000000000000000000ab',
          toToken: '0x00000000000000000000000000000000000000cd',
          toChain: 137,
          recipient: '0x0000000000000000000000000000000000000222',
          fromTokenAmount: 1500000000000000000n,
          slippage: 0.02
        }),
        { name: 'ButterApiError', message: 'Butter route source token does not match request' }
      )
    })

  it('rejects authenticated clients configured with non-HTTPS Butter base URLs', () => {
      assert.throws(
        () => new ButterSwidgeProtocol(undefined, {
          sourceChainId: 56,
          entrance: 'wdk',
          apiKeyId: 'key',
          apiSecret: 'secret',
          routerBaseUrl: 'http://example.test',
          fetch: makeFetch({})
        }),
        { name: 'ButterConfigurationError', message: 'Butter API credentials require HTTPS base URLs' }
      )
    })

  it('rejects missing required Butter integration metadata at construction time', () => {
      assert.throws(
        () => new ButterSwidgeProtocol(undefined, {
          sourceChainId: 56,
          entrance: '',
          authMode: 'optional',
          fetch: makeFetch({})
        }),
        { name: 'ButterConfigurationError', message: 'entrance is required' }
      )
    })

  it('rejects a negative or non-integer maxNativeFee at construction time', () => {
      for (const maxNativeFee of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(
          () => new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch: makeFetch({}), maxNativeFee }),
          { name: 'ButterConfigurationError', message: 'maxNativeFee must be a non-negative integer in native base units' }
        )
      }
    })

  it('rejects invalid HTTP and approval timeout configuration at construction time', () => {
      for (const requestTimeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(
          () => new ButterSwidgeProtocol(undefined, {
            sourceChainId: 56,
            entrance: 'wdk',
            fetch: makeFetch({}),
            requestTimeoutMs
          }),
          { name: 'ButterConfigurationError', message: 'requestTimeoutMs must be a positive integer number of milliseconds' }
        )
      }
      for (const approvalTimeoutMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(
          () => new ButterSwidgeProtocol(undefined, {
            sourceChainId: 56,
            entrance: 'wdk',
            fetch: makeFetch({}),
            evm: { approvalTimeoutMs }
          }),
          { name: 'ButterConfigurationError', message: 'approvalTimeoutMs must be a non-negative integer number of milliseconds' }
        )
      }
    })

  it('still requires configured decimals when Butter does not know the token', async () => {
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
  
      await assert.rejects(protocol.quoteSwidge({
        fromToken: ERC20_TOKEN,
        toToken: DEST_TOKEN,
        toChain: 137,
        fromTokenAmount: 1n,
        slippage: 0.02
      }), { name: 'ButterActionRequiredError', message: 'Token decimals are required for 0x00000000000000000000000000000000000000aa; Butter could not resolve them, configure tokenDecimals' })
    })

  it('filters /findToken results to the requested chain and ignores other chains', async () => {
      const fetch = makeFetch({
        // /findToken matches by address only: it returns the token on several
        // chains. The wrong-chain entry (6 decimals) must never be used for chain 56.
        '/findToken': async () => ({
          errno: 0,
          message: 'success',
          data: [
            { chainId: 42161, address: ERC20_TOKEN, decimals: 6, symbol: 'X' },
            { chainId: 56, address: ERC20_TOKEN, decimals: 18, symbol: 'X' }
          ]
        }),
        '/route': async (url) => {
          assert.equal(url.searchParams.get('amount'), '1.5') // 18-decimal scaling, not 6
          return {
            errno: 0,
            message: 'success',
            data: [quoteRoute({
              srcChain: sourceChainWithToken(ERC20_TOKEN),
              dstChain: { chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' }, totalAmountOut: '10.25' }
            })]
          }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      const quote = await protocol.quoteSwidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1500000000000000000n, slippage: 0.02 })
      assert.equal(quote.fromTokenAmount, 1500000000000000000n)
    })

  it('matches a /findToken entry by exact case for a Base58 mint', async () => {
      const mint = 'AbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGHJK'
      const fetch = makeFetch({
        // Same chain, and the address differs only by case — which for Base58 is a
        // different mint entirely.
        '/findToken': async () => ({ errno: 0, message: 'success', data: [{ chainId: 56, address: mint.toLowerCase(), decimals: 0 }] })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      await assert.rejects(
        protocol.quoteSwidge({ fromToken: mint, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }),
        { name: 'ButterActionRequiredError', message: 'Token decimals are required for AbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGHJK; Butter could not resolve them, configure tokenDecimals' }
      )
    })

  it('ignores malformed /findToken siblings and accepts consistent matching entries', async () => {
      const fetch = makeFetch({
        '/findToken': async () => ({
          errno: 0,
          message: 'success',
          data: [
            null,
            42,
            { chainId: 56, address: false, decimals: 0 },
            { chainId: 56, address: ERC20_TOKEN, decimals: '18' },
            { chainId: '56', token: ERC20_TOKEN, decimal: 18 }
          ]
        }),
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
  
      const quote = await protocol.quoteSwidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 })
  
      assert.equal(quote.fromTokenAmount, 1n)
    })

  it('rejects a primitive /findToken payload as a typed API error', async () => {
      const fetch = makeFetch({
        '/findToken': async () => ({ errno: 0, message: 'success', data: 'not-a-token-record' })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      await assert.rejects(
        protocol.quoteSwidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }),
        { name: 'ButterApiError', message: 'Butter /findToken returned an invalid payload' }
      )
    })

  it('rejects conflicting decimals for duplicate matching /findToken entries', async () => {
      const fetch = makeFetch({
        '/findToken': async () => ({
          errno: 0,
          message: 'success',
          data: [
            { chainId: 56, address: ERC20_TOKEN, decimals: 6 },
            { chainId: '56', address: ERC20_TOKEN, decimals: 18 }
          ]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      await assert.rejects(
        protocol.quoteSwidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }),
        { name: 'ButterApiError', message: 'Butter /findToken returned conflicting decimals for the requested token' }
      )
    })

  it('rejects conflicting decimals aliases in one matching /findToken entry', async () => {
      const fetch = makeFetch({
        '/findToken': async () => ({
          errno: 0,
          message: 'success',
          data: [{ chainId: 56, address: ERC20_TOKEN, decimals: 6, decimal: 18 }]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      await assert.rejects(
        protocol.quoteSwidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }),
        { name: 'ButterApiError', message: 'Butter /findToken returned conflicting decimals for the requested token' }
      )
    })

  it('treats a /findToken result with no matching chain as an unknown token', async () => {
      const fetch = makeFetch({
        '/findToken': async () => ({ errno: 0, message: 'success', data: [{ chainId: 42161, address: ERC20_TOKEN, decimals: 6 }] })
      })
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
      await assert.rejects(
        protocol.quoteSwidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }),
        { name: 'ButterActionRequiredError', message: 'Token decimals are required for 0x00000000000000000000000000000000000000aa; Butter could not resolve them, configure tokenDecimals' }
      )
    })

  it('does not mask a /findToken transport failure as an unknown token', async () => {
      const fetch = makeFetch({
        '/findToken': async () => { throw new Error('network down') }
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch
      })
  
      await assert.rejects(
        protocol.quoteSwidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }),
        { name: 'Error', message: 'network down' }
      )
    })

  it('defaults the Solana route receiver to the sender when recipient is omitted', async () => {
      const solanaChain = '1360108768460801'
      const solSender = 'SoLsender11111111111111111111111111111111'
      const fetch = makeFetch({
        '/route': async (url) => {
          // WDK default: omitted recipient falls back to the account address.
          assert.equal(url.searchParams.get('receiver'), solSender)
          return {
            errno: 0,
            message: 'success',
            data: [quoteRoute({
              srcChain: { chainId: solanaChain, tokenIn: { address: 'sol', decimals: 9 }, totalAmountIn: '1', totalAmountOut: '1' },
              dstChain: { chainId: '137', tokenOut: { address: DEST_TOKEN, decimals: 6, symbol: 'USDT' }, totalAmountOut: '10.25' }
            })]
          }
        }
      })
      const protocol = new ButterSwidgeProtocol({ getAddress: async () => solSender }, {
        sourceChainId: solanaChain,
        entrance: 'wdk',
        fetch
      })
  
      const quote = await protocol.quoteSwidge({ fromToken: 'sol', toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1000000000n, slippage: 0.02 })
      assert.equal(quote.fromTokenAmount, 1000000000n)
    })

  it('still requires an explicit recipient for a Solana quote with no account', async () => {
      const fetch = makeFetch({})
      const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: '1360108768460801', entrance: 'wdk', fetch })
  
      await assert.rejects(
        protocol.quoteSwidge({ fromToken: 'sol', toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1000000000n, slippage: 0.02 }),
        { name: 'ButterActionRequiredError', message: 'Butter requires receiver when source chain is Solana' }
      )
      assert.equal(fetch.calls.length, 0)
    })

  it('echoes the requested input amount as the quote fromTokenAmount', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            // Butter echoes a slightly different totalAmountIn; the quote must
            // still report exactly what the caller requested.
            srcChain: { chainId: '56', tokenIn: { address: '0x00000000000000000000000000000000000000ab', decimals: 18, symbol: 'BNB' }, totalAmountIn: '1.499', totalAmountOut: '1.5' }
          })]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      const quote = await protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
      assert.equal(quote.fromTokenAmount, 1500000000000000000n)
    })

  it('rejects a route that omits destination token decimals instead of defaulting to 18', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            dstChain: { chainId: '137', tokenOut: { address: '0x00000000000000000000000000000000000000cd', symbol: 'USDT' }, totalAmountOut: '10.25' }
          })]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      await assert.rejects(
        protocol.quoteSwidge({ fromToken: '0x00000000000000000000000000000000000000ab', toToken: '0x00000000000000000000000000000000000000cd', toChain: 137, fromTokenAmount: 1500000000000000000n, slippage: 0.02 }),
        { name: 'ButterApiError', message: 'Butter route is missing valid destination token decimals' }
      )
    })

  it('treats the former TON chain id as an unknown chain without a strict slippage floor', async () => {
      let requestedSlippage: string | null = null
      const fetch = makeFetch({
        '/route': async (url) => {
          requestedSlippage = url.searchParams.get('slippage')
          return {
            errno: 0,
            message: 'success',
            data: [quoteRoute({
              dstChain: {
                chainId: FORMER_TON_CHAIN_ID,
                tokenOut: { address: 'ton-usdt', decimals: 6, symbol: 'USDT' },
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
        tokenDecimals: { '0x00000000000000000000000000000000000000ab': 18 }
      })
  
      const quote = await protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: 'ton-usdt',
        toChain: FORMER_TON_CHAIN_ID,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
  
      assert.equal(requestedSlippage, '200')
      assert.equal(quote.toTokenAmount, 10250000n)
    })

  it('returns an inspectable quote even when a configured fee cap is exceeded', async () => {
      const fetch = makeFetch({
        // tokenFee 0.02 on 1.5 input is ~133 bps, above the 1 bps cap below.
        '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute({ bridgeFee: { amount: '0' } })] })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS,
        maxProtocolFeeBps: 1
      })
  
      // A quote is a non-binding estimate: it must surface the fees, not throw.
      const quote = await protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '0x0000000000000000000000000000000000000222',
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
      assert.equal(quote.fromTokenAmount, 1500000000000000000n)
      assert.deepEqual(quote.fees.map(({ type }) => type), ['network', 'protocol'])
    })

  it('allows quote discovery for Tron without a transaction adapter', async () => {
      const fetch = makeFetch({
        '/route': async () => ({
          errno: 0,
          message: 'success',
          data: [quoteRoute({
            bridgeFee: undefined,
            gasFee: undefined,
            swapFee: undefined,
            srcChain: {
              chainId: '728126428',
              tokenIn: { address: 'trx', decimals: 6, symbol: 'TRX' },
              totalAmountIn: '0.000001',
              totalAmountOut: '0.000001'
            }
          })]
        })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: '728126428',
        entrance: 'wdk',
        fetch
      })
  
      const quote = await protocol.quoteSwidge({
        fromToken: 'trx',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '0x0000000000000000000000000000000000000222',
        fromTokenAmount: 1n,
        slippage: 0.02
      })
  
      assert.equal(quote.fromTokenAmount, 1n)
    })

  it('defaults authentication to optional and rejects partial credentials', async () => {
      const fetch = makeFetch({
        '/route': async (_url, init) => {
          assert.deepEqual(init.headers, {})
          return { errno: 0, message: 'success', data: [quoteRoute()] }
        }
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      await protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      })
      assert.throws(() => new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'partial',
        fetch
      }), { name: 'ButterConfigurationError', message: 'Butter apiKeyId and apiSecret must be provided together' })
    })

  it('rejects malformed successful Butter envelopes', async () => {
      const fetch = makeFetch({
        '/route': async () => ({ message: 'success', data: [quoteRoute()] })
      })
      const protocol = new ButterSwidgeProtocol(undefined, {
        sourceChainId: 56,
        entrance: 'wdk',
        apiKeyId: 'key',
        apiSecret: 'secret',
        fetch,
        tokenDecimals: DEFAULT_TOKEN_DECIMALS
      })
  
      await assert.rejects(protocol.quoteSwidge({
        fromToken: '0x00000000000000000000000000000000000000ab',
        toToken: '0x00000000000000000000000000000000000000cd',
        toChain: 137,
        recipient: '0x0000000000000000000000000000000000000222',
        fromTokenAmount: 1500000000000000000n,
        slippage: 0.02
      }), { name: 'ButterApiError', message: 'success' })
    })

  for (const [name, overrides, toChain, message] of [
      ['source token address', { srcChain: { chainId: '56', tokenIn: { address: '   ', decimals: 18 }, totalAmountIn: '1.5', totalAmountOut: '1.5' } }, 137, 'Butter route is missing source token address'],
      ['cross-chain destination token address', { dstChain: { chainId: '137', tokenOut: { address: '   ', decimals: 6 }, totalAmountOut: '10.25' } }, 137, 'Butter route is missing destination token address'],
      ['same-chain destination token address', { dstChain: undefined, srcChain: { chainId: '56', tokenIn: { address: '0x00000000000000000000000000000000000000ab', decimals: 18 }, tokenOut: { address: '   ', decimals: 6 }, totalAmountIn: '1.5', totalAmountOut: '10.25' } }, 56, 'Butter route is missing destination token address']
    ] as const) {
      it(`rejects a route with a missing ${name}`, async () => {
        const fetch = makeFetch({
          '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute(overrides)] })
        })
        const protocol = new ButterSwidgeProtocol(undefined, {
          sourceChainId: 56,
          entrance: 'wdk',
          fetch,
          tokenDecimals: DEFAULT_TOKEN_DECIMALS
        })
  
        await assert.rejects(protocol.quoteSwidge({
          fromToken: '0x00000000000000000000000000000000000000ab',
          toToken: '0x00000000000000000000000000000000000000cd',
          toChain,
          fromTokenAmount: 1500000000000000000n,
          slippage: 0.02
        }), { name: 'ButterApiError', message })
      })
    }

  for (const [name, overrides, message] of [
      ['minimum output', { minAmountOut: undefined, amountOutMin: undefined }, 'Butter route is missing minimum output amount'],
      ['destination total output', { dstChain: { chainId: '137', tokenOut: { address: '0x00000000000000000000000000000000000000cd', decimals: 6 }, totalAmountOut: undefined }, totalAmountOut: undefined }, 'Butter route is missing destination total output amount']
    ] as const) {
      it(`rejects a route that omits ${name}`, async () => {
        const fetch = makeFetch({
          '/route': async () => ({ errno: 0, message: 'success', data: [quoteRoute(overrides)] })
        })
        const protocol = new ButterSwidgeProtocol(undefined, {
          sourceChainId: 56,
          entrance: 'wdk',
          fetch,
          tokenDecimals: DEFAULT_TOKEN_DECIMALS
        })
  
        await assert.rejects(protocol.quoteSwidge({
          fromToken: '0x00000000000000000000000000000000000000ab',
          toToken: '0x00000000000000000000000000000000000000cd',
          toChain: 137,
          fromTokenAmount: 1500000000000000000n,
          slippage: 0.02
        }), { name: 'ButterApiError', message })
      })
    }

  for (const invalidDecimals of ['', ' ', false, -1, 1.5, 256, {}, '1e2']) {
      it(`rejects invalid /findToken decimals ${JSON.stringify(invalidDecimals)}`, async () => {
        const fetch = makeFetch({
          '/findToken': async () => ({
            errno: 0,
            message: 'success',
            data: [{ chainId: 56, address: ERC20_TOKEN, decimals: invalidDecimals }]
          })
        })
        const protocol = new ButterSwidgeProtocol(undefined, { sourceChainId: 56, entrance: 'wdk', fetch })
  
        await assert.rejects(
          protocol.quoteSwidge({ fromToken: ERC20_TOKEN, toToken: DEST_TOKEN, toChain: 137, fromTokenAmount: 1n, slippage: 0.02 }),
          { name: 'ButterApiError', message: 'Butter /findToken returned invalid decimals for the requested token' }
        )
      })
    }
})
