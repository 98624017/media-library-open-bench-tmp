import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import electronPath from 'electron'
import { measure } from '../platform/metrics.mjs'

export const PROFILES = [
  { scenario: 'cold-handshake', variant: 'electron' },
  ...['in-process', 'node-spawn', 'rust-spawn'].map((variant) => ({
    scenario: 'cli-query',
    variant
  })),
  { scenario: 'duplicate-launch', variant: 'single-instance-lock' },
  { scenario: 'forced-restart', variant: 'new-process-handshake' }
]
const childScript = fileURLToPath(new URL('./lifecycle-child.cjs', import.meta.url))
const nodeCli = fileURLToPath(new URL('./cli-probe.mjs', import.meta.url))

export function parseDiscovery(raw) {
  const value = JSON.parse(raw)
  assert(Number.isInteger(value.port) && value.port > 0 && value.port <= 65535)
  assert(Number.isInteger(value.pid) && value.pid > 0)
  return value
}

async function execute(command, args, { env = process.env, timeout = 15_000 } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout,
      killSignal: 'SIGKILL'
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (bytes) => {
      stdout = `${stdout}${bytes}`.slice(-20_000)
    })
    child.stderr.on('data', (bytes) => {
      stderr = `${stderr}${bytes}`.slice(-2000)
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code !== 0) reject(new Error(`Fixture child failed (${code}/${signal}): ${stderr}`))
      else done(stdout)
    })
  })
}

