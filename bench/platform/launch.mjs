import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The outer process remains responsive even when a measured synchronous call stalls.
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('./run.mjs', import.meta.url)),
    ...process.argv.slice(2)
  ],
  {
    stdio: 'inherit',
    timeout: 295_000,
    killSignal: 'SIGKILL'
  }
)
child.once('error', (error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
child.once('close', (code, signal) => {
  if (signal) process.stderr.write(`Benchmark stopped with signal ${signal}\n`)
  process.exitCode = code ?? 1
})
