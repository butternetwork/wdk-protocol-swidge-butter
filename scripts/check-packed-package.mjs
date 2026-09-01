// Copyright 2026 Butter Network
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
const archiveName = `${packageJson.name.replace(/^@/, '').replace('/', '-')}-${packageJson.version}.tgz`
const temporaryRoot = await mkdtemp(join(tmpdir(), 'wdk-swidge-butter-package-'))

try {
  const consumerRoot = join(temporaryRoot, 'consumer')
  const archivePath = join(temporaryRoot, archiveName)
  const smokeTestPath = join(consumerRoot, 'check-package-exports.mjs')

  await run(npmExecutable(), ['pack', '--silent', '--pack-destination', temporaryRoot], repositoryRoot)
  await mkdir(consumerRoot)
  await writeFile(join(consumerRoot, 'package.json'), '{"private":true,"type":"module"}\n')
  await run(npmExecutable(), [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    archivePath,
    '@tetherto/wdk-wallet@1.0.0-beta.17'
  ], consumerRoot)
  await copyFile(join(repositoryRoot, 'scripts/check-package-exports.mjs'), smokeTestPath)
  await run(process.execPath, [smokeTestPath], consumerRoot)
  await run(bareExecutable(), [smokeTestPath], consumerRoot)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

function npmExecutable () {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function bareExecutable () {
  return join(
    repositoryRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'bare.cmd' : 'bare'
  )
}

function run (command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })

    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }

      rejectPromise(new Error(
        `${command} ${args.join(' ')} failed with ${signal == null ? `exit code ${code}` : `signal ${signal}`}`
      ))
    })
  })
}
