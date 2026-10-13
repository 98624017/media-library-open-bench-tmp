import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { measure } from '../platform/metrics.mjs'
import {
  appendJournal,
  checkpointJournal,
  decodeFrames,
  digest,
  encodeFrame,
  syncDirectory
} from '../platform/persistence-store.mjs'

const RECOVERY_VARIANTS = ['full-text-prefix-count', 'full-text-linear-count', 'stream-yield']
const SCALES = ['small', 'medium', 'large']
const FULL_COUNTS = [1000, 4000, 12000]
const QUICK_COUNTS = [128, 512, 1536]
const SLOT_COUNT = 32
const CHECKPOINT_SHARE = 0.875
const YIELD_FRAMES = 128
const CHILD_TIMEOUT_MS = 275000
const CHILD_PATH = fileURLToPath(new URL('./journal-child.mjs', import.meta.url))
const runFile = promisify(execFile)
const TEXT = 'generated 样本 '.repeat(22)

export const PROFILES = [
  ...SCALES.flatMap((scale) =>
    RECOVERY_VARIANTS.map((variant) => ({ scenario: `growth-${scale}`, variant }))
  ),
  { scenario: 'real-synced-appends', variant: 'existing-sync-before-ack', samples: 1 },
  { scenario: 'directory-sync-policy', variant: 'native-observation', samples: 1 },
  { scenario: 'replay-correctness', variant: 'checkpoint-old-log-delete', samples: 1 }
]

const emptyState = () => ({ records: new Map(), deleted: new Map() })
const sortedEntries = (map) => [...map].sort(([left], [right]) => left.localeCompare(right))
const plainState = (state) => ({
  records: sortedEntries(state.records),
  deleted: sortedEntries(state.deleted)
})
export const stateDigest = (state) => digest(JSON.stringify(plainState(state)))

// Generic exact-binding deletion and before-digest CAS, without the application's schema or adapters.
export function applyChange(state, change) {
  const current = state.records.get(change.key)
  if (change.after === null) {
    if (!current || current.binding === change.deletedBinding) {
      state.deleted.set(change.key, change.deletedBinding)
      state.records.delete(change.key)
    }
    return
  }
  if (state.deleted.get(change.key) === change.after.binding) return
  if (current && change.expected === null && current.binding === change.after.binding) return
  if (current && change.expected !== null && digest(JSON.stringify(current)) !== change.expected)
    return
  state.records.set(change.key, change.after)
}

function nextChange(step, slots, state) {
  const key = `slot-${step % slots}`
  const epoch = Math.floor(step / slots)
  const current = state.records.get(key)
  return {
    entryKind: 'mutation',
    id: `change-${step}`,
    key,
    expected: current ? digest(JSON.stringify(current)) : null,
    after:
      epoch % 4 === 2
        ? null
        : {
            key,
            binding: current?.binding ?? `binding-${key}-${epoch}`,
            revision: step,
            text: TEXT
          },
    ...(epoch % 4 === 2 ? { deletedBinding: current.binding } : {})
  }
}

export async function createFixture(directory, frames, slots = SLOT_COUNT) {
  assert(Number.isInteger(slots) && slots > 0 && slots <= SLOT_COUNT)
  assert(Number.isInteger(frames) && frames > slots)
  await mkdir(directory, { recursive: true })
  const state = emptyState()
  const checkpointFrame = Math.floor(frames * CHECKPOINT_SHARE)
  const prefixHasher = createHash('sha256')
  const fileHasher = createHash('sha256')
  const handle = await open(join(directory, 'journal.log'), 'wx')
  let bytes = 0
  let snapshot
  let buffered = encodeFrame({ entryKind: 'header', generation: 'synthetic' })
  prefixHasher.update(buffered)
  fileHasher.update(buffered)
  bytes += Buffer.byteLength(buffered)
  try {
    for (let step = 0; step < frames; step++) {
      const change = nextChange(step, slots, state)
      applyChange(state, change)
      const frame = encodeFrame(change)
      const frameBytes = Buffer.byteLength(frame)
      buffered += frame
      bytes += frameBytes
      fileHasher.update(frame)
      if (step < checkpointFrame) prefixHasher.update(frame)
      if (step + 1 === checkpointFrame) {
        snapshot = {
          ...plainState(state),
          checkpoint: { bytes, digest: prefixHasher.digest('hex') }
        }
      }
      if (Buffer.byteLength(buffered) >= 256 * 1024) {
        await handle.writeFile(buffered, 'utf8')
        buffered = ''
      }
    }
    if (buffered) await handle.writeFile(buffered, 'utf8')
  } finally {
    await handle.close()
  }
  const manifest = {
    frames,
    slots,
    bytes,
    checkpointFrame,
    sourceDigest: fileHasher.digest('hex'),
    expectedDigest: stateDigest(state),
    expectedActive: state.records.size,
    expectedDeletedBindings: state.deleted.size,
    fixtureMethod: 'generated-accumulation-without-per-frame-fsync'
  }
  await writeFile(join(directory, 'snapshot.json'), JSON.stringify(snapshot), 'utf8')
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  return { manifest, state }
}

