import assert from 'node:assert/strict'
import test from 'node:test'
import { validateReport, validateSupervisor } from './validation.mjs'
import { parseDiscovery } from './lifecycle.mjs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveReport } from './report-file.mjs'

const profiles = [{ scenario: 'fixture', variant: 'control' }]
const row = {
  suite: 'ipc',
  scenario: 'fixture',
  variant: 'control',
  sample: 0,
  workload: { bytes: 20 },
  metrics: {
    wallMs: 1,
    cpuUserMs: 0,
    cpuSystemMs: 0,
    maxHeartbeatGapMs: 1,
    eventLoopDelayMaxMs: 1,
    rssStartBytes: 1,
    rssEndBytes: 1,
    rssObservedPeakBytes: 1
  },
  checks: { bytesMatch: true }
}
const report = () => ({
  schemaVersion: 1,
  completed: true,
  cleanedOwnedRoot: true,
  suite: 'ipc',
  label: 'test',
  sampleCount: 1,
  environment: { sourceRevision: 'same', platform: 'linux', arch: 'x64' },
  summary: { nativePlatform: 'linux', nativeArch: 'x64', runtime: { electron: '39.8.3' } },
  rows: [structuredClone(row)]
})

test('coverage rejects missing, duplicate and incomplete evidence', () => {
  assert.deepEqual(validateReport(report(), profiles), { profiles: 1, rows: 1 })
  const missing = report()
  missing.rows = []
  assert.throws(() => validateReport(missing, profiles), /Missing/)
  const duplicate = report()
  duplicate.rows.push(structuredClone(row))
  assert.throws(() => validateReport(duplicate, profiles), /Duplicate/)
  const partial = report()
  partial.completed = false
  assert.throws(() => validateReport(partial, profiles), /Incomplete/)
})
test('source, label and cleanup have independent gates', () => {
  assert.throws(() => validateReport(report(), profiles, { revision: 'other' }), /revision/)
  assert.throws(() => validateReport(report(), profiles, { label: 'other' }), /label/)
  const dirty = report()
  dirty.cleanedOwnedRoot = false
  assert.throws(() => validateReport(dirty, profiles), /cleanup/)
  const failed = report()
  failed.error = { message: 'Final save failed' }
  assert.throws(() => validateReport(failed, profiles), /terminal error/)
})
test('failed controls are rejected while an explicit unsupported clipboard remains an observation', () => {
  const failed = report()
  failed.rows[0].checks.bytesMatch = false
  assert.throws(() => validateReport(failed, profiles), /Failed control/)
  const unsupported = report()
  unsupported.rows[0] = {
    ...row,
    scenario: 'clipboard-medium',
    status: 'unsupported',
    metrics: null,
    checks: { available: false }
  }
  const clipboard = [{ scenario: 'clipboard-medium', variant: 'control' }]
  assert.equal(validateReport(unsupported, clipboard).rows, 1)
  unsupported.rows[0].checks.allPixelsMatch = false
  assert.throws(() => validateReport(unsupported, clipboard), /hide a failed pixel control/)
})
test('directory suite cannot be relabelled and timed samples cannot become observations', () => {
  assert.throws(() => validateReport(report(), profiles, { suite: 'video' }), /suite differs/)
  const missing = report()
  missing.rows[0].metrics = null
  assert.throws(() => validateReport(missing, profiles), /Missing timing metrics/)
})
test('a success flag cannot hide a supervisor deadline or nonzero exit', () => {
  const identity = { suite: 'ipc', label: 'test', revision: 'same' }
  const receipt = {
    schemaVersion: 1,
    suite: 'ipc',
    label: 'test',
    sourceRevision: 'same',
    completed: true,
    reason: 'exit',
    exitCode: 0
  }
  assert.doesNotThrow(() => validateSupervisor(receipt, identity))
  assert.throws(
    () => validateSupervisor({ ...receipt, reason: 'deadline' }, identity),
    /natural exit/
  )
  assert.throws(() => validateSupervisor({ ...receipt, exitCode: 1 }, identity), /failing exit/)
})
test('discovery only accepts a valid loopback fixture port and process identity', () => {
  assert.deepEqual(parseDiscovery('{"port":45300,"pid":22}'), { port: 45300, pid: 22 })
  for (const value of [
    { port: 0, pid: 22 },
    { port: 65536, pid: 22 },
    { port: 45000, pid: -1 },
    { port: '45000', pid: 22 }
  ])
    assert.throws(() => parseDiscovery(JSON.stringify(value)))
})
test('an interrupted temporary write leaves the previous checkpoint readable', async () => {
  const base = await mkdtemp(join(tmpdir(), 'synthetic-report-checkpoint-'))
  try {
    const path = join(base, 'report.json')
    await saveReport(path, { rows: [1], completed: false })
    await writeFile(`${path}.tmp`, '{"rows": [1, 2')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).rows, [1])
    await saveReport(path, { rows: [1, 2], completed: true })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).rows, [1, 2])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
