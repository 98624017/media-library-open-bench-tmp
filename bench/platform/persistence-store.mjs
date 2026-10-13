import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

const DIRECTORY_LIMIT_CODES = new Set(['EINVAL', 'EISDIR'])
const DOCUMENT_TEXT = 'generated content '.repeat(100)

export const digest = (raw) => createHash('sha256').update(raw).digest('hex')

export function documentFor(id, revision = 0) {
  return {
    id,
    revision,
    status: 'pending',
    text: DOCUMENT_TEXT,
    files: [`file-${id}.png`]
  }
}

// Generic byte-length/hash frames exercise torn-tail detection; no application schema is used.
export function encodeFrame(document) {
  const raw = JSON.stringify(document)
  return `\u001e${Buffer.byteLength(raw)}:${digest(raw)}:${raw}\u001f\n`
}

export function decodeFrames(raw) {
  const records = []
  let complete = raw === '' || raw.startsWith('\u001e')
  for (const candidate of raw.split('\u001e').slice(1)) {
    const match = /^(\d+):([a-f0-9]{64}):([\s\S]*)\u001f\n$/.exec(candidate)
    if (
      !match ||
      Number(match[1]) !== Buffer.byteLength(match[3]) ||
      digest(match[3]) !== match[2]
    ) {
      complete = false
      continue
    }
    records.push(JSON.parse(match[3]))
  }
  return { records, complete }
}

export async function syncDirectory(directoryPath) {
  let phase = 'open'
  let handle
  try {
    handle = await open(directoryPath, constants.O_RDONLY)
    phase = 'sync'
    await handle.sync()
    return { supported: true, phase: 'sync', code: null }
  } catch (error) {
    const expected =
      DIRECTORY_LIMIT_CODES.has(error.code) ||
      (process.platform === 'win32' && error.code === 'EPERM')
    if (!expected) throw error
    return { supported: false, phase, code: error.code }
  } finally {
    if (handle) await handle.close()
  }
}

async function replaceSnapshot(temporary, target, forceBackup, checkpoint) {
  if (!forceBackup) {
    try {
      await rename(temporary, target)
      return false
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error
    }
  }
  const backup = `${target}.backup`
  await rm(backup, { force: true })
  let oldMoved = false
  try {
    await rename(target, backup)
    oldMoved = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await checkpoint('backup-moved')
  try {
    await rename(temporary, target)
  } catch (error) {
    if (oldMoved) {
      try {
        await rename(backup, target)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'replacement rollback failed'
        )
      }
    }
    throw error
  }
  return true
}

export async function writeSnapshot(directoryPath, payload, options = {}) {
  const temporary = join(directoryPath, `snapshot-${randomUUID()}.tmp`)
  const target = join(directoryPath, 'snapshot.json')
  const checkpoint = options.checkpoint ?? (async () => {})
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(payload), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await checkpoint('snapshot-file-synced')
    const backupFallback = await replaceSnapshot(
      temporary,
      target,
      options.forceBackup,
      checkpoint
    )
    await checkpoint('snapshot-replaced')
    const directorySync = await syncDirectory(directoryPath)
    await rm(`${target}.backup`, { force: true })
    return { directorySync, backupFallback }
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function appendJournal(directoryPath, documents) {
  const target = join(directoryPath, 'journal.log')
  let created = true
  let handle
  try {
    handle = await open(target, 'ax', 0o600)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    created = false
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW
    )
  }
  try {
    assert((await handle.stat()).isFile())
    const header = created
      ? encodeFrame({ entryKind: 'header', generation: 'synthetic' })
      : ''
    await handle.writeFile(header + documents.map(encodeFrame).join(''), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  const directorySync = created ? await syncDirectory(directoryPath) : null
  // The caller may acknowledge this complete group only after the awaited sync.
  return {
    created,
    acknowledged: documents.map(({ id }) => id),
    directorySync
  }
}

export async function checkpointJournal(directoryPath, documents) {
  const target = join(directoryPath, 'journal.log')
  const raw = await readFile(target, 'utf8')
  assert.equal(decodeFrames(raw).complete, true)
  const checkpoint = { bytes: Buffer.byteLength(raw), digest: digest(raw) }
  const written = await writeSnapshot(directoryPath, {
    revision: documents.length,
    documents,
    checkpoint
  })
  if (!written.directorySync.supported) return { ...written, compacted: false }
  assert.equal(await readFile(target, 'utf8'), raw)
  const temporary = join(directoryPath, `journal-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(
      encodeFrame({ entryKind: 'header', checkpoint }),
      'utf8'
    )
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, target)
    assert.equal((await syncDirectory(directoryPath)).supported, true)
  } finally {
    await rm(temporary, { force: true })
  }
  return { ...written, compacted: true }
}