function validChange(value) {
  return (
    value?.entryKind === 'mutation' &&
    typeof value.id === 'string' &&
    typeof value.key === 'string' &&
    (value.expected === null ||
      (typeof value.expected === 'string' && /^[a-f0-9]{64}$/.test(value.expected))) &&
    (value.after === null
      ? typeof value.deletedBinding === 'string'
      : value.after?.key === value.key &&
        typeof value.after.binding === 'string' &&
        Number.isSafeInteger(value.after.revision) &&
        typeof value.after.text === 'string')
  )
}

function readFrame(frame, observations, seen) {
  let decoded
  try {
    decoded = decodeFrames(frame)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    decoded = { complete: false, records: [] }
  }
  if (!decoded.complete || decoded.records.length !== 1) {
    observations.invalidFrames++
    return null
  }
  const value = decoded.records[0]
  if (value?.entryKind === 'header') {
    if (
      observations.visitedFrames !== 1 ||
      observations.headerSeen ||
      value.generation !== 'synthetic'
    ) {
      observations.invalidFrames++
    }
    observations.headerSeen = true
    return null
  }
  if (!validChange(value)) {
    observations.invalidFrames++
    return null
  }
  const frameDigest = digest(JSON.stringify(value))
  if (seen.has(value.id)) {
    observations.duplicateFrames++
    if (seen.get(value.id) !== frameDigest) observations.invalidFrames++
    return null
  }
  seen.set(value.id, frameDigest)
  return value
}

async function* rawFrames(path, chunkBytes) {
  const source = createReadStream(path, { highWaterMark: chunkBytes })
  let pending = Buffer.alloc(0)
  try {
    for await (const chunk of source) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      let separator = pending.indexOf(0x1e, 1)
      while (separator >= 0) {
        yield pending.subarray(0, separator)
        pending = pending.subarray(separator)
        separator = pending.indexOf(0x1e, 1)
      }
    }
    // Preserve every byte at EOF; missing LF and CRLF remain incomplete evidence.
    if (pending.length) yield pending
  } finally {
    source.destroy()
  }
}

