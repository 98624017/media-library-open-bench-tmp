import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

export async function runNativeBench({ base, suite, quick, sampleCount, emit, outputDirectory }) {
  const userData = join(base, 'electron-user-data')
  await mkdir(userData)
  const output = join(outputDirectory, 'native-report.json')
  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  const args = [
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    fileURLToPath(new URL('./native-main.cjs', import.meta.url)),
    `--suite=${suite}`,
    `--base=${base}`,
    `--output=${output}`,
    `--samples=${sampleCount}`,
    `--user-data=${userData}`,
    ...(quick ? ['--quick'] : [])
  ]
  let diagnostic = ''
  const exit = await new Promise((done, reject) => {
    const child = spawn(electronPath, args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 260_000,
      killSignal: 'SIGKILL',
      windowsHide: true
    })
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data) => {
        diagnostic = `${diagnostic}${data}`.slice(-2500)
      })
    child.once('error', reject)
    child.once('close', (code, signal) => done({ code, signal }))
  })
  let result
  try {
    result = JSON.parse(await readFile(output, 'utf8'))
  } catch (error) {
    throw new Error(
      `Native report absent (${exit.code}/${exit.signal}): ${error.code}; ${diagnostic}`
    )
  }
  for (const row of result.rows) await emit(row)
  assert.equal(exit.code, 0, `Native suite failed: ${JSON.stringify(result.error ?? exit)}`)
  assert.equal(result.completed, true)
  assert.equal(result.runtime.electron, '39.8.3')
  assert.equal(result.platform, process.platform)
  assert.equal(result.arch, process.arch)
  assert.equal(result.isolatedUserData, true)
  return {
    ...result.summary,
    runtime: result.runtime,
    nativePlatform: result.platform,
    nativeArch: result.arch
  }
}
