import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises'
import { fork, spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measure, round } from './metrics.mjs'
import { runSqliteBench } from './persistence-sqlite.mjs'
import {
  digest,
  documentFor,
  encodeFrame,
  decodeFrames,
  syncDirectory,
  writeSnapshot,
  appendJournal,
  checkpointJournal
} from './persistence-store.mjs'

const CHILD_PATH = fileURLToPath(
  new URL('./persistence-child.mjs', import.meta.url)
)
const CHILD_TIMEOUT_MS = 15_000

async function fileBench(directoryPath, quick, samples, publish) {
  const updates = quick ? 3 : 30
  for (const recordCount of quick ? [10, 100] : [100, 1000]) {
    const documents = Array.from({ length: recordCount }, (_, id) =>
      documentFor(id + 1)
    )
    const payload = { revision: 0, documents }
    for (let sample = 0; sample < samples; sample++) {
      const fixture = await mkdtemp(join(directoryPath, 'snapshot-'))
      await writeSnapshot(fixture, payload)
      const measured = await measure(async () => {
        let outcome
        for (let revision = 1; revision <= updates; revision++)
          outcome = await writeSnapshot(fixture, { ...payload, revision })
        return outcome
      })
      assert.deepEqual(
        JSON.parse(await readFile(join(fixture, 'snapshot.json'), 'utf8')),
        {
          ...payload,
          revision: updates
        }
      )
      await publish({
        scenario: `atomic-json-snapshot-${recordCount}`,
        variant: 'file-sync-rename-directory-sync',
        sample,
        fixtureMetadata: {
          recordCount,
          updates,
          snapshotBytes: Buffer.byteLength(JSON.stringify(payload)),
          setupExcluded: true,
          serializationIncluded: true,
          directorySync: measured.value.directorySync,
          unsupportedDirectorySyncRetainsJournal: true
        },
        metrics: {
          ...measured.metrics,
          msPerUpdate: round(measured.metrics.wallMs / updates)
        },
        checks: {
          completeFinalSnapshot: true,
          revision: updates,
          nativeBackupFallback: measured.value.backupFallback
        }
      })
    }
  }
  const documents = Array.from({ length: quick ? 5 : 30 }, (_, index) =>
    documentFor(index + 1, 1)
  )
  for (let sample = 0; sample < samples; sample++) {
    const variants = ['sync-each-request', 'serialized-group-of-five']
    for (const variant of sample % 2 ? [...variants].reverse() : variants) {
      const fixture = await mkdtemp(join(directoryPath, 'append-'))
      const groupSize = variant === 'sync-each-request' ? 1 : 5
      const measured = await measure(async () => {
        const acknowledged = []
        let directorySync
        for (let offset = 0; offset < documents.length; offset += groupSize) {
          const result = await appendJournal(
            fixture,
            documents.slice(offset, offset + groupSize)
          )
          acknowledged.push(...result.acknowledged)
          if (result.directorySync) directorySync = result.directorySync
        }
        return { acknowledged, directorySync }
      })
      const parsed = decodeFrames(
        await readFile(join(fixture, 'journal.log'), 'utf8')
      )
      assert.equal(parsed.complete, true)
      assert.deepEqual(parsed.records.slice(1), documents)
      assert.deepEqual(
        measured.value.acknowledged,
        documents.map(({ id }) => id)
      )
      await publish({
        scenario: 'durable-journal-append',
        variant,
        sample,
        fixtureMetadata: {
          requests: documents.length,
          groupSize,
          framesBytes: Buffer.byteLength(documents.map(encodeFrame).join('')),
          serializationAndHashesIncluded: true,
          acknowledgments: 'only after corresponding file sync',
          alreadyUsedByProduct:
            'pending-frame coalescing exists; these are independent synthetic groups',
          directorySync: measured.value.directorySync
        },
        metrics: {
          ...measured.metrics,
          msPerRequest: round(measured.metrics.wallMs / documents.length)
        },
        checks: {
          acknowledgedFramesPreserved: true,
          frameOrder: true,
          completeJournal: true
        }
      })
    }
    const fixture = await mkdtemp(join(directoryPath, 'checkpoint-'))
    await appendJournal(fixture, documents)
    const original = await readFile(join(fixture, 'journal.log'), 'utf8')
    const measured = await measure(() => checkpointJournal(fixture, documents))
    const snapshot = JSON.parse(
      await readFile(join(fixture, 'snapshot.json'), 'utf8')
    )
    assert.deepEqual(snapshot.documents, documents)
    assert.equal(snapshot.checkpoint.digest, digest(original))
    const journal = await readFile(join(fixture, 'journal.log'), 'utf8')
    if (measured.value.compacted)
      assert.deepEqual(
        decodeFrames(journal).records[0].checkpoint,
        snapshot.checkpoint
      )
    else assert.equal(journal, original)
    await publish({
      scenario: 'journal-checkpoint-compaction',
      variant: 'snapshot-before-policy-gated-rotation',
      sample,
      fixtureMetadata: {
        recordCount: documents.length,
        originalJournalBytes: Buffer.byteLength(original),
        setupExcluded: true,
        serializationAndHashesIncluded: true,
        directorySync: measured.value.directorySync
      },
      metrics: measured.metrics,
      checks: {
        completeSnapshot: true,
        checkpointMatchesOldLog: true,
        compacted: measured.value.compacted,
        supportedPolicyRespected:
          measured.value.compacted === measured.value.directorySync.supported,
        unsupportedRetainedOriginalJournal: measured.value.compacted
          ? null
          : true
      }
    })
  }
}

