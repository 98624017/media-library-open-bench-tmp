import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, statfs } from 'node:fs/promises'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { SUITES, profilesFor, validateReport } from './validation.mjs'
import { saveReport } from './report-file.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const suite = option('suite')
const label = option('label', `${process.platform}-${process.arch}`)
const quick = args.includes('--quick')
const sampleCount = Number(option('samples', quick ? '1' : '3'))
assert(SUITES.includes(suite), 'Unknown suite')
assert(/^[A-Za-z0-9_-]+$/.test(label), 'Invalid label')
assert(Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 5)
const outputDirectory = resolve(option('output', `results/extended-${label}-${suite}`))
await mkdir(outputDirectory, { recursive: true })
const base = await mkdtemp(join(os.tmpdir(), `extended-${suite}-`))
const filesystem = await statfs(base)
const report = {
  schemaVersion: 1,
  completed: false,
  cleanedOwnedRoot: false,
  suite,
  label,
  quick,
  sampleCount,
  environment: {
    platform: process.platform,
    arch: process.arch,
    runtime: process.versions,
    kernel: os.release(),
    osVersion: os.version(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    filesystem: { type: filesystem.type, blockSize: filesystem.bsize },
    sourceRevision: process.env.BENCH_SOURCE_REVISION ?? null
  },
  measurement: {
    heartbeatIntervalMs: 5,
    histogramResolutionMs: 10,
    operatingSystemCachesNotCleared: true,
    rss: 'RSS is for the measuring process unless a row explicitly records worker/renderer/child observations',
    scope:
      'Generated fixtures and native primitives; not complete product UI, startup or power-loss evidence'
  },
  rows: []
}
const reportPath = join(outputDirectory, 'report.json')
const save = () => saveReport(reportPath, report)
await save()
const emit = async (row) => {
  assert.equal(row.suite, suite)
  report.rows.push(row)
  await save()
  console.log(
    JSON.stringify({
      suite,
      scenario: row.scenario,
      variant: row.variant,
      sample: row.sample,
      wallMs: row.metrics?.wallMs,
      heartbeatMs: row.metrics?.maxHeartbeatGapMs
    })
  )
}
try {
  const context = { base, quick, sampleCount, emit, outputDirectory }
  if (suite === 'ipc' || suite === 'network') {
    report.summary = await (
      await import('./native-wrapper.mjs')
    ).runNativeBench({ ...context, suite })
  } else {
    report.summary = await (await import(`./${suite}.mjs`)).runBench(context)
  }
  await rm(base, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  report.cleanedOwnedRoot = true
  validateReport(report, await profilesFor(suite), { requireComplete: false })
  report.completed = true
  await save()
  assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).completed, true)
} catch (error) {
  report.completed = false
  report.error = { name: error.name, message: error.message }
  await save()
  throw error
} finally {
  if (!report.cleanedOwnedRoot) {
    await rm(base, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    report.cleanedOwnedRoot = true
    await save()
  }
}