export async function recoverFixture(directory, variant, { streamChunkBytes = 65536 } = {}) {
  assert(RECOVERY_VARIANTS.includes(variant))
  assert(Number.isInteger(streamChunkBytes) && streamChunkBytes > 0)
  const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'))
  assert(Array.isArray(snapshot.records) && Array.isArray(snapshot.deleted))
  assert(Number.isSafeInteger(snapshot.checkpoint?.bytes) && snapshot.checkpoint.bytes >= 0)
  const state = { records: new Map(snapshot.records), deleted: new Map(snapshot.deleted) }
  const seen = new Map()
  const observations = {
    visitedFrames: 0,
    replayedFrames: 0,
    duplicateFrames: 0,
    invalidFrames: 0,
    headerSeen: false,
    validationBytes: 0,
    offsetCountBytes: 0,
    yieldCount: 0
  }
  let checkpointMatched = false
  const replay = (value, offset) => {
    if (value && offset > snapshot.checkpoint.bytes) {
      applyChange(state, value)
      observations.replayedFrames++
    }
  }
  if (variant === 'stream-yield') {
    const hasher = createHash('sha256')
    for await (const frame of rawFrames(join(directory, 'journal.log'), streamChunkBytes)) {
      const frameBytes = frame.length
      observations.visitedFrames++
      observations.validationBytes += frameBytes
      observations.offsetCountBytes += frameBytes
      if (observations.validationBytes <= snapshot.checkpoint.bytes) hasher.update(frame)
      if (observations.validationBytes === snapshot.checkpoint.bytes) {
        checkpointMatched = hasher.digest('hex') === snapshot.checkpoint.digest
      }
      replay(readFrame(frame.toString('utf8'), observations, seen), observations.validationBytes)
      if (observations.visitedFrames % YIELD_FRAMES === 0) {
        await immediate()
        observations.yieldCount++
      }
    }
  } else {
    const raw = await readFile(join(directory, 'journal.log'), 'utf8')
    const prefix = Buffer.from(raw, 'utf8').subarray(0, snapshot.checkpoint.bytes)
    checkpointMatched =
      prefix.length === snapshot.checkpoint.bytes && digest(prefix) === snapshot.checkpoint.digest
    const frames = raw.split('\u001e')
    if (frames.shift() !== '') observations.invalidFrames++
    let characterOffset = 0
    const parsed = []
    for (const part of frames) {
      const frame = `\u001e${part}`
      characterOffset += frame.length
      const frameBytes = Buffer.byteLength(frame)
      observations.visitedFrames++
      observations.validationBytes += frameBytes
      const endOffset =
        variant === 'full-text-prefix-count'
          ? Buffer.byteLength(raw.slice(0, characterOffset), 'utf8')
          : observations.validationBytes
      observations.offsetCountBytes += variant === 'full-text-prefix-count' ? endOffset : frameBytes
      const value = readFrame(frame, observations, seen)
      if (value) parsed.push({ value, endOffset })
    }
    for (const { value, endOffset } of parsed) replay(value, endOffset)
  }
  return {
    state,
    observations,
    checkpointMatched,
    complete: observations.invalidFrames === 0 && observations.headerSeen && checkpointMatched
  }
}

async function recoveryRow(directory, variant, scenario, sample, workload) {
  const { stdout } = await runFile(process.execPath, [CHILD_PATH, 'recover', directory, variant], {
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  })
  const measured = JSON.parse(stdout)
  assert.equal(measured.checks.complete, true)
  assert.equal(measured.checks.expectedState, true)
  assert.equal(measured.value.validationBytes, workload.bytes)
  assert.equal(measured.value.visitedFrames, workload.frames + 1)
  assert.equal(measured.value.replayedFrames, workload.frames - workload.checkpointFrame)
  if (variant !== 'full-text-prefix-count')
    assert.equal(measured.value.offsetCountBytes, workload.bytes)
  else assert(measured.value.offsetCountBytes > (workload.bytes * workload.frames) / 4)
  return {
    suite: 'journal-growth',
    scenario,
    variant,
    sample,
    workload,
    metrics: measured.metrics,
    checks: measured.checks,
    observations: measured.value
  }
}

async function actualAppends(directory, quick) {
  await mkdir(directory)
  const state = emptyState()
  const changes = Array.from({ length: quick ? 24 : 128 }, (_, step) => {
    const change = nextChange(step, quick ? 8 : SLOT_COUNT, state)
    applyChange(state, change)
    return change
  })
  const measured = await measure(async () => {
    const acknowledged = []
    for (let start = 0; start < changes.length; start += 4) {
      const appended = await appendJournal(directory, changes.slice(start, start + 4))
      acknowledged.push(...appended.acknowledged)
    }
    return acknowledged
  })
  const raw = await readFile(join(directory, 'journal.log'), 'utf8')
  const replayed = emptyState()
  const decoded = decodeFrames(raw)
  for (const change of decoded.records.slice(1)) applyChange(replayed, change)
  assert(decoded.complete)
  assert.equal(stateDigest(replayed), stateDigest(state))
  assert.equal(measured.value.length, changes.length)
  return {
    state,
    raw,
    row: {
      suite: 'journal-growth',
      scenario: 'real-synced-appends',
      variant: 'existing-sync-before-ack',
      sample: 0,
      workload: {
        frames: changes.length,
        syncGroups: changes.length / 4,
        groupSize: 4,
        slots: quick ? 8 : SLOT_COUNT
      },
      metrics: measured.metrics,
      checks: { complete: true, allAcknowledged: true, expectedState: true },
      observations: { bytes: Buffer.byteLength(raw), acknowledgedFrames: measured.value.length }
    }
  }
}

