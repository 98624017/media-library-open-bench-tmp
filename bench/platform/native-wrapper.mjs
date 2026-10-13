import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'

export async function runNativeCacheBench({
  quick,
  cachePolicy,
  emit,
  outputDirectory
}) {
  assert(
    ['win32', 'darwin'].includes(process.platform),
    'Native cache suite targets Windows/macOS'
  )
  const output = join(outputDirectory, `native-${cachePolicy}.json`)
  const ownedRoot = await mkdtemp(join(os.tmpdir(), 'native-electron-policy-'))
  const userData = join(ownedRoot, 'user-data')
  await mkdir(userData)
  const args = [
    resolve('bench/platform/native-cache.cjs'),
    `--policy=${cachePolicy}`,
    `--report=${output}`,
    `--quick=${quick}`,
    `--user-data=${userData}`
  ]
  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  try {
    await new Promise((done, reject) => {
      const child = spawn(electronPath, args, {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 90_000,
        killSignal: 'SIGKILL',
        windowsHide: true
      })
      let diagnostics = ''
      child.stdout.on('data', (chunk) => {
        diagnostics = `${diagnostics}${chunk}`.slice(-2000)
      })
      child.stderr.on('data', (chunk) => {
        diagnostics = `${diagnostics}${chunk}`.slice(-2000)
      })
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (code !== 0)
          reject(
            new Error(
              `Native cache subprocess failed: ${code}/${signal}; ${diagnostics}`
            )
          )
        else done()
      })
    })
    const result = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(result.completed, true)
    assert.equal(result.rows.length, 5)
    assert.equal(result.policy, cachePolicy)
    assert.equal(result.platform, process.platform)
    assert.equal(result.arch, process.arch)
    assert.equal(result.isolatedUserData, true)
    assert.equal(result.runtime.electron, '39.8.3')
    for (const row of result.rows)
      await emit({
        ...row,
        runtime: result.runtime,
        sharpVersions: result.sharp,
        nativePlatform: result.platform,
        nativeArch: result.arch,
        isolatedUserData: true
      })
    return result.rows
  } finally {
    // Electron has exited, so only this launch's fixtures and user data are reclaimed.
    await rm(ownedRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100
    })
  }
}
