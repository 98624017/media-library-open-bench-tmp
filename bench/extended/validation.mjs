import assert from 'node:assert/strict'

export const SUITES = ['video', 'image-chain', 'journal-growth', 'ipc', 'network', 'lifecycle']

export async function profilesFor(suite) {
  assert(SUITES.includes(suite), 'Unknown suite')
  return (await import(`./${suite}.mjs`)).PROFILES
}

export function validateReport(report, profiles, { revision, label, requireComplete = true } = {}) {
  assert.equal(report.schemaVersion, 1)
  assert(SUITES.includes(report.suite))
  assert(Number.isInteger(report.sampleCount) && report.sampleCount > 0)
  if (requireComplete) assert.equal(report.completed, true, 'Incomplete report')
  assert(!report.error, 'Report contains a terminal error')
  if (revision) assert.equal(report.environment.sourceRevision, revision, 'Source revision differs')
  if (label) assert.equal(report.label, label, 'Runner label differs')
  const expected = new Set()
  for (const profile of profiles) {
    const count = profile.samples ?? report.sampleCount
    for (let sample = 0; sample < count; sample++) {
      const key = `${profile.scenario}/${profile.variant}/${sample}`
      assert(!expected.has(key), `Duplicate profile definition: ${key}`)
      expected.add(key)
    }
  }
  const seen = new Set()
  const workloads = new Map()
  for (const row of report.rows) {
    assert.equal(row.suite, report.suite)
    const key = `${row.scenario}/${row.variant}/${row.sample}`
    assert(expected.has(key), `Unexpected row: ${key}`)
    assert(!seen.has(key), `Duplicate row: ${key}`)
    seen.add(key)
    assert(row.workload && typeof row.workload === 'object', `Missing workload: ${key}`)
    assert(row.checks && typeof row.checks === 'object', `Missing checks: ${key}`)
    const checkEntries = Object.entries(row.checks)
    assert(checkEntries.length > 0, `No control checks: ${key}`)
    if (row.status === 'unsupported') {
      assert.equal(report.suite, 'ipc', 'Unsupported status is only defined for native clipboard')
      assert(row.scenario.startsWith('clipboard-'), 'Decode controls cannot become unsupported')
      assert.equal(row.metrics, null)
      assert.deepEqual(
        row.checks,
        { available: false },
        'Unsupported clipboard still cannot hide a failed pixel control'
      )
    } else {
      for (const [name, passed] of checkEntries)
        assert.equal(passed, true, `Failed control ${name}: ${key}`)
    }
    const profileKey = `${row.scenario}/${row.variant}`
    const workload = JSON.stringify(row.workload)
    if (workloads.has(profileKey))
      assert.equal(
        workload,
        workloads.get(profileKey),
        `Workload changed between samples: ${profileKey}`
      )
    else workloads.set(profileKey, workload)
    if (row.metrics !== null) {
      for (const metric of [
        'wallMs',
        'cpuUserMs',
        'cpuSystemMs',
        'maxHeartbeatGapMs',
        'eventLoopDelayMaxMs',
        'rssStartBytes',
        'rssEndBytes',
        'rssObservedPeakBytes'
      ])
        assert(
          Number.isFinite(row.metrics[metric]) && row.metrics[metric] >= 0,
          `Invalid metric ${metric}: ${key}`
        )
      assert(row.metrics.rssObservedPeakBytes >= row.metrics.rssStartBytes)
      assert(row.metrics.rssObservedPeakBytes >= row.metrics.rssEndBytes)
    }
  }
  assert.equal(seen.size, expected.size, `Missing profiles (${seen.size}/${expected.size})`)
  assert.equal(report.cleanedOwnedRoot, true, 'Fixture cleanup was not confirmed')
  for (const [name, passed] of Object.entries(report.summary?.checks ?? {}))
    assert.equal(passed, true, `Failed suite control: ${name}`)
  if (report.suite === 'ipc' || report.suite === 'network') {
    assert.equal(report.summary.nativePlatform, report.environment.platform)
    assert.equal(report.summary.nativeArch, report.environment.arch)
    assert.equal(report.summary.runtime.electron, '39.8.3')
  }
  return { profiles: profiles.length, rows: seen.size }
}
