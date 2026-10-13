import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const DEADLINE_MS = 285000
const CLEANUP_MS = 9000
const MAX_TOTAL_MS = 295000
const validPid = (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647

async function readOwner(directory, nonce) {
  assert(isAbsolute(directory), 'Owned group registry must be absolute')
  assert(typeof nonce === 'string' && /^[0-9a-f-]{36}$/.test(nonce), 'Missing registry nonce')
  const marker = join(directory, 'owner.json')
  const metadata = await lstat(marker)
  assert(metadata.isFile() && !metadata.isSymbolicLink(), 'Invalid registry marker')
  const owner = JSON.parse(await readFile(marker, 'utf8'))
  assert.equal(owner.nonce, nonce, 'Registry owner differs')
  assert(validPid(owner.pid), 'Invalid supervisor identity')
  return owner
}

// Detached fixtures must register before beginning long-lived work and retain their record through leaf cleanup.
export async function registerOwnedGroup(pid, { env = process.env } = {}) {
  const directory = env.BENCH_OWNED_GROUP_REGISTRY
  const nonce = env.BENCH_OWNED_GROUP_NONCE
  if (!directory && !nonce) return async () => {}
  assert(validPid(pid), 'Invalid owned group PID')
  const owner = await readOwner(directory, nonce)
  assert.notEqual(pid, owner.pid, 'Supervisor cannot register itself')
  const target = join(directory, `${pid}.json`)
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ pid, kind: 'detached-process-group', nonce }), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
  return async () => {
    await rm(target, { force: true })
  }
}

async function readOwnedGroups(directory, nonce) {
  const owner = await readOwner(directory, nonce)
  const entries = await readdir(directory, { withFileTypes: true })
  const groups = []
  for (const entry of entries) {
    if (entry.name === 'owner.json' || /^\d+\.json\.[0-9a-f-]+\.tmp$/.test(entry.name)) continue
    const matched = /^(\d+)\.json$/.exec(entry.name)
    assert(matched && entry.isFile() && !entry.isSymbolicLink(), 'Invalid owned group entry')
    const pid = Number(matched[1])
    assert(validPid(pid) && pid !== owner.pid, 'Invalid registered group PID')
    let raw
    try {
      raw = await readFile(join(directory, entry.name), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') continue // The fixture finished cleanup after the directory read.
      throw error
    }
    const record = JSON.parse(raw)
    assert.equal(record.pid, pid, 'Registered filename and PID differ')
    assert.equal(record.kind, 'detached-process-group', 'Unsupported registered ownership')
    assert.equal(record.nonce, nonce, 'Registered group belongs to another supervisor')
    groups.push(pid)
  }
  return groups
}

async function stopTree(pid, timeoutMs) {
  assert(validPid(pid))
  assert(timeoutMs >= 1, 'Process tree cleanup deadline exceeded')
  if (process.platform === 'win32') {
    try {
      // Await command close: stopping the immediate child alone does not confirm /T completed.
      await execute('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: Math.floor(timeoutMs),
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 8192
      })
      return { method: 'taskkill /T /F', alreadyExited: false }
    } catch (error) {
      try {
        process.kill(pid, 0)
      } catch (observation) {
        if (observation.code === 'ESRCH') return { method: 'taskkill /T /F', alreadyExited: true }
        throw observation
      }
      throw error
    }
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if (error.code === 'ESRCH') return { method: 'negative-pid SIGKILL', alreadyExited: true }
    throw error
  }
  const deadline = performance.now() + timeoutMs
  while (true) {
    const remaining = Math.floor(deadline - performance.now())
    assert(remaining > 0, 'Owned process group did not stop before cleanup deadline')
    const { stdout } = await execute('ps', ['-ax', '-o', 'pgid=,stat='], {
      timeout: Math.min(remaining, 1000),
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024
    })
    const active = stdout.split('\n').some((line) => {
      const [group, state] = line.trim().split(/\s+/)
      return Number(group) === pid && state && !/^[ZX]/.test(state)
    })
    // Zombies cannot execute or hold file descriptors; their adopter controls reaping.
    if (!active) return { method: 'negative-pid SIGKILL', alreadyExited: false }
    await delay(Math.min(20, remaining))
  }
}