async function replacementProbe(directoryPath, variant, publish) {
  const fixture = await mkdtemp(join(directoryPath, 'held-reader-'))
  await writeSnapshot(fixture, { revision: 0 })
  const target = join(fixture, 'snapshot.json')
  let release
  let reader
  if (variant === 'node-reader') {
    reader = await open(target, 'r')
    release = () => reader.close()
  } else {
    const script =
      '$f=[System.IO.File]::Open($env:BENCH_PERSISTENCE_HOLD_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read);[Console]::WriteLine("READY");[Console]::ReadLine()|Out-Null;$f.Dispose()'
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: { ...process.env, BENCH_PERSISTENCE_HOLD_PATH: target },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    const closed = new Promise((resolve) => {
      child.once('error', (error) => resolve({ error }))
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error('Windows reader timed out'))
        }, CHILD_TIMEOUT_MS)
        let output = ''
        child.stdout.on('data', (chunk) => {
          output += chunk
          if (output.includes('READY')) {
            clearTimeout(timer)
            resolve()
          }
        })
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          if (!output.includes('READY'))
            reject(new Error(`Windows reader startup exited ${code}`))
        })
        child.stderr.resume()
      })
      assert.equal(
        child.exitCode,
        null,
        'Windows reader must still hold the fixture'
      )
    } catch (error) {
      child.kill()
      await closed
      throw error
    }
    release = async () => {
      child.stdin.end('\n')
      const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS)
      try {
        const outcome = await closed
        if (outcome.error) throw outcome.error
        if (outcome.code !== 0)
          throw new Error(
            `Windows reader exited ${outcome.code}; signal=${outcome.signal}`
          )
      } finally {
        clearTimeout(timer)
      }
    }
  }
  let failureCode = null
  let outcome
  try {
    try {
      outcome = await writeSnapshot(fixture, { revision: 1 })
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(error.code))
        throw error
      failureCode = error.code
    }
    const visible = JSON.parse(await readFile(target, 'utf8'))
    assert.equal(visible.revision, failureCode ? 0 : 1)
    const heldReaderRevision = reader
      ? JSON.parse(await reader.readFile('utf8')).revision
      : null
    if (reader && !failureCode && process.platform !== 'win32')
      assert.equal(heldReaderRevision, 0)
    await publish({
      scenario: 'replace-with-open-reader',
      variant,
      sample: 0,
      fixtureMetadata: {
        reader:
          variant === 'node-reader'
            ? 'Node/libuv regular read handle'
            : '.NET FileShare.Read without Delete',
        timingIsCorrectnessOnly: true
      },
      metrics: null,
      checks: {
        replacement: failureCode ? 'denied-old-preserved' : 'succeeded',
        failureCode,
        visibleRevision: visible.revision,
        heldReaderRevision,
        nativeBackupFallback: outcome?.backupFallback ?? null
      }
    })
  } finally {
    await release()
  }
  await writeSnapshot(fixture, { revision: 2 })
  assert.equal(JSON.parse(await readFile(target, 'utf8')).revision, 2)
}

