import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expectedReports, validateEvidence } from './summarize.mjs'

function completedReports(label, platform) {
  return expectedReports(label, platform).map((descriptor) => {
    const report = {
      ...descriptor,
      schemaVersion: 1,
      completed: true,
      sampleCount: 3,
      environment: { platform, arch: 'x64', sourceRevision: 'candidate' },
      rows: []
    }
    const timedProfiles = {
      'file-io': 12,
      persistence: 17,
      images: 9,
      'native-cache': 5
    }[report.suite]
    const samples = report.suite === 'native-cache' ? 1 : report.sampleCount
    for (let profile = 0; profile < timedProfiles; profile++) {
      for (let sample = 0; sample < samples; sample++)
        report.rows.push({
          suite: report.suite,
          scenario: `profile-${profile}`,
          variant: report.cachePolicy,
          sample,
          count: 2,
          metrics: {
            wallMs: 1,
            maxHeartbeatGapMs: 5,
            rssObservedPeakBytes: 1024
          },
          checks: {
            outputDigest: 'a'.repeat(64),
            outputCount: 2,
            dimensionsValid: true,
            safetyPassed: true
          },
          runtime: { electron: '39.8.3' },
          sharpVersions: { sharp: '0.34.5' },
          nativePlatform: platform,
          nativeArch: 'x64',
          isolatedUserData: true
        })
    }
    if (report.suite === 'persistence') {
      for (
        let observation = 0;
        observation < (platform === 'win32' ? 8 : 7);
        observation++
      )
        report.rows.push({
          suite: report.suite,
          scenario: `observation-${observation}`,
          variant: 'observation',
          sample: 0,
          metrics: null,
          checks: { recovered: true }
        })
    }
    if (report.suite === 'file-io')
      report.suiteSummary = {
        summary: { rowCount: report.rows.length, scenarioCount: 4 },
        checks: { sourcePreserved: true, ownedTemporaryRootCleaned: true }
      }
    return report
  })
}

test('requires the complete per-platform workflow matrix, including extra volumes', () => {
  for (const [platform, expectedCount] of [
    ['linux', 5],
    ['win32', 9],
    ['darwin', 10]
  ]) {
    const reports = completedReports('runner', platform)
    const coverage = validateEvidence(reports, {
      label: 'runner',
      platform,
      sourceRevision: 'candidate'
    })
    assert.equal(coverage.expectedReportCount, expectedCount)
    assert.deepEqual(coverage.errors, [])
    assert(
      validateEvidence(reports.slice(0, -1), {
        label: 'runner',
        platform
      }).errors.some((error) => error.includes('Missing expected report'))
    )
  }
})

test('an entirely missing cache step cannot be called complete', () => {
  const reports = completedReports('runner', 'linux').filter(
    (report) => report.cachePolicy !== 'fileless'
  )
  const result = validateEvidence(reports, {
    label: 'runner',
    platform: 'Linux'
  })
  assert(
    result.errors.some(
      (error) =>
        error.includes('Missing expected report') && error.includes('fileless')
    )
  )
})

test('a candidate safety failure is evidence, while a disabled-cache control failure invalidates evidence', () => {
  const reports = completedReports('runner', 'win32')
  reports.find(
    (report) =>
      report.suite === 'native-cache' && report.cachePolicy === 'default'
  ).rows[0].checks.safetyPassed = false
  assert.deepEqual(
    validateEvidence(reports, { label: 'runner', platform: 'Windows' }).errors,
    []
  )
  reports.find(
    (report) =>
      report.suite === 'native-cache' && report.cachePolicy === 'disabled'
  ).rows[0].checks.safetyPassed = false
  assert(
    validateEvidence(reports, {
      label: 'runner',
      platform: 'Windows'
    }).errors.some((error) => error.includes('Cache-disabled control failed'))
  )
})

test('all image samples must agree across policies', () => {
  const reports = completedReports('runner', 'linux')
  reports.find(
    (report) => report.suite === 'images' && report.cachePolicy === 'default'
  ).rows[1].checks.outputDigest = 'b'.repeat(64)
  assert(
    validateEvidence(reports, {
      label: 'runner',
      platform: 'linux'
    }).errors.some((error) =>
      error.includes('Cache policies changed image bytes')
    )
  )
})

test('duplicate samples and reports cannot replace missing evidence', () => {
  const reports = completedReports('runner', 'linux')
  reports[0].rows[1].sample = reports[0].rows[0].sample
  reports.push(reports[1])
  const { errors } = validateEvidence(reports, {
    label: 'runner',
    platform: 'linux'
  })
  assert(errors.some((error) => error.includes('Duplicate sample')))
  assert(errors.some((error) => error.includes('Duplicate report')))
})

test('source and workload mismatches stay partial', () => {
  const reports = completedReports('runner', 'darwin')
  reports[0].quick = true
  reports[1].environment.sourceRevision = 'other-candidate'
  const { errors } = validateEvidence(reports, {
    label: 'runner',
    platform: 'darwin',
    sourceRevision: 'candidate'
  })
  assert(
    errors.some((error) => error.includes('Unexpected workload/sample count'))
  )
  assert(
    errors.some((error) => error.includes('Source differs from candidate'))
  )
})

test('no report and unspecified coverage both stay partial', () => {
  assert.equal(
    validateEvidence([], { label: 'runner', platform: 'linux' }).errors.length,
    5
  )
  assert(
    validateEvidence(completedReports('runner', 'linux')).errors.some((error) =>
      error.includes('coverage was not specified')
    )
  )
})
