import assert from 'node:assert/strict'
import { mkdir, readFile, statfs, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const option = (name, fallback) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ??
  fallback
const suite = option('suite')
const label = option('label', `${process.platform}-${process.arch}`)
const quick = args.includes('--quick')
const cachePolicy = option('cache', 'disabled')
const sampleCount = Number(option('samples', quick ? '1' : '3'))
const outputDirectory = resolve(
  option('output', `results/platform-${label}-${suite}-${cachePolicy}`)
)
const base = process.env.BENCH_BASE_ROOT || os.tmpdir()
assert(
  ['file-io', 'persistence', 'images', 'native-cache'].includes(suite),
  'Unknown suite'
)
assert(
  ['disabled', 'default', 'fileless'].includes(cachePolicy),
  'Unknown cache policy'
)
assert(/^[a-zA-Z0-9_-]+$/.test(label), 'Invalid label')
assert(Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 10)
await mkdir(outputDirectory, { recursive: true })
await mkdir(base, { recursive: true })
const sqlite = new DatabaseSync(':memory:')
const sqliteVersion = sqlite
  .prepare('SELECT sqlite_version() AS version')
  .get().version
sqlite.close()
const filesystem = await statfs(base)
const report = {
  schemaVersion: 1,
  completed: false,
  suite,
  label,
  cachePolicy,
  sampleCount,
  quick,
  measurement: {
    setupAndDigestChecksExcluded: true,
    operatingSystemCachesNotCleared: true,
    heartbeatIntervalMs: 5,
    histogramResolutionMs: 10,
    rss: 'Observed process RSS; lifetime high-water is cumulative, not per-operation peak',
    caveat:
      'Synthetic mechanisms; no product UI, real network latency or power-loss certification'
  },
  environment: {
    platform: process.platform,
    arch: process.arch,
    runtime: process.versions,
    kernel: os.release(),
    osVersion: os.version(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    sqlite: sqliteVersion,
    filesystem: { type: filesystem.type, blockSize: filesystem.bsize },
    sourceRevision: process.env.BENCH_SOURCE_REVISION ?? null
  },
  rows: []
}
const reportPath = join(outputDirectory, 'report.json')
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2))
await save()
const emit = async (row) => {
  assert.equal(row.suite, suite)
  assert.equal(typeof row.scenario, 'string')
  assert.equal(typeof row.variant, 'string')
  if (row.metrics !== null) {
    assert(Number.isFinite(row.metrics.wallMs) && row.metrics.wallMs >= 0)
    assert(Number.isFinite(row.metrics.maxHeartbeatGapMs))
  }
  report.rows.push(row)
  await save()
  console.log(
    JSON.stringify({
      suite,
      scenario: row.scenario,
      variant: row.variant,
      sample: row.sample,
      wallMs: row.metrics?.wallMs,
      maxHeartbeatGapMs: row.metrics?.maxHeartbeatGapMs
    })
  )
}
try {
  const context = {
    base,
    quick,
    sampleCount,
    cachePolicy,
    emit,
    outputDirectory
  }
  if (suite === 'file-io')
    report.suiteSummary = await (
      await import('./file-io.mjs')
    ).runFileIoBench(context)
  if (suite === 'persistence')
    await (await import('./persistence.mjs')).runPersistenceBench(context)
  if (suite === 'images')
    await (await import('./images.mjs')).runImageBench(context)
  if (suite === 'native-cache')
    await (await import('./native-wrapper.mjs')).runNativeCacheBench(context)
  assert(report.rows.length > 0, 'No measurements emitted')
  if (suite === 'file-io') {
    assert.equal(report.rows.length, 12 * sampleCount)
    assert.equal(report.suiteSummary.summary.rowCount, report.rows.length)
    assert.equal(report.suiteSummary.summary.scenarioCount, 4)
    assert(
      Object.values(report.suiteSummary.checks).every((value) => value === true)
    )
  }
  if (suite === 'persistence')
    assert.equal(
      report.rows.length,
      17 * sampleCount + (process.platform === 'win32' ? 8 : 7)
    )
  if (suite === 'images') assert.equal(report.rows.length, 9 * sampleCount)
  if (suite === 'native-cache') assert.equal(report.rows.length, 5)
  report.completed = true
  await save()
  assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).completed, true)
} catch (error) {
  report.error = error.stack
  await save()
  throw error
}
