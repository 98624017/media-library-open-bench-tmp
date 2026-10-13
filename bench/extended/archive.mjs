import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarize } from './summarize.mjs'
import { SUITES } from './validation.mjs'

const REPOSITORY = '98624017/media-library-open-bench-tmp'

export const TARGETS = [
  'windows-2022-x64',
  'windows-2025-x64',
  'macos-15-arm64',
  'macos-15-intel-x64',
  'ubuntu-24-control'
]

export async function archive(input, revision, runId) {
  assert(/^[0-9a-f]{40}$/.test(revision), 'A complete candidate SHA is required')
  assert(/^[0-9]+$/.test(String(runId)), 'A numeric Actions run ID is required')
  const machines = []
  for (const label of TARGETS) {
    const directory = join(input, label)
    const summary = await summarize(directory, { label, revision })
    assert(summary.complete, `${label} is partial: ${JSON.stringify(summary.failures)}`)
    const reports = []
    for (const suite of SUITES) {
      const location = join(directory, `extended-${label}-${suite}`)
      const report = JSON.parse(await readFile(join(location, 'report.json'), 'utf8'))
      const supervisor = JSON.parse(await readFile(join(location, 'supervisor.json'), 'utf8'))
      reports.push({ report, supervisor })
    }
    machines.push({ label, summary, reports })
  }
  const rows = machines.flatMap((machine) => machine.reports.flatMap(({ report }) => report.rows))
  const workflowReceipt = JSON.parse(
    execFileSync(
      'gh',
      [
        'run',
        'view',
        String(runId),
        '--repo',
        REPOSITORY,
        '--json',
        'databaseId,status,conclusion,headSha,url,jobs'
      ],
      { encoding: 'utf8', timeout: 30000 }
    )
  )
  assert.equal(String(workflowReceipt.databaseId), String(runId))
  assert.equal(workflowReceipt.headSha, revision, 'Actions candidate differs')
  assert.equal(workflowReceipt.status, 'completed')
  assert.equal(workflowReceipt.conclusion, 'success')
  assert.deepEqual(workflowReceipt.jobs.map((job) => job.name).sort(), [...TARGETS].sort())
  for (const job of workflowReceipt.jobs) {
    assert.equal(job.status, 'completed')
    assert.equal(job.conclusion, 'success')
    assert.equal(
      job.steps.find((step) => step.name === 'Runtime and bounded self-checks')?.conclusion,
      'success',
      `${job.name} did not pass remote self-checks`
    )
  }
  return {
    schemaVersion: 1,
    sourceRevision: revision,
    runId: String(runId),
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    workflowReceipt,
    complete: true,
    coverage: {
      targets: machines.length,
      reports: machines.reduce((sum, machine) => sum + machine.reports.length, 0),
      rows: rows.length,
      timingSamples: rows.filter((row) => row.metrics !== null).length,
      observations: rows.filter((row) => row.metrics === null).length
    },
    measurement: {
      samplesPerRepeatedTimingProfile: 3,
      oneTimeTimingProfile: 'journal-growth/real-synced-appends',
      osCachesNotCleared: true,
      scope:
        'Generated fixtures, native libraries and standalone Electron; not the full product UI or physical-device certification'
    },
    machines
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output, revision, runId] = process.argv.slice(2)
  assert(input && output && revision && runId, 'Use archive.mjs INPUT OUTPUT CANDIDATE_SHA RUN_ID')
  const result = await archive(resolve(input), revision, runId)
  await mkdir(dirname(resolve(output)), { recursive: true })
  await writeFile(resolve(output), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result.coverage))
}
