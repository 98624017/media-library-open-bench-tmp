import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const RPC_TIMEOUT_MS = 4000
const SOURCE = fileURLToPath(new URL('./video-memory.py', import.meta.url))

export async function createMemorySampler() {
  const executable =
    process.env.BENCH_PYTHON_PATH ?? (process.platform === 'win32' ? 'python' : 'python3')
  const child = spawn(executable, ['-u', SOURCE], {
    windowsHide: true,
    shell: false,
    timeout: 260_000,
    killSignal: 'SIGKILL',
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const requests = new Map()
  let sequence = 0
  let groupSequence = 0
  let buffered = ''
  let diagnostic = ''
  let stopped = false
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const readyTimer = setTimeout(() => {
    child.kill('SIGKILL')
    readyReject(new Error('Native memory sampler did not initialize'))
  }, RPC_TIMEOUT_MS)
  const closed = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal }))
  )
  const fail = (error) => {
    clearTimeout(readyTimer)
    readyReject(error)
    for (const [id, entry] of requests) {
      clearTimeout(entry.timer)
      entry.reject(error)
      requests.delete(id)
    }
  }
  child.once('error', fail)
  child.stdin.on('error', fail)
  child.once('close', (code, signal) => {
    if (!stopped)
      fail(
        new Error(`Native memory sampler stopped unexpectedly (${code}/${signal}): ${diagnostic}`)
      )
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-1500)
  })
  child.stdout.on('data', (chunk) => {
    buffered += chunk
    try {
      assert(buffered.length < 128 * 1024, 'Native memory sampler output exceeded its bound')
      const lines = buffered.split('\n')
      buffered = lines.pop()
      for (const line of lines) {
        const message = JSON.parse(line)
        if (message.type === 'ready') {
          clearTimeout(readyTimer)
          assert.equal(message.samplingIntervalMs, 100)
          readyResolve(message)
          continue
        }
        const entry = requests.get(message.id)
        assert(entry, 'Native memory sampler returned an unexpected request identity')
        requests.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error)
          entry.reject(new Error(`Native memory sampler rejected a command: ${message.error}`))
        else entry.resolve(message.result)
      }
    } catch (error) {
      child.kill('SIGKILL')
      fail(error)
    }
  })
  function request(command) {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        requests.delete(id)
        child.kill('SIGKILL')
        reject(new Error('Native memory sampler command timed out'))
      }, RPC_TIMEOUT_MS)
      requests.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ ...command, id }) + '\n', (error) => {
        if (!error) return
        clearTimeout(timer)
        requests.delete(id)
        reject(error)
      })
    })
  }
  const metadata = await ready
  assert.equal(metadata.platform, process.platform)
  return {
    metadata,
    async begin() {
      const group = 'row-' + ++groupSequence
      await request({ command: 'begin', group })
      const pendingStops = []
      let closeError
      return {
        async onSpawn(pid) {
          assert(Number.isInteger(pid) && pid > 0)
          await request({ command: 'watch', group, pid })
        },
        onClose(pid) {
          pendingStops.push(
            request({ command: 'stop', pid }).catch((error) => {
              closeError = error
            })
          )
        },
        async finish() {
          await Promise.all(pendingStops)
          if (closeError) throw closeError
          const result = await request({ command: 'finish', group })
          assert(Array.isArray(result.children) && result.children.length > 0)
          for (const record of result.children) {
            assert(Number.isInteger(record.samples) && record.samples >= 0)
            assert.equal(record.missing, record.samples === 0)
            assert(
              record.missing
                ? record.observedPeakRssBytes === null
                : record.observedPeakRssBytes > 0
            )
          }
          return {
            ...result,
            ...metadata,
            simultaneousPeakIsApproximate: true,
            shortPeaksMayBeMissed: true
          }
        }
      }
    },
    async close() {
      const result = await request({ command: 'quit' })
      assert.equal(result.stopped, true)
      stopped = true
      child.stdin.end()
      const exit = await closed
      assert.equal(exit.code, 0, diagnostic)
      assert.equal(requests.size, 0)
    },
    async abort() {
      stopped = true
      child.kill('SIGKILL')
      await closed
    }
  }
}