async function killAtAck(directory) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD_PATH, 'delete-ack', directory], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let message = ''
    let acknowledged = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('delete ACK child timed out'))
    }, 30000)
    child.stdout.on('data', (chunk) => {
      message += chunk.toString('utf8')
      if (message.includes('\n')) {
        try {
          assert.equal(JSON.parse(message.trim()).stage, 'delete-ack')
          acknowledged = true
          child.kill('SIGKILL')
        } catch (error) {
          child.kill('SIGKILL')
          reject(error)
        }
      }
    })
    child.stderr.resume()
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', () => {
      clearTimeout(timer)
      if (!acknowledged) reject(new Error('delete ACK child exited before acknowledgement'))
      else resolve({ acknowledged: true, forcedTermination: true })
    })
  })
}

export async function correctnessChecks(root, fixture) {
  const copied = async (name) => {
    const directory = join(root, name)
    await mkdir(directory)
    await Promise.all(
      ['journal.log', 'snapshot.json'].map((file) =>
        copyFile(join(fixture, file), join(directory, file))
      )
    )
    return directory
  }
  const original = await recoverFixture(fixture, 'full-text-linear-count')
  const raw = await readFile(join(fixture, 'journal.log'), 'utf8')
  const first = decodeFrames(raw).records.find((value) => value.entryKind === 'mutation')
  assert(first)
  const duplicate = await copied('duplicate')
  await appendFile(join(duplicate, 'journal.log'), encodeFrame(first), 'utf8')
  const duplicateResult = await recoverFixture(duplicate, 'full-text-linear-count')
  assert(duplicateResult.complete)
  assert.equal(stateDigest(duplicateResult.state), stateDigest(original.state))
  const conflict = await copied('conflicting-id')
  await appendFile(
    join(conflict, 'journal.log'),
    encodeFrame({ ...first, after: { ...first.after, revision: -1 } }),
    'utf8'
  )
  const conflictResult = await recoverFixture(conflict, 'full-text-linear-count')
  assert.equal(conflictResult.complete, false)
  assert.equal(stateDigest(conflictResult.state), stateDigest(original.state))
  const torn = await copied('torn-tail')
  await appendFile(join(torn, 'journal.log'), encodeFrame(first).slice(0, 45), 'utf8')
  const tornResult = await recoverFixture(torn, 'stream-yield')
  assert.equal(tornResult.complete, false)
  assert.equal(stateDigest(tornResult.state), stateDigest(original.state))
  const crash = join(root, 'delete-crash')
  const accumulated = await createFixture(crash, 256, 16)
  const [key, current] = accumulated.state.records.entries().next().value
  const deletion = {
    entryKind: 'mutation',
    id: 'new-delete',
    key,
    expected: digest(JSON.stringify(current)),
    after: null,
    deletedBinding: current.binding
  }
  await writeFile(join(crash, 'planned-change.json'), JSON.stringify(deletion), 'utf8')
  applyChange(accumulated.state, deletion)
  const termination = await killAtAck(crash)
  const recovered = await recoverFixture(crash, 'full-text-linear-count')
  assert(recovered.complete)
  assert.equal(stateDigest(recovered.state), stateDigest(accumulated.state))
  await appendFile(
    join(crash, 'journal.log'),
    encodeFrame({ ...deletion, id: 'duplicate-delete' }),
    'utf8'
  )
  const idempotent = await recoverFixture(crash, 'stream-yield')
  assert(idempotent.complete)
  assert.equal(stateDigest(idempotent.state), stateDigest(recovered.state))
  return {
    duplicateIdIsIdempotent: true,
    conflictingIdIsIncomplete: true,
    tornTailPreservesKnownState: true,
    deleteAfterCheckpointSurvivesForcedTermination: true,
    duplicateDeletionIsIdempotent: true,
    oldLogAndCheckpointAgree: true,
    termination
  }
}

