import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { validateEvidence } from './summarize.mjs'

const [input, output, sourceRevision, runId] = process.argv.slice(2)
assert(
  input &&
    output &&
    /^[a-f0-9]{40}$/.test(sourceRevision) &&
    /^\d+$/.test(runId),
  'Usage: archive INPUT OUTPUT SOURCE_SHA RUN_ID'
)
const labels = [
  'windows-2022-x64',
  'windows-2025-x64',
  'macos-15-arm64',
  'macos-15-intel-x64',
  'ubuntu-24-control'
]
const platforms = []
for (const label of labels) {
  const root = resolve(input, label)
  const reports = []
  const collect = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await collect(join(directory, entry.name))
      else if (entry.name === 'report.json')
        reports.push(
          JSON.parse(await readFile(join(directory, entry.name), 'utf8'))
        )
    }
  }
  await collect(root)
  const summary = JSON.parse(
    await readFile(join(root, 'platform-summary.json'), 'utf8')
  )
  const validation = validateEvidence(reports, {
    label,
    platform: reports[0].environment.platform,
    sourceRevision
  })
  assert.equal(summary.completed, true, `${label}: original summary incomplete`)
  assert.deepEqual(
    validation.errors,
    [],
    `${label}: downloaded evidence invalid`
  )
  const protection = label.startsWith('windows-')
    ? JSON.parse(await readFile(join(root, 'windows-protection.json'), 'utf8'))
    : null
  platforms.push({ label, protection, summary, reports })
}
const evidence = {
  schemaVersion: 1,
  completed: true,
  sourceRevision,
  runId,
  runUrl: `https://github.com/98624017/media-library-open-bench-tmp/actions/runs/${runId}`,
  counts: {
    platforms: platforms.length,
    reports: platforms.reduce((sum, item) => sum + item.reports.length, 0),
    timingSamples: platforms.reduce(
      (sum, item) =>
        sum +
        item.summary.measurements.reduce(
          (count, row) => count + row.sampleCount,
          0
        ),
      0
    ),
    correctnessObservations: platforms.reduce(
      (sum, item) => sum + item.summary.observations.length,
      0
    )
  },
  platforms
}
assert.deepEqual(evidence.counts, {
  platforms: 5,
  reports: 43,
  timingSamples: 1146,
  correctnessObservations: 51
})
await mkdir(dirname(resolve(output)), { recursive: true })
await writeFile(output, JSON.stringify(evidence, null, 2))
console.log(
  JSON.stringify({ output, ...evidence.counts, completed: evidence.completed })
)