async function query(port) {
  return new Promise((done, reject) => {
    const request = http.get(
      { hostname: '127.0.0.1', port, path: '/state', timeout: 3000 },
      (response) => {
        let body = ''
        response.on('data', (bytes) => {
          body += bytes
          if (body.length > 16_384) request.destroy(new Error('Oversized body'))
        })
        response.once('error', reject)
        response.once('end', () => {
          try {
            assert.equal(response.statusCode, 200)
            done(JSON.parse(body))
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    request.once('timeout', () => request.destroy(new Error('Query timeout')))
    request.once('error', reject)
  })
}

function start(args, env) {
  const child = spawn(electronPath, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 60_000,
    killSignal: 'SIGKILL'
  })
  let diagnostic = ''
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (bytes) => {
      diagnostic = `${diagnostic}${bytes}`.slice(-1500)
    })
  const closed = new Promise((done, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => done({ code, signal }))
  })
  // The observer handles early failures even while readiness is being polled.
  closed.catch(() => {})
  return { child, closed, diagnostic: () => diagnostic }
}

async function waitReady(discoveryFile, processHandle) {
  const deadline = performance.now() + 12_000
  while (performance.now() < deadline) {
    try {
      const discovery = parseDiscovery(await readFile(discoveryFile, 'utf8'))
      const state = await query(discovery.port)
      assert.equal(state.ready, true)
      assert.equal(state.pid, discovery.pid)
      assert.equal(state.runtime.electron, '39.8.3')
      assert.equal(state.platform, process.platform)
      assert.equal(state.arch, process.arch)
      return { ...discovery, runtime: state.runtime }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null)
      throw new Error(`Electron exited before handshake: ${processHandle.diagnostic()}`)
    await delay(10)
  }
  throw new Error(`Electron readiness deadline: ${processHandle.diagnostic()}`)
}

export async function runBench({ base, quick, sampleCount, emit }) {
  const install = join(base, '安装 空格 路径')
  await mkdir(install)
  const rustCli = join(install, process.platform === 'win32' ? '客户端 查询.exe' : '客户端 查询')
  const rustVersion = (await execute('rustc', ['--version'])).trim()
  await execute(
    'rustc',
    [
      '-O',
      '--edition=2021',
      '--crate-name=synthetic_cli',
      fileURLToPath(new URL('./cli-probe.rs', import.meta.url)),
      '-o',
      rustCli
    ],
    { timeout: 60_000 }
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const repeats = quick ? 1 : 4
  let nativeRuntime
  for (let sample = 0; sample < sampleCount; sample++) {
    const root = await mkdtemp(join(install, '实例-'))
    const discoveryFile = join(root, '发现 端口.json')
    const userData = join(root, 'user-data')
    await mkdir(userData)
    const args = [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      childScript,
      `--user-data=${userData}`,
      `--discovery=${discoveryFile}`
    ]
    let primary
    try {
      const cold = await measure(async () => {
        primary = start(args, env)
        return waitReady(discoveryFile, primary)
      })
      const discovery = cold.value
      nativeRuntime = discovery.runtime
      await emit({
        suite: 'lifecycle',
        scenario: 'cold-handshake',
        variant: 'electron',
        sample,
        workload: { starts: 1, isolatedUserData: true, unicodePath: true },
        metrics: cold.metrics,
        checks: { readyStateMatched: true },
        childPidObserved: Number.isInteger(discovery.pid)
      })
      const variants = ['in-process', 'node-spawn', 'rust-spawn']
      const rotated = variants.slice(sample % 3).concat(variants.slice(0, sample % 3))
      for (const variant of rotated) {
        const measured = await measure(async () => {
          const states = []
          for (let index = 0; index < repeats; index++) {
            if (variant === 'in-process') {
              const latest = parseDiscovery(await readFile(discoveryFile, 'utf8'))
              states.push(await query(latest.port))
            } else {
              const stdout =
                variant === 'node-spawn'
                  ? await execute(process.execPath, [nodeCli, discoveryFile])
                  : await execute(rustCli, [discoveryFile])
              states.push(JSON.parse(stdout))
            }
          }
          return states
        })
        for (const state of measured.value) {
          assert.equal(state.ready, true)
          assert.equal(state.pid, discovery.pid)
        }
        await emit({
          suite: 'lifecycle',
          scenario: 'cli-query',
          variant,
          sample,
          workload: { queries: repeats, discoveryReadIncluded: true, unicodePath: true },
          metrics: measured.metrics,
          checks: { allQueriesMatchPrimary: true }
        })
      }
      const duplicate = await measure(async () => {
        const secondary = start(args, env)
        const exit = await secondary.closed
        assert.equal(exit.code, 0)
        const deadline = performance.now() + 3000
        let state
        do {
          state = await query(discovery.port)
          if (state.duplicateLaunches > 0) return state
          await delay(10)
        } while (performance.now() < deadline)
        throw new Error('Primary did not observe duplicate launch')
      })
      assert.equal(duplicate.value.pid, discovery.pid)
      assert.equal(duplicate.value.duplicateLaunches, 1)
      await emit({
        suite: 'lifecycle',
        scenario: 'duplicate-launch',
        variant: 'single-instance-lock',
        sample,
        workload: { duplicates: 1, sameUserData: true },
        metrics: duplicate.metrics,
        checks: { secondaryExited: true, primaryReused: true, oneEventObserved: true }
      })
      primary.child.kill('SIGKILL')
      await primary.closed
      await rm(discoveryFile)
      const restarted = await measure(async () => {
        primary = start(args, env)
        return waitReady(discoveryFile, primary)
      })
      assert.notEqual(restarted.value.pid, discovery.pid)
      await emit({
        suite: 'lifecycle',
        scenario: 'forced-restart',
        variant: 'new-process-handshake',
        sample,
        workload: { restarts: 1, sameUserData: true },
        metrics: restarted.metrics,
        checks: { newPidReady: true, lockReleasedAfterKill: true }
      })
    } finally {
      if (primary) {
        primary.child.kill('SIGKILL')
        await primary.closed
      }
      await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  }
  return {
    runtime: { ...nativeRuntime, rust: rustVersion },
    calibration:
      'Real Electron requestSingleInstanceLock and readiness/loopback primitives, std-only compiled Rust client and Node client',
    limits: [
      'Generic fixture CLI, not the product Rust CLI or installation resolver',
      'Synthetic app has no product startup modules, recovery data or visible window',
      'Parent Node RSS/CPU excludes Electron, Chromium and CLI child resources',
      'GPU disabled; no sleep/wake or updater certification'
    ]
  }
}