async function killAtCheckpoint(directoryPath, stage) {
  const child = fork(CHILD_PATH, [directoryPath, stage], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: []
  })
  const acknowledged = []
  let reached = false
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2000)
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Crash child timed out: ${stage}`))
    }, CHILD_TIMEOUT_MS)
    child.on('message', (message) => {
      if (message.kind === 'acked') acknowledged.push(...message.ids)
      if (message.kind === 'checkpoint' && message.stage === stage) {
        reached = true
        child.kill('SIGKILL')
      }
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (!reached)
        reject(
          new Error(
            `Crash child missed ${stage}; code=${code} signal=${signal} ${stderr}`
          )
        )
      else resolve({ acknowledged, code, signal })
    })
  })
}

async function crashBench(directoryPath, publish) {
  for (const stage of [
    'journal-acked',
    'snapshot-file-synced',
    'backup-moved',
    'snapshot-replaced'
  ]) {
    const fixture = await mkdtemp(join(directoryPath, 'crash-'))
    await writeSnapshot(fixture, { revision: 0, documents: [] })
    const killed = await killAtCheckpoint(fixture, stage)
    const target = join(fixture, 'snapshot.json')
    let backupRecovered = false
    let raw
    try {
      raw = await readFile(target, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await rename(`${target}.backup`, target)
      raw = await readFile(target, 'utf8')
      backupRecovered = true
    }
    const snapshot = JSON.parse(raw)
    assert([0, 3].includes(snapshot.revision))
    assert.equal(snapshot.documents.length, snapshot.revision)
    const replayed = decodeFrames(
      await readFile(join(fixture, 'journal.log'), 'utf8')
    )
    assert.equal(replayed.complete, true)
    const recovered = new Map(
      snapshot.documents.map((document) => [document.id, document])
    )
    for (const document of replayed.records.slice(1))
      recovered.set(document.id, document)
    assert.deepEqual(killed.acknowledged, [1, 2, 3])
    for (const id of killed.acknowledged)
      assert.deepEqual(recovered.get(id), documentFor(id, 1))
    await publish({
      scenario: 'process-kill-recovery',
      variant: stage,
      sample: 0,
      fixtureMetadata: {
        acknowledgedDocuments: 3,
        forcedBackupHandoff: stage === 'backup-moved',
        timingIsCorrectnessOnly: true,
        termination:
          'SIGKILL / native force terminate; not power-loss simulation'
      },
      metrics: null,
      checks: {
        reachedCheckpoint: true,
        completeOldOrNewSnapshot: true,
        snapshotRevision: snapshot.revision,
        backupRecovered,
        acknowledgedFramesRecovered: true,
        recoveredDocuments: recovered.size,
        childExitCode: killed.code,
        childSignal: killed.signal
      }
    })
  }
  const documents = [documentFor(1, 1), documentFor(2, 1)]
  const raw =
    documents.map(encodeFrame).join('') +
    encodeFrame(documentFor(3, 1)).slice(0, 30)
  const parsed = decodeFrames(raw)
  assert.equal(parsed.complete, false)
  assert.deepEqual(parsed.records, documents)
  await publish({
    scenario: 'torn-journal-tail',
    variant: 'deterministic-truncation',
    sample: 0,
    fixtureMetadata: {
      completeFrames: 2,
      partialFrameBytes: 30,
      timingIsCorrectnessOnly: true
    },
    metrics: null,
    checks: { incompleteTailDetected: true, precedingFramesPreserved: true }
  })
}

export async function runPersistenceBench({
  base,
  quick = false,
  sampleCount = 3,
  emit
}) {
  assert.equal(typeof base, 'string')
  assert(Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 5)
  assert.equal(typeof emit, 'function')
  await mkdir(base, { recursive: true })
  const fixture = await mkdtemp(join(base, 'persistence-'))
  const rows = []
  const publish = async (row) => {
    const result = { suite: 'persistence', ...row }
    await emit(result)
    rows.push(result)
  }
  try {
    const observed = await syncDirectory(fixture)
    await publish({
      scenario: 'native-directory-sync',
      variant: process.platform,
      sample: 0,
      fixtureMetadata: {
        policy: 'EINVAL/EISDIR; Windows EPERM means unsupported',
        timingIsCorrectnessOnly: true
      },
      metrics: null,
      checks: { ...observed, journalCompactionAllowed: observed.supported }
    })
    await runSqliteBench(fixture, quick, sampleCount, publish)
    await fileBench(fixture, quick, sampleCount, publish)
    await replacementProbe(fixture, 'node-reader', publish)
    if (process.platform === 'win32')
      await replacementProbe(fixture, 'windows-no-delete-share', publish)
    await crashBench(fixture, publish)
    return rows
  } finally {
    // Every removed file was generated in this uniquely owned fixture directory.
    await rm(fixture, { recursive: true, force: true })
  }
}
