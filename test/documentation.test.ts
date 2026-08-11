import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const repositoryRoot = process.cwd()

describe('WDK documentation requirements', () => {
  it('provides installation, configuration, a complete example, and discovery guidance', async () => {
    const readme = await readFile(join(repositoryRoot, 'README.md'), 'utf8')

    const headings = readme.split('\n').filter((line) => line.startsWith('## '))
    for (const heading of [
      '## Install',
      '## Complete example',
      '## Configuration',
      '## Supported chains and tokens'
    ]) {
      assert.equal(headings.includes(heading), true, `Missing ${heading}`)
    }

    const example = section(readme, '## Complete example', '## Configuration')
    for (const snippet of [
      'new ButterSwidgeProtocol(',
      'getSupportedChains()',
      'getSupportedTokens({ fromChain: sourceChainId })',
      'quoteSwidge(options)'
    ]) {
      assert.equal(example.includes(snippet), true, `Complete example is missing ${snippet}`)
    }
    for (const executionOnlyName of ['account', 'viemWalletClient', 'viemPublicClient']) {
      assert.equal(example.includes(executionOnlyName), false, `Complete example unexpectedly includes ${executionOnlyName}`)
    }
  })

  it('documents every Butter status mapping and the same-chain receipt mapping', async () => {
    const readme = await readFile(join(repositoryRoot, 'README.md'), 'utf8')
    const mapping = section(readme, '## Status & fee mapping', '## Safety Defaults')

    assert.deepEqual(markdownTable(mapping, '| Source | Value | `SwidgeStatus` |'), [
      ['Source', 'Value', '`SwidgeStatus`'],
      ['Cross-chain `state` / `status`', '`0`, `crossing`, `pending`', '`pending`'],
      ['Cross-chain `state` / `status`', '`1`, `success`, `completed`', '`completed`'],
      ['Cross-chain `state` / `status`', '`6`, `refund`, `refunded`', '`refunded`'],
      ['Cross-chain `state` / `status`', '`action-required`', '`action-required`'],
      ['Cross-chain `state` / `status`', '`refund-pending`', '`refund-pending`'],
      ['Cross-chain `state` / `status`', '`failed`', '`failed`'],
      ['Cross-chain `state` / `status`', '`cancelled`', '`cancelled`'],
      ['Cross-chain `state` / `status`', '`expired`', '`expired`'],
      ['Cross-chain `state` / `status`', '`partial`', '`partial`'],
      ['Cross-chain `state` / `status`', 'any other / intermediate', '`pending` (never a false terminal)'],
      ['Same-chain receipt', 'explicit success', '`completed`'],
      ['Same-chain receipt', 'explicit revert', '`failed`'],
      ['Same-chain receipt', 'missing / unknown', '`pending`']
    ])
  })

  it('maps every fee source to itemized and legacy fields, including the placeholder', async () => {
    const readme = await readFile(join(repositoryRoot, 'README.md'), 'utf8')
    const mapping = section(readme, '## Status & fee mapping', '## Safety Defaults')

    assert.deepEqual(markdownTable(mapping, '| Butter field | `SwidgeFee.type` | Legacy field | Notes |'), [
      ['Butter field', '`SwidgeFee.type`', 'Legacy field', 'Notes'],
      ['`bridgeFee.in`', '`protocol`', '`bridgeFee`', 'inbound leg of the bridge fee, in **its own** token'],
      ['`bridgeFee.out`', '`protocol`', '`bridgeFee`', 'outbound leg of the bridge fee, in **its own** token'],
      ['`bridgeFee.affiliate`', '`affiliate`', '*(not visible)*', 'integrator/affiliate share — **counted against `maxProtocolFeeBps`**'],
      ['`bridgeFee.amount`', '—', '—', 'never priced; used only to detect that a fee exists which no component describes'],
      ['`gasFee`', '`network`', '`fee`', "source-chain gas; estimate, replaced by measured gas when the sender reports every send's fee"],
      ['`swapFee.nativeFee`', '`protocol`', '`bridgeFee`', 'native-denominated actual swap fee, including any charge configured by `feeConfig`'],
      ['`swapFee.tokenFee`', '`protocol`', '`bridgeFee`', 'input-token-denominated actual swap fee, including any charge configured by `feeConfig`'],
      ['`feeConfig`', '—', '—', 'referrer fee configuration used to validate `/swap` calldata; never added as a separate fee'],
      ['No reported fees', '`network`', '`fee`', 'zero-amount native-token placeholder, so `fees[]` is never empty']
    ])
  })

  it('keeps unreleased changes ahead of the published SemVer release', async () => {
    const changelog = await readFile(join(repositoryRoot, 'CHANGELOG.md'), 'utf8')
    const unreleased = changelog.indexOf('## [Unreleased]')
    const release = changelog.indexOf('## [0.1.0] - 2026-08-04')

    assert.notEqual(unreleased, -1)
    assert.notEqual(release, -1)
    assert.equal(unreleased < release, true)
  })
})

function section (document: string, startHeading: string, endHeading: string): string {
  const start = document.indexOf(startHeading)
  const end = document.indexOf(endHeading, start + startHeading.length)
  assert.notEqual(start, -1, `Missing ${startHeading}`)
  assert.notEqual(end, -1, `Missing ${endHeading}`)
  return document.slice(start, end)
}

function markdownTable (document: string, header: string): string[][] {
  const lines = document.split('\n')
  const start = lines.indexOf(header)
  assert.notEqual(start, -1, `Missing table ${header}`)
  const rows: string[][] = []
  for (const line of lines.slice(start)) {
    if (!line.startsWith('|')) break
    if (/^\|(?:\s*:?-+:?\s*\|)+$/.test(line)) continue
    rows.push(line.slice(1, -1).split('|').map((cell) => cell.trim()))
  }
  return rows
}
