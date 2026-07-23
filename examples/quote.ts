import ButterSwidgeProtocol from '@butternetwork/wdk-protocol-swidge-butter'

import {
  butterAuthFromEnv,
  envOrDefault,
  numberFromEnv,
  positiveBigIntFromEnv,
  printJson,
  requireEnv,
  runExample
} from './shared.js'

const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000'

runExample(async () => {
  const sourceChainId = envOrDefault('SOURCE_CHAIN_ID', '56')
  const fromToken = envOrDefault('FROM_TOKEN', NATIVE_TOKEN)
  const recipient = process.env.RECIPIENT?.trim()
  const options = {
    fromToken,
    toToken: envOrDefault('TO_TOKEN', NATIVE_TOKEN),
    toChain: envOrDefault('DESTINATION_CHAIN_ID', '137'),
    fromTokenAmount: positiveBigIntFromEnv('FROM_TOKEN_AMOUNT', process.env, 1000000000000000n),
    slippage: numberFromEnv('SLIPPAGE', process.env, 0.02),
    ...(recipient ? { recipient } : {})
  }

  const tokenDecimals = fromToken.toLowerCase() === NATIVE_TOKEN
    ? {}
    : { [fromToken]: numberFromEnv('FROM_TOKEN_DECIMALS') }
  const protocol = new ButterSwidgeProtocol(undefined, {
    sourceChainId,
    entrance: requireEnv('BUTTER_ENTRANCE'),
    ...butterAuthFromEnv(),
    tokenDecimals,
    exposeQuoteOnlyChains: true
  })

  const quote = await protocol.quoteSwidge(options)
  printJson({ options, quote })
})
