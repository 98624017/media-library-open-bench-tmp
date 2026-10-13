import assert from 'node:assert/strict'
import {
  appendJournal,
  documentFor,
  writeSnapshot
} from './persistence-store.mjs'

const [directoryPath, requestedStage] = process.argv.slice(2)
assert(directoryPath && requestedStage)
assert(process.send)

async function send(message) {
  await new Promise((resolve, reject) =>
    process.send(message, (error) => (error ? reject(error) : resolve()))
  )
}

async function checkpoint(stage) {
  if (stage !== requestedStage) return
  await send({ kind: 'checkpoint', stage })
  // The IPC listener retains the child while the parent force-terminates this handoff.
  process.on('message', () => {})
  await new Promise(() => {})
}

const documents = Array.from({ length: 3 }, (_, index) =>
  documentFor(index + 1, 1)
)

for (const document of documents) {
  const result = await appendJournal(directoryPath, [document])
  await send({ kind: 'acked', ids: result.acknowledged })
}
await checkpoint('journal-acked')
await writeSnapshot(
  directoryPath,
  { revision: 3, documents },
  {
    checkpoint,
    forceBackup: requestedStage === 'backup-moved'
  }
)
throw new Error(`The requested checkpoint was never reached: ${requestedStage}`)
