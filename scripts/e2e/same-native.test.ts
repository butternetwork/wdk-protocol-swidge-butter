import { test } from 'node:test'

import { runFundedScenario } from './funded.js'

test('executes a funded same-chain native-token swidge', { timeout: 4 * 60_000 }, async () => {
  await runFundedScenario('same-native')
})
