import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { PROFILES, compressionArgs, geometry, parseProbe } from './video.mjs'
import { runProcess, waitForExit } from './video-child.mjs'
import { createMemorySampler } from './video-memory.mjs'

const SOURCE = { duration: 3, width: 1280, height: 720, sar: 1, rotation: 0, hasAudio: true }

test('reference geometry respects rotation, SAR, crop and pixel minimum', () => {
  assert.deepEqual(geometry(SOURCE), {
    scaleWidth: 1280,
    scaleHeight: 720,
    width: 1280,
    height: 720
  })
  assert.deepEqual(geometry({ ...SOURCE, rotation: -90 }), {
    scaleWidth: 720,
    scaleHeight: 1280,
    width: 720,
    height: 1280
  })
  assert.deepEqual(
    geometry(
      { ...SOURCE, width: 320, height: 240, sar: 4 / 3 },
      { x: 0.5, y: 0, width: 0.5, height: 1 }
    ),
    { scaleWidth: 601, scaleHeight: 677, width: 602, height: 678 }
  )
})

test('compression floors fractional selection and keeps the audio/timescale contract', () => {
  const args = compressionArgs('in.mp4', 'out.mp4', SOURCE, {
    range: { startSeconds: 0.1, endSeconds: 2.275 }
  })
  assert.equal(Number(args[args.indexOf('-t') + 1]), 52 / 24)
  assert.equal(args[args.indexOf('-threads') + 1], '2')
  assert.equal(args[args.indexOf('-movie_timescale') + 1], '24000')
  assert.equal(args[args.indexOf('-ar') + 1], '48000')
  assert.equal(args[args.indexOf('-maxrate') + 1], '4000k')
  assert.equal(args[args.indexOf('-map_metadata') + 1], '-1')
  const silent = compressionArgs('in.mp4', 'out.mp4', SOURCE, { removeAudio: true }, 4)
  assert(silent.includes('-an'))
  assert(!silent.includes('-c:a'))
  assert.throws(() =>
    compressionArgs('in.mp4', 'out.mp4', SOURCE, { range: { startSeconds: 0, endSeconds: 4 } })
  )
})

test('probe extracts structured rotation/audio and rejects missing or invalid video', () => {
  const probe = {
    format: { duration: '3', format_name: 'mov,mp4' },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'hevc',
        pix_fmt: 'yuv420p',
        width: 1280,
        height: 720,
        sample_aspect_ratio: '1:1',
        r_frame_rate: '30000/1001',
        side_data_list: [{ rotation: -90 }]
      },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000' }
    ]
  }
  assert.equal(parseProbe(JSON.stringify(probe)).rotation, -90)
  assert.equal(parseProbe(JSON.stringify(probe)).fps, 30000 / 1001)
  assert.equal(parseProbe(JSON.stringify(probe)).audioSampleRate, 48000)
  assert.throws(() => parseProbe(JSON.stringify({ ...probe, streams: [] })))
  assert.throws(() => parseProbe(JSON.stringify({ ...probe, format: { duration: 'nan' } })))
})

test('profiles cover ten timed operations per sample and four one-time observations', () => {
  assert.equal(PROFILES.filter((profile) => profile.samples === undefined).length, 10)
  assert.equal(PROFILES.filter((profile) => profile.samples === 1).length, 4)
  assert.equal(
    new Set(PROFILES.map((profile) => profile.scenario + '/' + profile.variant)).size,
    14
  )
})

test('bounded direct timeout waits for actual child exit', { timeout: 7000 }, async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 200
  })
  assert.equal(result.reason, 'timeout')
  assert(await waitForExit(result.pid))
  await assert.rejects(() => runProcess(process.execPath, [], { timeoutMs: 300_000 }))
})

test(
  'async child registration finishes before returning a closed child',
  { timeout: 7000 },
  async () => {
    let registered = false
    const result = await runProcess(process.execPath, ['-e', ''], {
      timeoutMs: 1000,
      onSpawn: async () => {
        await delay(60)
        registered = true
      }
    })
    assert.equal(result.code, 0)
    assert(registered)
  }
)

test(
  'registration failure kills the owned detached child and rejects',
  { timeout: 7000 },
  async () => {
    let pid
    await assert.rejects(
      () =>
        runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          timeoutMs: 3000,
          detached: true,
          onSpawn: async (childPid) => {
            pid = childPid
            throw new Error('Synthetic registry write failure')
          }
        }),
      /Synthetic registry write failure/
    )
    assert(await waitForExit(pid))
  }
)

test(
  'native memory observer reports positive live RSS and finishes all watches',
  { timeout: 8000 },
  async () => {
    const sampler = await createMemorySampler()
    try {
      const row = await sampler.begin()
      await row.onSpawn(process.pid)
      await delay(150)
      row.onClose(process.pid)
      const observation = await row.finish()
      assert.equal(observation.children.length, 1)
      assert.equal(observation.missingChildren, 0)
      assert(observation.children[0].samples >= 1)
      assert(observation.children[0].observedPeakRssBytes > 0)
      assert(observation.observedConcurrentPeakRssBytes > 0)
      await sampler.close()
    } catch (error) {
      await sampler.abort()
      throw error
    }
  }
)

test(
  'native memory observer reports an exited child as missing, never zero',
  { timeout: 8000 },
  async () => {
    const child = await runProcess(process.execPath, ['-e', ''], { timeoutMs: 1000 })
    assert.equal(child.code, 0)
    const sampler = await createMemorySampler()
    try {
      const row = await sampler.begin()
      await row.onSpawn(child.pid)
      row.onClose(child.pid)
      const observation = await row.finish()
      assert.equal(observation.missingChildren, 1)
      assert.equal(observation.children[0].samples, 0)
      assert.equal(observation.children[0].observedPeakRssBytes, null)
      assert.equal(observation.observedConcurrentPeakRssBytes, null)
      await sampler.close()
    } catch (error) {
      await sampler.abort()
      throw error
    }
  }
)
