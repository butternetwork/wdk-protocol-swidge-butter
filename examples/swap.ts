import ButterSwidgeProtocol, {
  toEvmPublicClient
} from '@butternetwork/wdk-protocol-swidge-butter'
import { WalletAccountEvm } from '@tetherto/wdk-wallet-evm'
import {
  createPublicClient,
  defineChain,
  http,
  isAddress,
  type Hex
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  assertExecutionConfirmed,
  butterIntegrationFromEnv,
  envOrDefault,
  numberFromEnv,
  positiveBigIntFromEnv,
  printJson,
  requireEnv,
  runExample
} from './shared.js'

const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000'
const BSC_USDT = '0x55d398326f99059fF775485246999027B3197955'

runExample(async () => {
  assertExecutionConfirmed()

  const rpcUrl = requireEnv('RPC_URL')
  const privateKey = privateKeyFromEnv()
  const chainId = integerFromEnv('EXECUTION_CHAIN_ID', 56)
  const fromToken = evmAddressFromEnv('EXECUTION_FROM_TOKEN', NATIVE_TOKEN)
  const toToken = evmAddressFromEnv('EXECUTION_TO_TOKEN', BSC_USDT)
  const account = privateKeyToAccount(privateKey)
  const chain = defineChain({
    id: chainId,
    name: envOrDefault('EXECUTION_CHAIN_NAME', `Chain ${chainId}`),
    nativeCurrency: {
      name: envOrDefault('NATIVE_TOKEN_NAME', 'Native token'),
      symbol: envOrDefault('NATIVE_TOKEN_SYMBOL', 'NATIVE'),
      decimals: 18
    },
    rpcUrls: { default: { http: [rpcUrl] } }
  })
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const wdkAccount = WalletAccountEvm.fromPrivateKey(privateKey, {
    provider: rpcUrl,
    chainId
  })

  const options = {
    fromToken,
    toToken,
    toChain: chainId,
    recipient: account.address,
    fromTokenAmount: positiveBigIntFromEnv('EXECUTION_AMOUNT', process.env, 100000000000000n),
    slippage: numberFromEnv('EXECUTION_SLIPPAGE', process.env, 0.01)
  }
  // Optional: decimals resolve automatically via Butter /findToken when unset.
  const configuredDecimals = process.env.EXECUTION_FROM_TOKEN_DECIMALS
  const tokenDecimals = fromToken.toLowerCase() === NATIVE_TOKEN || configuredDecimals == null
    ? {}
    : { [fromToken]: integerFromEnv('EXECUTION_FROM_TOKEN_DECIMALS') }
  const protocol = new ButterSwidgeProtocol(wdkAccount, {
    sourceChainId: chainId,
    ...butterIntegrationFromEnv(),
    tokenDecimals,
    evm: {
      publicClient: toEvmPublicClient(publicClient)
    }
  })

  const quote = await protocol.quoteSwidge(options)
  printJson({ sender: account.address, options, quote })
  const result = await protocol.swidge(options)
  printJson(result)
})

function privateKeyFromEnv (): Hex {
  const privateKey = requireEnv('PRIVATE_KEY')
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('PRIVATE_KEY must be a 32-byte 0x-prefixed hex value')
  }
  return privateKey as Hex
}

function evmAddressFromEnv (name: string, fallback: string): `0x${string}` {
  const address = envOrDefault(name, fallback)
  if (!isAddress(address, { strict: false })) throw new Error(`${name} must be an EVM address`)
  return address
}

function integerFromEnv (name: string, fallback?: number): number {
  const value = numberFromEnv(name, process.env, fallback)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return value
}