async function reclaimGroups(directory, nonce, deadline) {
  const groups = await readOwnedGroups(directory, nonce)
  const results = []
  for (const pid of groups) {
    results.push({ pid, ...(await stopTree(pid, deadline - performance.now())) })
    await rm(join(directory, `${pid}.json`), { force: true })
  }
  return results
}

export async function runWithDeadline(
  command,
  args,
  { deadlineMs = DEADLINE_MS, cleanupMs = CLEANUP_MS, stdio = 'inherit', env = process.env } = {}
) {
  assert(Number.isInteger(deadlineMs) && deadlineMs > 0)
  assert(Number.isInteger(cleanupMs) && cleanupMs > 0 && deadlineMs + cleanupMs <= MAX_TOTAL_MS)
  const registry = await mkdtemp(join(tmpdir(), 'bench-owned-groups-'))
  const nonce = randomUUID()
  await writeFile(join(registry, 'owner.json'), JSON.stringify({ pid: process.pid, nonce }), 'utf8')
  let child
  let stdout = ''
  let stderr = ''
  let timer
  let cleanupTimer
  try {
    child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio,
      env: { ...env, BENCH_OWNED_GROUP_REGISTRY: registry, BENCH_OWNED_GROUP_NONCE: nonce }
    })
    child.stdout?.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-4096)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096)
    })
    const closed = new Promise((resolve) => {
      child.once('error', (error) =>
        resolve({ reason: 'spawn-error', code: null, signal: null, errorCode: error.code })
      )
      child.once('close', (code, signal) => resolve({ reason: 'exit', code, signal }))
    })
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ reason: 'deadline' }), deadlineMs)
    })
    const first = await Promise.race([closed, timeout])
    clearTimeout(timer)
    const cleanupDeadline = performance.now() + cleanupMs
    const cleanup = async () => {
      const errors = []
      const reclaim = async () => {
        try {
          return await reclaimGroups(registry, nonce, cleanupDeadline)
        } catch (error) {
          errors.push(error)
          return []
        }
      }
      const registered = await reclaim()
      let mainGroup
      if (
        first.reason === 'deadline' ||
        (first.reason === 'exit' && process.platform !== 'win32')
      ) {
        try {
          mainGroup = await stopTree(child.pid, cleanupDeadline - performance.now())
        } catch (error) {
          errors.push(error)
        }
      }
      const exit = first.reason === 'deadline' ? await closed : first
      const lateRegistered = await reclaim()
      if (errors.length)
        throw new AggregateError(errors, errors.map((error) => error.message).join('; '))
      assert(
        first.reason === 'deadline' || registered.length + lateRegistered.length === 0,
        'Natural exit left registered process groups; they were reclaimed'
      )
      return {
        ...exit,
        reason: first.reason,
        mainGroup,
        registered: [...registered, ...lateRegistered],
        stdout,
        stderr
      }
    }
    const cleanupExpiry = new Promise((_resolve, reject) => {
      cleanupTimer = setTimeout(
        () => reject(new Error('Supervisor process cleanup deadline exceeded')),
        cleanupMs
      )
    })
    return await Promise.race([cleanup(), cleanupExpiry])
  } catch (error) {
    // Preserve the cleanup failure, while making a final attempt to stop this owned immediate child.
    if (child?.pid) {
      try {
        child.kill('SIGKILL')
      } catch (fallback) {
        if (fallback.code !== 'ESRCH')
          throw new AggregateError([error, fallback], 'Tree cleanup and direct fallback failed')
      }
    }
    const failure = new Error(error.message, { cause: error })
    failure.stdout = stdout
    failure.stderr = stderr
    throw failure
  } finally {
    clearTimeout(timer)
    clearTimeout(cleanupTimer)
    await rm(registry, { recursive: true, force: true })
  }
}