export async function runBench({ base, quick, sampleCount, emit }) {
  assert(Number.isInteger(sampleCount) && sampleCount > 0)
  const root = await mkdtemp(join(base, 'journal-growth-'))
  const emitted = []
  let cleaned = false
  try {
    const fixtures = []
    for (let index = 0; index < SCALES.length; index++) {
      const directory = join(root, SCALES[index])
      const { manifest } = await createFixture(
        directory,
        (quick ? QUICK_COUNTS : FULL_COUNTS)[index]
      )
      fixtures.push({ directory, manifest })
      for (let sample = 0; sample < sampleCount; sample++) {
        const order = RECOVERY_VARIANTS.map(
          (_, offset) => RECOVERY_VARIANTS[(offset + sample) % RECOVERY_VARIANTS.length]
        )
        for (const variant of order) {
          const row = await recoveryRow(
            directory,
            variant,
            `growth-${SCALES[index]}`,
            sample,
            manifest
          )
          emitted.push(row)
          await emit(row)
        }
      }
    }
    const actualRoot = join(root, 'actual-writes')
    const actual = await actualAppends(actualRoot, quick)
    emitted.push(actual.row)
    await emit(actual.row)
    const supported = await syncDirectory(actualRoot)
    const checkpoint = await checkpointJournal(actualRoot, [plainState(actual.state)])
    const afterRaw = await readFile(join(actualRoot, 'journal.log'), 'utf8')
    assert.equal(checkpoint.compacted, supported.supported)
    assert(
      supported.supported
        ? Buffer.byteLength(afterRaw) < Buffer.byteLength(actual.raw)
        : afterRaw === actual.raw
    )
    const policy = {
      suite: 'journal-growth',
      scenario: 'directory-sync-policy',
      variant: 'native-observation',
      sample: 0,
      workload: {
        bytesBefore: Buffer.byteLength(actual.raw),
        bytesAfter: (await stat(join(actualRoot, 'journal.log'))).size
      },
      metrics: null,
      checks: { policyRespected: true, journalRetainedWhenUnsupported: true },
      observations: { directorySync: supported, compacted: checkpoint.compacted }
    }
    emitted.push(policy)
    await emit(policy)
    const checks = await correctnessChecks(root, fixtures[0].directory)
    const correctness = {
      suite: 'journal-growth',
      scenario: 'replay-correctness',
      variant: 'checkpoint-old-log-delete',
      sample: 0,
      workload: { syntheticCrashFrames: 256, cases: 5 },
      metrics: null,
      checks: { expectedState: true, knownDeletedStatePreserved: true },
      observations: checks
    }
    emitted.push(correctness)
    await emit(correctness)
  } finally {
    await rm(root, { recursive: true, force: true })
    cleaned = true
  }
  assert.equal(emitted.length, SCALES.length * RECOVERY_VARIANTS.length * sampleCount + 3)
  return {
    profiles: PROFILES.length,
    rows: emitted.length,
    checks: { allControlsPassed: true, ownedRootCleaned: cleaned },
    calibration:
      'generic framed journal, checkpoint prefix digest, exact binding deletion, before-image CAS, sync-before-ack',
    limitations: [
      'Generated growth fixtures do not fsync every frame and measure recovery cost only.',
      'Full-text prefix counting reproduces an observed offset-calculation cost, not application source or its complete schema.',
      'Stream/yield is a recovery experiment; directory-sync/compaction durability policy is unchanged.',
      'Crash checks demonstrate process reopen, not power-loss durability.',
      'Recovery variants run in isolated children; metrics exclude child startup, fixture generation, verification and cleanup.',
      'OS cache is not purged; before-digest checks omit application-specific ownership, admission and capacity rules.'
    ]
  }
}
