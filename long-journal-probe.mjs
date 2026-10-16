import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

const TARGETS_MIB = [8, 32, 100]
const MUTATIONS = 100
const FRAME = `${JSON.stringify({ version: 1, kind: 'mutation', seq: 1, payload: 'x'.repeat(420) })}\n`
const HEADER = `${JSON.stringify({ version: 1, kind: 'header', generation: 'synthetic-long-journal' })}\n`

const codeOf = (error) => (typeof error?.code === 'string' ? error.code : error?.name ?? 'unknown')

async function syncFile(path, content) {
  const handle = await open(path, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(directory, flag) {
  const handle = await open(directory, flag)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function selectDirectoryFlag(root) {
  const flags = process.platform === 'win32'
    ? [['O_RDWR', constants.O_RDWR], ['O_RDONLY', constants.O_RDONLY]]
    : [['O_RDONLY', constants.O_RDONLY]]
  for (const [name, flag] of flags) {
    try {
      await syncDirectory(root, flag)
      return { name, flag }
    } catch (error) {
      console.log(`directory-sync flag=${name} result=unsupported code=${codeOf(error)}`)
    }
  }
  return { name: 'none', flag: null }
}

async function seedJournal(path, targetBytes) {
  const handle = await open(path, 'w')
  const hash = createHash('sha256')
  let bytes = 0
  try {
    const header = Buffer.from(HEADER, 'utf8')
    await handle.write(header)
    hash.update(header)
    bytes += header.byteLength
    const chunk = Buffer.from(FRAME.repeat(2048), 'utf8')
    while (bytes < targetBytes) {
      const remaining = targetBytes - bytes
      const value = remaining < chunk.byteLength ? chunk.subarray(0, remaining) : chunk
      await handle.write(value)
      hash.update(value)
      bytes += value.byteLength
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
  return { bytes, digest: hash.digest('hex') }
}

async function appendMutations(path) {
  const handle = await open(path, 'a')
  try {
    for (let index = 0; index < MUTATIONS; index += 10) {
      await handle.write(FRAME.repeat(10), 'utf8')
      await handle.sync()
    }
  } finally {
    await handle.close()
  }
}

async function runCase(root, targetMiB, directory) {
  const caseRoot = await mkdtemp(join(root, `long-${targetMiB}-`))
  const journalPath = join(caseRoot, 'pending-tasks.journal')
  const snapshotPath = join(caseRoot, 'pending-tasks.json')
  const snapshotTemp = `${snapshotPath}.tmp`
  const journalTemp = `${journalPath}.tmp`
  let heartbeatMaxGap = 0
  let lastHeartbeat = performance.now()
  const heartbeat = setInterval(() => {
    const now = performance.now()
    heartbeatMaxGap = Math.max(heartbeatMaxGap, now - lastHeartbeat)
    lastHeartbeat = now
  }, 10)
  const started = performance.now()
  try {
    const seeded = await seedJournal(journalPath, targetMiB * 1024 * 1024)
    const appendStarted = performance.now()
    await appendMutations(journalPath)
    const appendMs = performance.now() - appendStarted
    const checkpointStarted = performance.now()
    const snapshot = JSON.stringify({ version: 5, sequence: MUTATIONS, journalBytes: seeded.bytes, digest: seeded.digest })
    await syncFile(snapshotTemp, snapshot)
    await rename(snapshotTemp, snapshotPath)
    let directorySync = 'unsupported'
    if (directory.flag !== null) {
      await syncDirectory(caseRoot, directory.flag)
      directorySync = 'ok'
    }
    const checkpointMs = performance.now() - checkpointStarted
    let compacted = false
    if (directory.flag !== null) {
      const compactStarted = performance.now()
      await syncFile(journalTemp, HEADER)
      await rename(journalTemp, journalPath)
      await syncDirectory(caseRoot, directory.flag)
      compacted = true
      console.log(`compact target=${targetMiB}MiB ms=${(performance.now() - compactStarted).toFixed(1)}`)
    }
    const reopenedSnapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
    const reopenedJournalBytes = (await readFile(journalPath)).byteLength
    if (reopenedSnapshot.version !== 5) throw new Error('snapshot-version')
    const result = {
      filesystem: process.env.PROBE_VOLUME_FS ?? 'unknown',
      targetMiB,
      seededJournalBytes: seeded.bytes,
      reopenedJournalBytes,
      mutations: MUTATIONS,
      directorySync,
      compacted,
      appendMs: Number(appendMs.toFixed(1)),
      checkpointMs: Number(checkpointMs.toFixed(1)),
      totalMs: Number((performance.now() - started).toFixed(1)),
      heartbeatMaxGapMs: Number(heartbeatMaxGap.toFixed(1)),
    }
    console.log(JSON.stringify(result))
    return result
  } finally {
    clearInterval(heartbeat)
    await rm(caseRoot, { recursive: true, force: true })
  }
}

async function main() {
  const root = process.env.PROBE_ROOT
  if (!root) throw new Error('PROBE_ROOT is required')
  const directory = await selectDirectoryFlag(root)
  const results = []
  for (const targetMiB of TARGETS_MIB) results.push(await runCase(root, targetMiB, directory))
  const evidencePath = process.env.PROBE_EVIDENCE
  if (evidencePath) await syncFile(evidencePath, JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, results }, null, 2))
}

main().catch((error) => {
  console.error(`fatal code=${codeOf(error)}`)
  process.exitCode = 1
})
