import assert from 'node:assert/strict'

export const SUITES = ['video', 'image-chain', 'journal-growth', 'ipc', 'network', 'lifecycle']

const OBSERVATION_PROFILES = new Set([
  ...[
    'compression-timeout',
    'parent-kill-counterexample',
    'download-tree-cancel',
    'download-tree-timeout'
  ].map((scenario) => `video/${scenario}/process-observation`),
  'journal-growth/directory-sync-policy/native-observation',
  'journal-growth/replay-correctness/checkpoint-old-log-delete',
  ...['body-stall-deadline', 'mid-body-interruption', 'caller-abort'].flatMap((scenario) =>
    ['electron-session', 'node-undici'].map((variant) => `network/${scenario}/${variant}`)
  )
])

export async function profilesFor(suite) {
  assert(SUITES.includes(suite), 'Unknown suite')
  return (await import(`./${suite}.mjs`)).PROFILES
}

export function validateReport(
  report,
  profiles,
  { revision, label, suite, requireComplete = true } = {}
) {
  assert.equal(report.schemaVersion, 1)
  assert(SUITES.includes(report.suite))
  if (suite) assert.equal(report.suite, suite, 'Report suite differs from expected directory')
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
      if (OBSERVATION_PROFILES.has(`${report.suite}/${row.scenario}/${row.variant}`))
        assert.equal(row.metrics, null, `Observation must not invent timing: ${key}`)
      else assert(row.metrics && typeof row.metrics === 'object', `Missing timing metrics: ${key}`)
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

export function validateSupervisor(supervisor, { suite, label, revision }) {
  assert.equal(supervisor.schemaVersion, 1)
  assert.equal(supervisor.suite, suite)
  assert.equal(supervisor.label, label)
  assert.equal(supervisor.sourceRevision, revision)
  assert.equal(supervisor.completed, true, 'Supervisor did not confirm success and cleanup')
  assert.equal(supervisor.reason, 'exit', 'Supervisor did not confirm natural exit')
  assert.equal(supervisor.exitCode, 0, 'Supervisor reported a failing exit code')
  assert(!supervisor.error, 'Supervisor reported a terminal error')
}
