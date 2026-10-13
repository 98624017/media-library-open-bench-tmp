import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { median, round } from './metrics.mjs'

const nativePlatform = (value) =>
  ({ Windows: 'win32', macOS: 'darwin', Linux: 'linux' })[value] ?? value
const reportKey = ({ label, suite, cachePolicy }) =>
  JSON.stringify([label, suite, cachePolicy])

export function expectedReports(label, platform) {
  platform = nativePlatform(platform)
  assert(
    ['linux', 'win32', 'darwin'].includes(platform),
    'Unknown expected platform'
  )
  const expected = ['file-io', 'persistence'].map((suite) => ({
    label,
    suite,
    cachePolicy: 'disabled',
    quick: false
  }))
  for (const cachePolicy of ['disabled', 'default', 'fileless'])
    expected.push({ label, suite: 'images', cachePolicy, quick: false })
  if (platform !== 'linux') {
    for (const cachePolicy of ['disabled', 'default', 'fileless'])
      expected.push({ label, suite: 'native-cache', cachePolicy, quick: false })
    const volumeLabel = `${label}-${platform === 'win32' ? 'unc' : 'hfs'}`
    expected.push({
      label: volumeLabel,
      suite: 'file-io',
      cachePolicy: 'disabled',
      quick: true
    })
    if (platform === 'darwin')
      expected.push({
        label: volumeLabel,
        suite: 'persistence',
        cachePolicy: 'disabled',
        quick: true
      })
  }
  return expected
}

export function validateEvidence(
  reports,
  { label, platform, sourceRevision } = {}
) {
  const errors = []
  const expected = label ? expectedReports(label, platform) : []
  const found = new Map()
  const imageHashes = new Map()
  if (!label)
    errors.push(
      'Expected workflow coverage was not specified; provide --label and --platform'
    )
  for (const report of reports) {
    const key = reportKey(report)
    if (found.has(key)) errors.push(`Duplicate report: ${key}`)
    found.set(key, report)
    try {
      assert.equal(report.schemaVersion, 1)
      assert.equal(report.completed, true, 'Report is incomplete')
      if (sourceRevision)
        assert.equal(
          report.environment.sourceRevision,
          sourceRevision,
          'Source differs from candidate'
        )
      assert(Number.isInteger(report.sampleCount) && report.sampleCount > 0)
      const expectedRows = {
        'file-io': 12 * report.sampleCount,
        persistence:
          17 * report.sampleCount +
          (report.environment.platform === 'win32' ? 8 : 7),
        images: 9 * report.sampleCount,
        'native-cache': 5
      }[report.suite]
      assert.equal(
        report.rows.length,
        expectedRows,
        'Missing or unexpected rows'
      )
      const profiles = new Map()
      for (const row of report.rows) {
        assert.equal(row.suite, report.suite)
        assert(Number.isInteger(row.sample))
        const profileKey = JSON.stringify([row.scenario, row.variant])
        const profile = profiles.get(profileKey) ?? {
          samples: new Set(),
          metrics: row.metrics
        }
        assert(
          !profile.samples.has(row.sample),
          `Duplicate sample: ${profileKey}/${row.sample}`
        )
        profile.samples.add(row.sample)
        profiles.set(profileKey, profile)
        if (row.metrics !== null) {
          for (const field of [
            'wallMs',
            'maxHeartbeatGapMs',
            'rssObservedPeakBytes'
          ])
            assert(
              Number.isFinite(row.metrics[field]) && row.metrics[field] >= 0,
              `Invalid metric: ${field}`
            )
        }
        if (report.suite === 'images') {
          assert.match(row.checks.outputDigest, /^[a-f0-9]{64}$/)
          assert.equal(row.checks.outputCount, row.count)
          assert.equal(row.checks.dimensionsValid, true)
          const imageKey = JSON.stringify([report.label, row.scenario])
          if (imageHashes.has(imageKey))
            assert.equal(
              row.checks.outputDigest,
              imageHashes.get(imageKey),
              'Cache policies changed image bytes'
            )
          imageHashes.set(imageKey, row.checks.outputDigest)
        }
        if (report.suite === 'native-cache') {
          assert.equal(row.runtime.electron, '39.8.3')
          assert.equal(row.sharpVersions.sharp, '0.34.5')
          assert.equal(row.nativePlatform, report.environment.platform)
          assert.equal(row.nativeArch, report.environment.arch)
          assert.equal(row.isolatedUserData, true)
          if (report.cachePolicy === 'disabled')
            assert.equal(
              row.checks.safetyPassed,
              true,
              'Cache-disabled control failed'
            )
        }
      }
      for (const [profileKey, profile] of profiles)
        assert.equal(
          profile.samples.size,
          profile.metrics === null || report.suite === 'native-cache'
            ? 1
            : report.sampleCount,
          `Incomplete profile: ${profileKey}`
        )
      if (report.suite === 'file-io') {
        assert.equal(report.suiteSummary.summary.rowCount, report.rows.length)
        assert.equal(report.suiteSummary.summary.scenarioCount, 4)
        assert.equal(report.suiteSummary.checks.ownedTemporaryRootCleaned, true)
        assert(
          Object.values(report.suiteSummary.checks).every(
            (value) => value === true
          ),
          'File I/O contract failed'
        )
      }
    } catch (error) {
      errors.push(`${key}: ${error.message}`)
    }
  }
  for (const descriptor of expected) {
    const report = found.get(reportKey(descriptor))
    if (!report) {
      errors.push(`Missing expected report: ${reportKey(descriptor)}`)
      continue
    }
    if (report.quick !== descriptor.quick || report.sampleCount !== 3)
      errors.push(`Unexpected workload/sample count: ${reportKey(descriptor)}`)
    if (report.environment.platform !== nativePlatform(platform))
      errors.push(`Unexpected platform: ${reportKey(descriptor)}`)
  }
  for (const key of found.keys())
    if (label && !expected.some((descriptor) => reportKey(descriptor) === key))
      errors.push(`Unexpected report: ${key}`)
  return { expectedReportCount: expected.length, errors }
}

