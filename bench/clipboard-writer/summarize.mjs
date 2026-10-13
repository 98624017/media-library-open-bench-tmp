import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { saveReport } from '../extended/report-file.mjs'
import { FIXTURES } from './fixtures.mjs'
import { validateReport } from './validation.mjs'

export async function summarizeEvidence(root, label, revision) {
  assert(/^[A-Za-z0-9_-]+$/.test(label) && /^[0-9a-f]{40}$/.test(revision))
  const summary = {
    completed: false,
    label,
    sourceRevision: revision,
    errors: [],
    fixtures: {},
    adoption: 'manual-review-required'
  }
  let sourceDigests
  let runtime
  let dependencies
  let sharpVersions
  let nativeReaderDigest
  for (const fixture of FIXTURES) {
    try {
      const directory = join(root, `clipboard-${label}-${fixture}`)
      const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))
      const supervisor = JSON.parse(await readFile(join(directory, 'supervisor.json'), 'utf8'))
      assert.equal(supervisor.completed, true, 'Supervisor did not confirm natural successful exit')
      assert.equal(supervisor.reason, 'exit')
      assert.equal(supervisor.suite, 'clipboard-writer')
      assert.equal(supervisor.exitCode, 0)
      assert.equal(supervisor.sourceRevision, revision)
      assert.equal(supervisor.label, label)
      assert.equal(report.sourceRevision, revision)
      assert.equal(report.label, label)
      assert.equal(report.fixture.name, fixture)
      assert.equal(report.fixture.quick, false, 'Quick data cannot satisfy the full native gate')
      const validated = validateReport(report)
      if (sourceDigests)
        assert.deepEqual(
          report.probeSourceSha256,
          sourceDigests,
          'Probe source differs across stages'
        )
      else sourceDigests = report.probeSourceSha256
      const currentRuntime = {
        platform: report.platform,
        arch: report.arch,
        versions: report.rows[0].runtime
      }
      if (runtime) assert.deepEqual(currentRuntime, runtime, 'Native runtime differs across stages')
      else runtime = currentRuntime
      if (dependencies) {
        assert.deepEqual(report.dependencies, dependencies, 'Dependencies differ across stages')
        assert.deepEqual(report.sharpVersions, sharpVersions, 'Sharp runtime differs across stages')
        assert.equal(
          report.nativeReaderSha256,
          nativeReaderDigest,
          'Mac reader differs across stages'
        )
      } else {
        dependencies = report.dependencies
        sharpVersions = report.sharpVersions
        nativeReaderDigest = report.nativeReaderSha256
      }
      summary.fixtures[fixture] = {
        samples: report.samples,
        distributions: validated,
        formatControls: report.rows[0].native ?? {
          formats: report.rows[0].formats,
          reader: 'Electron clipboard.availableFormats/readImage'
        }
      }
    } catch (error) {
      summary.errors.push({ fixture, name: error.name, message: error.message })
    }
  }
  summary.completed =
    summary.errors.length === 0 && Object.keys(summary.fixtures).length === FIXTURES.length
  summary.runtime = runtime ?? null
  summary.dependencies = dependencies ?? null
  summary.sharpVersions = sharpVersions ?? null
  summary.nativeReaderSha256 = nativeReaderDigest ?? null
  summary.probeSourceSha256 = sourceDigests ?? null
  return summary
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const root = resolve('results')
  const label = option('label')
  const summary = await summarizeEvidence(root, label, option('revision'))
  await saveReport(join(root, 'clipboard-writer-summary.json'), summary)
  process.stdout.write(
    `${label}: ${summary.completed ? 'complete' : 'PARTIAL'} native writer evidence (${Object.keys(summary.fixtures).length}/${FIXTURES.length} fixtures)\n`
  )
  for (const error of summary.errors) process.stderr.write(`${error.fixture}: ${error.message}\n`)
  process.exitCode = summary.completed ? 0 : 1
}
