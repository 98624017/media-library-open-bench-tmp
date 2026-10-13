import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPersistenceBench } from './persistence.mjs'
import { decodeFrames, encodeFrame } from './persistence-store.mjs'

test('length/hash frames keep acknowledged Unicode records after a damaged tail', () => {
  const original = [
    { id: 1, text: '示例 café' },
    { id: 2, text: '\u001e\u001f' }
  ]
  const good = original.map(encodeFrame).join('')
  assert.deepEqual(decodeFrames(good), { complete: true, records: original })
  const damaged = good + encodeFrame({ id: 3 }).slice(0, -2)
  assert.deepEqual(decodeFrames(damaged), {
    complete: false,
    records: original
  })
  assert.deepEqual(decodeFrames(good.replace('示例', '示意')), {
    complete: false,
    records: [original[1]]
  })
})

test(
  'one-sample persistence smoke validates native durability handoffs and releases fixtures',
  { timeout: 60_000 },
  async () => {
    const base = await mkdtemp(join(tmpdir(), 'synthetic-persistence-test-'))
    try {
      const emitted = []
      const rows = await runPersistenceBench({
        base,
        quick: true,
        sampleCount: 1,
        emit: async (row) => emitted.push(row)
      })
      assert.deepEqual(rows, emitted)
      assert.equal(rows.length, process.platform === 'win32' ? 25 : 24)
      assert.equal(
        rows.filter(({ scenario }) => scenario === 'process-kill-recovery')
          .length,
        4
      )
      for (const row of rows.filter(
        ({ scenario }) => scenario === 'process-kill-recovery'
      )) {
        assert.equal(row.checks.acknowledgedFramesRecovered, true)
      }
      const compaction = rows.find(
        ({ scenario }) => scenario === 'journal-checkpoint-compaction'
      )
      assert.equal(
        compaction.checks.compacted,
        compaction.fixtureMetadata.directorySync.supported
      )
      const afterBackupMove = rows.find(
        ({ variant }) => variant === 'backup-moved'
      )
      assert.equal(afterBackupMove.checks.backupRecovered, true)
      assert.deepEqual(await readdir(base), [])
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  }
)
