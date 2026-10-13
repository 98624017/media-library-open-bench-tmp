import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { registerOwnedGroup } from './termination.mjs'

const LOG_LIMIT = 32_768
const CHILD_PATH = fileURLToPath(import.meta.url)

export async function stopProcessTree(pid) {
  assert(Number.isInteger(pid) && pid > 0)
  if (process.platform === 'win32') {
    const result = await runProcess('taskkill', ['/pid', String(pid), '/T', '/F'], {
      timeoutMs: 5000
    })
    return { method: 'taskkill /T /F', exitCode: result.code, reason: result.reason }
  }
  try {
    process.kill(-pid, 'SIGKILL')
    return { method: 'negative-pid SIGKILL', exitCode: 0 }
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
    return { method: 'negative-pid SIGKILL', exitCode: 0, alreadyExited: true }
  }
}

export async function runProcess(executable, args, options = {}) {
  const {
    timeoutMs = 15_000,
    signal,
    tree = false,
    detached = tree,
    onStdout,
    onSpawn,
    onClose
  } = options
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 295_000)
  if (signal?.aborted) return { code: null, reason: 'cancelled', pid: null }
  const startedAt = performance.now()
  const child = spawn(executable, args, {
    windowsHide: true,
    shell: false,
    detached: detached && process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let reason = null
  let stdout = ''
  let stderr = ''
  let killResult = null
  let killPending = Promise.resolve()
  const stop = (cause) => {
    if (reason || !child.pid) return
    reason = cause
    if (tree) {
      killPending = stopProcessTree(child.pid)
        .then((result) => {
          killResult = result
          if (result.exitCode !== 0) child.kill('SIGKILL')
        })
        .catch((error) => {
          killResult = {
            method: 'tree kill failed; direct fallback',
            errorCode: error.code ?? 'unknown'
          }
          child.kill('SIGKILL')
        })
    } else child.kill('SIGKILL')
  }
  const abort = () => stop('cancelled')
  const timer = setTimeout(() => stop('timeout'), timeoutMs)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout = (stdout + chunk).slice(-LOG_LIMIT)
    onStdout?.(chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-LOG_LIMIT)
  })
  try {
    const pendingResult = new Promise((resolveResult, reject) => {
      child.once('error', reject)
      child.once('close', (code, exitSignal) => {
        try {
          onClose?.(child.pid)
          resolveResult({ code, signal: exitSignal })
        } catch (error) {
          reject(error)
        }
      })
    })
    const registration = Promise.resolve()
      .then(() => (child.pid ? onSpawn?.(child.pid) : undefined))
      .catch(async (error) => {
        if (child.pid) {
          if (detached) await stopProcessTree(child.pid)
          else child.kill('SIGKILL')
        }
        await pendingResult.catch(() => undefined)
        throw error
      })
    const [result] = await Promise.all([pendingResult, registration])
    // Windows taskkill is itself asynchronous; process.close alone does not prove tree cleanup.
    await killPending
    return {
      ...result,
      reason,
      pid: child.pid,
      stdout,
      stderr,
      killResult,
      wallMs: Math.round((performance.now() - startedAt) * 100) / 100
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

export async function isProcessAlive(pid) {
  assert(Number.isInteger(pid) && pid > 0)
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code !== 'EPERM') throw error
  }
  if (process.platform === 'linux') {
    try {
      const state = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').at(-1)[0]
      return state !== 'Z' && state !== 'X'
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return false
      throw error
    }
  }
  if (process.platform === 'darwin') {
    const status = await runProcess('ps', ['-o', 'stat=', '-p', String(pid)], { timeoutMs: 3000 })
    assert.equal(status.reason, null, 'process-state observation timed out')
    assert([0, 1].includes(status.code), 'process-state observation failed')
    return status.code === 0 && !status.stdout.trim().startsWith('Z')
  }
  return true
}

export async function waitForExit(pid, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  while (await isProcessAlive(pid)) {
    if (performance.now() >= deadline) return false
    await delay(40)
  }
  return true
}

