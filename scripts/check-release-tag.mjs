import { readFile } from 'node:fs/promises'

const manifestUrl = new URL('../package.json', import.meta.url)
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
const releaseTag = process.argv[2]

if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
  throw new Error('package.json must contain a non-empty version')
}

if (releaseTag == null || releaseTag.length === 0) {
  throw new Error('Release tag is required')
}

const expectedTag = `v${manifest.version}`
if (releaseTag !== expectedTag) {
  throw new Error(`Release tag ${releaseTag} does not match package version ${expectedTag}`)
}

console.log(`Release tag ${releaseTag} matches package version ${manifest.version}`)
