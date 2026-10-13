import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { supervisorReceipt } from '../extended/launch.mjs'
import { saveReport } from '../extended/report-file.mjs'
import { runWithDeadline } from '../extended/termination.mjs'
import { FIXTURES } from './fixtures.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const fixture = option('fixture')
const label = option('label', `${process.platform}-${process.arch}`)
assert(FIXTURES.includes(fixture) && /^[A-Za-z0-9_-]+$/.test(label))
const outputDirectory = resolve(option('output', `results/clipboard-${label}-${fixture}`))
// Refuse to reuse another stage's evidence directory.
await mkdir(dirname(outputDirectory), { recursive: true })
await mkdir(outputDirectory, { recursive: false })
const context = {
  suite: 'clipboard-writer',
  fixture,
  label,
  sourceRevision: process.env.BENCH_SOURCE_REVISION ?? null
}
const path = join(outputDirectory, 'supervisor.json')
await saveReport(path, supervisorReceipt(context))
let result
let error
try {
  result = await runWithDeadline(process.execPath, [
    fileURLToPath(new URL('./run.mjs', import.meta.url)),
    ...args
  ])
} catch (failure) {
  error = failure
}
const receipt = supervisorReceipt(context, result, error)
await saveReport(path, receipt)
if (!receipt.completed)
  process.stderr.write(`Clipboard probe remains partial: ${receipt.error?.message}\n`)
process.exitCode = receipt.exitCode