export async function observeProcessTree({ tree, timeout = false }) {
  const controller = new AbortController()
  let descendantPid = null
  let ready = false
  let pending = ''
  let cancelTimer
  let result
  let unregister = async () => {}
  let unregisterLeaf = async () => {}
  let leafRegistration = Promise.resolve()
  let leafRegistrationError
  let parentPid
  let observation
  let ownedCleanupComplete = false
  try {
    result = await runProcess(process.execPath, [CHILD_PATH, 'parent'], {
      tree,
      detached: true,
      timeoutMs: timeout ? 3000 : 9000,
      signal: controller.signal,
      onSpawn: async (pid) => {
        parentPid = pid
        unregister = await registerOwnedGroup(pid)
      },
      onStdout(chunk) {
        pending += chunk
        const lines = pending.split('\n')
        pending = lines.pop()
        for (const line of lines) {
          if (ready) continue
          const message = JSON.parse(line)
          assert(Number.isInteger(message.descendantPid) && message.descendantPid > 0)
          assert(descendantPid === null || descendantPid === message.descendantPid)
          if (descendantPid === null && process.platform === 'win32') {
            leafRegistration = registerOwnedGroup(message.descendantPid)
              .then((release) => {
                unregisterLeaf = release
              })
              .catch((error) => {
                leafRegistrationError = error
                controller.abort(error)
              })
          }
          descendantPid = message.descendantPid
          if (!message.ready) continue
          ready = true
          if (!timeout)
            leafRegistration.then(() => {
              if (!leafRegistrationError) cancelTimer = setTimeout(() => controller.abort(), 120)
            })
        }
      }
    })
    await leafRegistration
    if (leafRegistrationError) throw leafRegistrationError
    assert(ready, `tree fixture leaf was not ready (exit=${result.code}, reason=${result.reason})`)
    const parentStopped = await waitForExit(result.pid)
    const descendantSurvived = await isProcessAlive(descendantPid)
    const descendantStopped = tree ? await waitForExit(descendantPid) : !descendantSurvived
    observation = {
      reason: result.reason,
      terminationMs: result.wallMs,
      killResult: result.killResult,
      descendantSurvived,
      counterexampleObserved: !tree && descendantSurvived,
      checks: {
        fixtureReady: ready,
        parentStopped,
        ...(tree ? { descendantStopped } : {})
      }
    }
  } finally {
    clearTimeout(cancelTimer)
    await leafRegistration
    // Only the PID returned by this owned fixture may be reclaimed.
    if (descendantPid && (await isProcessAlive(descendantPid))) {
      try {
        process.kill(descendantPid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
      assert(await waitForExit(descendantPid), 'owned descendant did not exit during cleanup')
    }
    if (parentPid) assert(await waitForExit(parentPid), 'owned parent did not exit during cleanup')
    await unregisterLeaf()
    await unregister()
    ownedCleanupComplete = true
  }
  return { ...observation, checks: { ...observation.checks, ownedCleanupComplete } }
}

if (process.argv[1] && resolve(process.argv[1]) === CHILD_PATH) {
  assert(['parent', 'leaf'].includes(process.argv[2]))
  let keepAlive
  if (process.argv[2] === 'parent') {
    // The child must prove registry ownership itself before spawning a long-lived leaf.
    // Its caller retains the record until both PIDs have been reclaimed.
    await registerOwnedGroup(process.pid)
    const leaf = spawn(process.execPath, [CHILD_PATH, 'leaf'], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    leaf.once('error', (error) => {
      console.error(error.message)
      process.exitCode = 1
    })
    let leafReady = false
    leaf.once('spawn', () =>
      process.stdout.write(JSON.stringify({ descendantPid: leaf.pid, ready: false }) + '\n')
    )
    leaf.once('message', (message) => {
      assert(message?.type === 'leaf-ready' && message.pid === leaf.pid)
      leafReady = true
      process.stdout.write(JSON.stringify({ descendantPid: leaf.pid, ready: true }) + '\n')
    })
    leaf.once('exit', () => {
      if (leafReady) return
      clearInterval(keepAlive)
      process.exitCode = 1
    })
  } else if (process.platform === 'win32') await registerOwnedGroup(process.pid)
  keepAlive = setInterval(() => {}, 1000)
  if (process.argv[2] === 'leaf') process.send?.({ type: 'leaf-ready', pid: process.pid })
}
