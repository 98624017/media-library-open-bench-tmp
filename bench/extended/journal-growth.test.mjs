import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { digest, encodeFrame } from '../platform/persistence-store.mjs'
import {
  applyChange,
  correctnessChecks,
  createFixture,
  recoverFixture,
  stateDigest
} from './journal-growth.mjs'

test('identical recovery state with UTF-8 offsets and a bounded active set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-offset-check-'))
  try {
    const { manifest } = await createFixture(root, 96, 8)
    const results = []
    for (const variant of ['full-text-prefix-count', 'full-text-linear-count', 'stream-yield']) {
      const result = await recoverFixture(root, variant)
      assert(result.complete)
      assert.equal(stateDigest(result.state), manifest.expectedDigest)
      assert.equal(result.observations.validationBytes, manifest.bytes)
      assert(result.state.records.size <= 8)
      assert(result.state.deleted.size <= 8)
      results.push(result)
    }
    assert(results[0].observations.offsetCountBytes > results[1].observations.offsetCountBytes * 20)
    assert.equal(results[1].observations.offsetCountBytes, manifest.bytes)
    assert.equal(results[2].observations.offsetCountBytes, manifest.bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('known binding deletion blocks stale after-images and is idempotent', () => {
  const record = { key: 'slot-1', binding: 'binding-1', revision: 1, text: 'generated' }
  const state = { records: new Map([[record.key, record]]), deleted: new Map() }
  const deletion = {
    key: record.key,
    expected: digest(JSON.stringify(record)),
    after: null,
    deletedBinding: record.binding
  }
  applyChange(state, deletion)
  applyChange(state, deletion)
  applyChange(state, { key: record.key, expected: null, after: record })
  assert.equal(state.records.size, 0)
  assert.equal(state.deleted.get(record.key), record.binding)
  const replacement = { ...record, binding: 'binding-2', revision: 2 }
  applyChange(state, { key: record.key, expected: null, after: replacement })
  applyChange(state, deletion)
  assert.deepEqual(state.records.get(record.key), replacement)
})

test('bad tail and conflicting mutation identity preserve recovered snapshot state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-tail-check-'))
  try {
    const { manifest } = await createFixture(root, 96, 8)
    const valid = {
      entryKind: 'mutation',
      id: 'change-0',
      key: 'different-slot',
      expected: null,
      after: { key: 'different-slot', binding: 'different', revision: 1, text: 'generated' }
    }
    await appendFile(
      join(root, 'journal.log'),
      encodeFrame(valid) + encodeFrame(valid).slice(0, 25),
      'utf8'
    )
    for (const variant of ['full-text-linear-count', 'stream-yield']) {
      const recovered = await recoverFixture(root, variant)
      assert.equal(recovered.complete, false)
      assert.equal(stateDigest(recovered.state), manifest.expectedDigest)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('growth checkpoint and old journal keep a newly acknowledged deletion after forced termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-delete-crash-check-'))
  try {
    const fixture = join(root, 'fixture')
    await createFixture(fixture, 96, 8)
    const checks = await correctnessChecks(root, fixture)
    assert(checks.deleteAfterCheckpointSurvivesForcedTermination)
    assert(checks.duplicateDeletionIsIdempotent)
    assert(checks.conflictingIdIsIncomplete)
    assert(checks.termination.forcedTermination)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('missing final LF and CRLF stay damaged with identical byte counts and recovered state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-delimiter-check-'))
  try {
    await createFixture(root, 48, 8)
    const path = join(root, 'journal.log')
    const original = await readFile(path)
    for (const raw of [
      original.subarray(0, original.length - 1),
      Buffer.from(original.toString('utf8').replaceAll('\n', '\r\n'))
    ]) {
      await writeFile(path, raw)
      const baseline = await recoverFixture(root, 'full-text-prefix-count')
      assert.equal(baseline.complete, false)
      assert(baseline.observations.invalidFrames > 0)
      for (const variant of ['full-text-linear-count', 'stream-yield']) {
        const result = await recoverFixture(root, variant, { streamChunkBytes: 17 })
        assert.equal(result.complete, false)
        assert.equal(result.observations.invalidFrames, baseline.observations.invalidFrames)
        assert.equal(result.checkpointMatched, baseline.checkpointMatched)
        assert.equal(result.observations.validationBytes, raw.length)
        assert.equal(stateDigest(result.state), stateDigest(baseline.state))
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('UTF-8 characters and frame delimiters split between raw chunks preserve checkpoint and state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-utf8-chunk-check-'))
  try {
    const { manifest } = await createFixture(root, 48, 8)
    const raw = await readFile(join(root, 'journal.log'))
    const firstUnicodeByte = raw.indexOf(Buffer.from('样'))
    assert(firstUnicodeByte > 0)
    const baseline = await recoverFixture(root, 'full-text-linear-count')
    for (const streamChunkBytes of [firstUnicodeByte + 1, 17]) {
      const result = await recoverFixture(root, 'stream-yield', { streamChunkBytes })
      assert(result.complete)
      assert(result.checkpointMatched)
      assert.equal(result.observations.validationBytes, raw.length)
      assert.equal(result.observations.replayedFrames, baseline.observations.replayedFrames)
      assert.equal(result.observations.visitedFrames, baseline.observations.visitedFrames)
      assert.equal(stateDigest(result.state), manifest.expectedDigest)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
