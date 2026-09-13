import { test } from 'node:test'

import { runFundedScenario } from './funded.js'

test('executes a funded same-chain ERC20 swidge with approval', { timeout: 4 * 60_000 }, async () => {
  await runFundedScenario('same-erc20')
})
