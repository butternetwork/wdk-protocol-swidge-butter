import { test } from 'node:test'

import { runFundedScenario } from './funded.js'

test('executes a funded cross-chain native-token swidge', { timeout: 48 * 60_000 }, async () => {
  await runFundedScenario('cross-native')
})
