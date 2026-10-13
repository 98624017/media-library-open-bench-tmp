import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { median } from '../platform/metrics.mjs'
import { SUITES, profilesFor, validateReport, validateSupervisor } from './validation.mjs'

export async function summarize(directory, { label, revision }) {
  const reports = []
  const failures = []
  for (const suite of SUITES) {
    const path = join(directory, `extended-${label}-${suite}`, 'report.json')
    try {
      const report = JSON.parse(await readFile(path, 'utf8'))
      validateReport(report, await profilesFor(suite), { label, revision, suite })
      const supervisor = JSON.parse(
        await readFile(join(directory, `extended-${label}-${suite}`, 'supervisor.json'), 'utf8')
      )
      validateSupervisor(supervisor, { suite, label, revision })
      assert.equal(report.quick, false, 'Quick workload is not full runner evidence')
      assert.equal(report.sampleCount, 3, 'Three runner samples are required')
      const expectedPlatform = label.startsWith('windows-')
        ? 'win32'
        : label.startsWith('macos-')
          ? 'darwin'
          : 'linux'
      assert.equal(report.environment.platform, expectedPlatform, 'Wrong native platform')
      assert.equal(
        report.environment.arch,
        label.includes('arm64') ? 'arm64' : 'x64',
        'Wrong native architecture'
      )
      reports.push(report)
    } catch (error) {
      failures.push({ suite, reason: error.code ?? error.message })
    }
  }
  const groups = []
  const observations = []
  for (const report of reports) {
    const grouped = new Map()
    for (const row of report.rows) {
      if (row.metrics === null || row.status === 'unsupported') {
        observations.push({ suite: report.suite, ...row })
        continue
      }
      const key = `${row.scenario}/${row.variant}`
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key).push(row)
    }
    for (const rows of grouped.values()) {
      groups.push({
        suite: report.suite,
        scenario: rows[0].scenario,
        variant: rows[0].variant,
        samples: rows.length,
        workload: rows[0].workload,
        medianWallMs: median(rows.map((row) => row.metrics.wallMs)),
        maxHeartbeatGapMs: Math.max(...rows.map((row) => row.metrics.maxHeartbeatGapMs)),
        maxObservedRssBytes: Math.max(...rows.map((row) => row.metrics.rssObservedPeakBytes))
      })
    }
  }
  return {
    schemaVersion: 1,
    complete: failures.length === 0 && reports.length === SUITES.length,
    label,
    sourceRevision: revision,
    expectedReports: SUITES.length,
    reportCount: reports.length,
    rowCount: reports.reduce((sum, report) => sum + report.rows.length, 0),
    failures,
    groups,
    observations,
    environments: reports.map((report) => ({ suite: report.suite, ...report.environment })),
    summaries: reports.map((report) => ({ suite: report.suite, summary: report.summary }))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const directory = resolve(args.find((arg) => !arg.startsWith('--')) ?? 'results')
  const label = option('label')
  const revision = option('revision')
  if (!label || !/^[a-zA-Z0-9_-]+$/.test(label) || !revision || !/^[0-9a-f]{40}$/.test(revision))
    throw new Error('Explicit runner label and candidate SHA are required')
  const result = await summarize(directory, { label, revision })
  await writeFile(join(directory, 'extended-summary.json'), JSON.stringify(result, null, 2))
  const lines = [
    `# One-shot batches 2 and 3: ${label}`,
    '',
    `Status: ${result.complete ? 'COMPLETE' : 'PARTIAL'}`,
    `Reports: ${result.reportCount}/${result.expectedReports}; rows: ${result.rowCount}`,
    '',
    '| Suite | Scenario | Variant | Samples | Median ms | Largest heartbeat ms |',
    '| --- | --- | --- | ---: | ---: | ---: |',
    ...result.groups.map(
      (group) =>
        `| ${group.suite} | ${group.scenario} | ${group.variant} | ${group.samples} | ${group.medianWallMs.toFixed(2)} | ${group.maxHeartbeatGapMs.toFixed(2)} |`
    ),
    '',
    ...result.failures.map((failure) => `- ${failure.suite}: ${failure.reason}`),
    '',
    `Unsupported observations: ${result.observations.filter((row) => row.status === 'unsupported').length}`,
    'These are synthetic mechanisms; complete product startup, UI, hardware, sleep and power-loss behavior are outside this evidence.'
  ]
  await writeFile(join(directory, 'extended-summary.md'), `${lines.join('\n')}\n`)
  console.log(
    JSON.stringify({
      complete: result.complete,
      reports: result.reportCount,
      rows: result.rowCount,
      failures: result.failures
    })
  )
  if (!result.complete) process.exitCode = 1
}
import assert from 'node:assert/strict'