async function main() {
  const directory = resolve(process.argv[2] ?? 'results')
  const option = (name, fallback) =>
    process.argv
      .slice(3)
      .find((arg) => arg.startsWith(`--${name}=`))
      ?.slice(name.length + 3) ?? fallback
  await mkdir(directory, { recursive: true })
  const files = []
  async function discover(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) await discover(join(root, entry.name))
      else if (entry.name === 'report.json') files.push(join(root, entry.name))
    }
  }
  await discover(directory)
  const reports = await Promise.all(
    files.sort().map(async (file) => JSON.parse(await readFile(file, 'utf8')))
  )
  const coverage = validateEvidence(reports, {
    label: option('label', process.env.BENCH_LABEL),
    platform: option('platform', process.platform),
    sourceRevision: process.env.BENCH_SOURCE_REVISION
  })
  const groups = new Map()
  const observations = []
  for (const report of reports) {
    for (const row of report.rows) {
      if (row.metrics === null) {
        observations.push({
          label: report.label,
          completed: report.completed,
          ...row
        })
        continue
      }
      const key = JSON.stringify([
        report.label,
        row.suite,
        row.scenario,
        row.variant
      ])
      const current = groups.get(key) ?? {
        label: report.label,
        suite: row.suite,
        scenario: row.scenario,
        variant: row.variant,
        completeReports: true,
        wallMs: [],
        maxHeartbeatGapMs: [],
        rows: []
      }
      current.completeReports &&= report.completed
      current.wallMs.push(row.metrics.wallMs)
      current.maxHeartbeatGapMs.push(row.metrics.maxHeartbeatGapMs)
      current.rows.push(row)
      groups.set(key, current)
    }
  }
  const summary = {
    completed: reports.length > 0 && coverage.errors.length === 0,
    coverage,
    reportCount: reports.length,
    environments: reports.map(
      ({ label, suite, cachePolicy, environment, completed }) => ({
        label,
        suite,
        cachePolicy,
        environment,
        completed
      })
    ),
    measurements: [...groups.values()].map(
      ({ rows, wallMs, maxHeartbeatGapMs, ...group }) => ({
        ...group,
        sampleCount: wallMs.length,
        firstMs: wallMs[0],
        medianMs: round(median(wallMs)),
        maxMs: Math.max(...wallMs),
        heartbeatMedianMs: round(median(maxHeartbeatGapMs)),
        heartbeatMaxMs: Math.max(...maxHeartbeatGapMs),
        rssObservedPeakBytes: Math.max(
          ...rows.map((row) => row.metrics.rssObservedPeakBytes)
        ),
        checks: rows.map((row) => row.checks)
      })
    ),
    observations
  }
  await writeFile(
    join(directory, 'platform-summary.json'),
    JSON.stringify(summary, null, 2)
  )
  const markdown = [
    `Synthetic platform evidence: ${summary.completed ? 'complete' : 'PARTIAL'}`,
    `Reports: ${summary.reportCount}/${coverage.expectedReportCount}`,
    ...coverage.errors.map((error) => `- ${error}`),
    '',
    '| Platform | Suite / scenario | Variant | n | Median ms | Max heartbeat gap ms |',
    '| --- | --- | --- | ---: | ---: | ---: |',
    ...summary.measurements.map(
      (row) =>
        `| ${row.label} | ${row.suite} / ${row.scenario} | ${row.variant} | ${row.sampleCount} | ${row.medianMs} | ${row.heartbeatMaxMs} |`
    ),
    '',
    'Native file/cache observations:',
    ...summary.measurements
      .filter((row) => row.suite === 'native-cache')
      .map(
        (row) =>
          `- ${row.label} ${row.variant} ${row.scenario}: ${JSON.stringify(row.checks[0])}`
      ),
    ...observations.map(
      (row) =>
        `- ${row.label} ${row.scenario} ${row.variant}: ${JSON.stringify(row.checks)}`
    ),
    '',
    'Fresh processes and fixture setup warm the filesystem; these are not reboot-cold measurements. RSS observations can miss short peaks. Process kill is not a power-loss test.'
  ].join('\n')
  await writeFile(join(directory, 'platform-summary.md'), `${markdown}\n`)
  console.log(markdown)
  if (!summary.completed) process.exitCode = 1
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main()
