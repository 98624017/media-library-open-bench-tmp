import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertMeasurementWorks, median, pool } from './metrics.mjs'

test('captures an operation that blocks before the first heartbeat', async () => {
  const metrics = await assertMeasurementWorks()
  assert(metrics.eventLoopDelayMaxMs >= 35)
})

test('bounded pool waits for every item without exceeding the requested width', async () => {
  let active = 0
  let peak = 0
  const finished = []
  await pool([1, 2, 3, 4, 5], 2, async (item) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 2))
    finished.push(item)
    active--
  })
  assert.equal(peak, 2)
  assert.deepEqual(finished.sort(), [1, 2, 3, 4, 5])
  assert.equal(median([1, 3, 2, 4]), 2.5)
})
