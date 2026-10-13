import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { saveReport } from './report-file.mjs'
import { runWithDeadline } from './termination.mjs'
import { SUITES } from './validation.mjs'

export function supervisorReceipt(context, result, error) {
  const reason = error ? 'supervisor-error' : (result?.reason ?? 'starting')
  const completed = !error && reason === 'exit' && result.code === 0
  const failure =
    error ??
    (!completed && reason !== 'starting'
      ? {
          name: reason === 'deadline' ? 'DeadlineError' : 'ChildExitError',
          message:
            reason === 'spawn-error'
              ? `Suite could not start: ${result.errorCode}`
              : `Suite ${reason}: exit ${result?.code ?? 'none'}, signal ${result?.signal ?? 'none'}`
        }
      : null)
  return {
    schemaVersion: 1,
    suite: context.suite,
    label: context.label,
    sourceRevision: context.sourceRevision,
    completed,
    reason,
    exitCode: reason === 'starting' ? null : completed ? 0 : result?.code || 1,
    ...(result?.registered ? { registeredCleanupCount: result.registered.length } : {}),
    ...(failure ? { error: { name: failure.name, message: failure.message } } : {})
  }
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name, fallback) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
  const suite = option('suite')
  const label = option('label', `${process.platform}-${process.arch}`)
  assert(SUITES.includes(suite), 'Unknown suite')
  assert(/^[A-Za-z0-9_-]+$/.test(label), 'Invalid label')
  const outputDirectory = resolve(option('output', `results/extended-${label}-${suite}`))
  const context = { suite, label, sourceRevision: process.env.BENCH_SOURCE_REVISION ?? null }
  await mkdir(outputDirectory, { recursive: true })
  const receiptPath = join(outputDirectory, 'supervisor.json')
  await saveReport(receiptPath, supervisorReceipt(context))
  let result
  let error
  try {
    result = await runWithDeadline(process.execPath, [
      fileURLToPath(new URL('./run.mjs', import.meta.url)),
      ...args
    ])
  } catch (failure) {
    error = failure
  }
  const receipt = supervisorReceipt(context, result, error)
  await saveReport(receiptPath, receipt)
  if (receipt.reason === 'deadline') {
    process.stderr.write(
      'Suite deadline reached; owned process groups stopped; saved rows remain partial evidence\n'
    )
  } else if (receipt.reason === 'spawn-error') {
    process.stderr.write(`Suite could not start: ${result.errorCode}\n`)
  } else if (error) {
    process.stderr.write(`Suite supervisor failed: ${error.message}\n`)
  }
  return receipt.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main()
  } catch (error) {
    process.stderr.write(`Suite supervisor could not save evidence: ${error.message}\n`)
    process.exitCode = 1
  }
}
