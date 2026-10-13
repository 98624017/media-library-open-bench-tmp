import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { measure } from '../platform/metrics.mjs'
import { appendJournal } from '../platform/persistence-store.mjs'
import { recoverFixture, stateDigest } from './journal-growth.mjs'

const [mode, directory, variant] = process.argv.slice(2)
assert(typeof directory === 'string')
if (mode === 'recover') {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const measured = await measure(() => recoverFixture(directory, variant))
  const result = measured.value
  const expectedState =
    stateDigest(result.state) === manifest.expectedDigest &&
    result.state.records.size === manifest.expectedActive &&
    result.state.deleted.size === manifest.expectedDeletedBindings
  assert(result.complete)
  assert(expectedState)
  process.stdout.write(
    JSON.stringify({
      metrics: measured.metrics,
      checks: {
        complete: result.complete,
        expectedState,
        checkpointMatched: result.checkpointMatched
      },
      value: {
        ...result.observations,
        finalDigest: stateDigest(result.state),
        active: result.state.records.size,
        deletedBindings: result.state.deleted.size
      }
    })
  )
} else if (mode === 'delete-ack') {
  const mutation = JSON.parse(await readFile(join(directory, 'planned-change.json'), 'utf8'))
  await appendJournal(directory, [mutation])
  process.stdout.write(`${JSON.stringify({ stage: 'delete-ack' })}\n`)
  setInterval(() => {}, 1000)
} else {
  throw new Error('Unsupported journal child mode')
}
