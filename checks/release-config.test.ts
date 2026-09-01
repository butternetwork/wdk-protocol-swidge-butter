import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

interface PackageManifest {
  name?: string
  version?: string
  repository?: { type?: string, url?: string }
  bugs?: { url?: string }
  homepage?: string
  publishConfig?: { access?: string, registry?: string }
  exports?: Record<string, Record<string, string>>
  files?: string[]
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const repositoryRoot = process.cwd()

describe('npm release configuration', () => {
  it('publishes the package from the canonical public repository and registry', async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, 'package.json'), 'utf8')
    ) as PackageManifest

    assert.equal(packageJson.name, '@butternetwork/wdk-protocol-swidge-butter')
    assert.deepEqual(packageJson.repository, {
      type: 'git',
      url: 'git+https://github.com/butternetwork/wdk-protocol-swidge-butter.git'
    })
    assert.deepEqual(packageJson.bugs, {
      url: 'https://github.com/butternetwork/wdk-protocol-swidge-butter/issues'
    })
    assert.equal(
      packageJson.homepage,
      'https://github.com/butternetwork/wdk-protocol-swidge-butter#readme'
    )
    assert.deepEqual(packageJson.publishConfig, {
      access: 'public',
      registry: 'https://registry.npmjs.org'
    })
  })

  it('publishes the security policy with the npm package', async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, 'package.json'), 'utf8')
    ) as PackageManifest

    assert.ok(packageJson.files?.includes('SECURITY.md'))
  })

  it('publishes the reviewed Built with WDK badge with the package', async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, 'package.json'), 'utf8')
    ) as PackageManifest

    assert.equal(packageJson.files?.includes('docs/assets/built-with-wdk.png'), true)
  })

  it('publishes and tests the Bare conditional entry with direct runtime support', async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, 'package.json'), 'utf8')
    ) as PackageManifest

    assert.deepEqual(packageJson.exports?.['.'], {
      types: './dist/index.d.ts',
      bare: './bare.js',
      import: './dist/index.js',
      default: './dist/index.js'
    })
    assert.equal(packageJson.dependencies?.['bare-node-runtime'], '^1.4.0')
    assert.equal(packageJson.devDependencies?.bare, '1.31.2')
    assert.equal(packageJson.files?.includes('bare.js'), true)
    assert.equal(
      packageJson.scripts?.['test:bare'],
      'npm run build --silent && node scripts/check-package-exports.mjs && bare scripts/check-package-exports.mjs && node scripts/check-packed-package.mjs'
    )

    const packedPackageCheck = await readFile(
      join(repositoryRoot, 'scripts/check-packed-package.mjs'),
      'utf8'
    )

    assert.match(packedPackageCheck, /npmExecutable\(\), \['pack', '--silent', '--pack-destination', temporaryRoot\]/)
    assert.match(packedPackageCheck, /archivePath,\n\s+'@tetherto\/wdk-wallet@1\.0\.0-beta\.17'/)
    assert.match(packedPackageCheck, /await run\(process\.execPath, \[smokeTestPath\], consumerRoot\)/)
    assert.match(packedPackageCheck, /await run\(bareExecutable\(\), \[smokeTestPath\], consumerRoot\)/)
    assert.match(packedPackageCheck, /await rm\(temporaryRoot, \{ recursive: true, force: true \}\)/)
  })

  it('publishes GitHub Releases through OIDC without a long-lived npm token', async () => {
    const workflow = await readFile(
      join(repositoryRoot, '.github/workflows/publish.yml'),
      'utf8'
    )

    assert.match(workflow, /^on:\n  release:\n    types: \[published\]$/m)
    assert.match(workflow, /^\s+id-token: write$/m)
    assert.match(workflow, /^\s+contents: read$/m)
    assert.match(workflow, /uses: actions\/checkout@v6/)
    assert.match(workflow, /uses: actions\/setup-node@v6/)
    assert.match(workflow, /node-version: 24/)
    assert.match(workflow, /registry-url: 'https:\/\/registry\.npmjs\.org'/)
    assert.match(workflow, /package-manager-cache: false/)
    assert.match(workflow, /npm install --global npm@11/)
    assert.match(workflow, /npm ci/)
    assert.match(workflow, /npm test/)
    assert.match(workflow, /npm run typecheck/)
    assert.match(workflow, /npm run test:bare/)
    assert.match(workflow, /npm run build/)
    assert.match(workflow, /npm pack --dry-run/)
    assert.match(workflow, /node scripts\/check-release-tag\.mjs "\$RELEASE_TAG"/)
    assert.match(workflow, /github\.event\.release\.prerelease && 'next' \|\| 'latest'/)
    assert.match(workflow, /npm publish --tag "\$NPM_TAG"/)
    assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./)
    assert.ok(workflow.indexOf('npm run test:bare') < workflow.indexOf('npm publish --tag'))
  })

  it('skips an identical published version and fails closed on registry ambiguity', async () => {
    const workflow = await readFile(
      join(repositoryRoot, '.github/workflows/publish.yml'),
      'utf8'
    )

    const registryCheck = workflow.indexOf('- name: Check npm publication state')
    const publishStep = workflow.indexOf('- name: Publish package')

    assert.notEqual(registryCheck, -1)
    assert.notEqual(publishStep, -1)
    assert.ok(registryCheck < publishStep)
    assert.match(workflow, /id: npm_state/)
    assert.match(workflow, /\['rev-parse', 'HEAD'\]/)
    assert.match(workflow, /\['view', `\$\{name\}@\$\{version\}`, 'gitHead', '--json'\]/)
    assert.match(workflow, /\\bE404\\b/)
    assert.match(workflow, /GITHUB_OUTPUT/)
    assert.match(workflow, /already exists at/)
    assert.match(workflow, /npm view failed/)
    assert.match(workflow, /if: steps\.npm_state\.outputs\.publish == 'true'/)
  })

  it('accepts only a release tag matching the package version', async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, 'package.json'), 'utf8')
    ) as PackageManifest
    const expectedTag = `v${packageJson.version}`

    const accepted = spawnSync(process.execPath, [
      'scripts/check-release-tag.mjs',
      expectedTag
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.match(accepted.stdout, new RegExp(`Release tag ${expectedTag.replaceAll('.', '\\.')}`))

    const rejected = spawnSync(process.execPath, [
      'scripts/check-release-tag.mjs',
      `${expectedTag}-wrong`
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /does not match package version/)
  })
})
