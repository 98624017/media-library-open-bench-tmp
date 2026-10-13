import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { devNull } from 'node:os'
import { basename, join } from 'node:path'
import { measure, pool, round } from '../platform/metrics.mjs'
import { runProcess, observeProcessTree, waitForExit } from './video-child.mjs'
import { createMemorySampler } from './video-memory.mjs'

const require = createRequire(import.meta.url)
const POLICY = Object.freeze({
  version: 'reference-mp4-h264-24-v2',
  maxBytes: 20_000_000,
  maxEdge: 1280,
  minHeight: 300,
  minPixels: 407_696,
  maxPixels: 8_295_044,
  fps: 24,
  crf: 23,
  preset: 'fast',
  maxVideoKbps: 4000,
  bufferKbps: 8000,
  audioKbps: 96,
  threads: 2,
  durationToleranceSeconds: 0.15
})
const SOURCES = ['h264-audio', 'hevc-silent', 'h264-rotated-audio']
const THREAD_VARIANTS = ['production-threads-2', 'candidate-threads-4']
const BATCH_VARIANTS = ['production-sequential', 'candidate-concurrency-2']
const QUALITY_FLOOR = 0.88

export const PROFILES = [
  ...SOURCES.flatMap((scenario) => THREAD_VARIANTS.map((variant) => ({ scenario, variant }))),
  { scenario: 'fractional-retained-audio', variant: 'production' },
  { scenario: 'crop-range-remove-audio', variant: 'production' },
  ...BATCH_VARIANTS.map((variant) => ({ scenario: 'two-clip-batch', variant })),
  ...[
    'compression-timeout',
    'parent-kill-counterexample',
    'download-tree-cancel',
    'download-tree-timeout'
  ].map((scenario) => ({ scenario, variant: 'process-observation', samples: 1 }))
]

function ratio(text) {
  const [left, right = '1'] = String(text).split(/[/:]/)
  return Number(left) / Number(right)
}

export function parseProbe(text) {
  const value = JSON.parse(text)
  assert(value && Array.isArray(value.streams) && value.format)
  const video = value.streams.find((stream) => stream.codec_type === 'video')
  const audio = value.streams.find((stream) => stream.codec_type === 'audio')
  assert(video, 'probe returned no video stream')
  const duration = Number(value.format.duration)
  const sar = ratio(
    video.sample_aspect_ratio === 'N/A' ? '1:1' : (video.sample_aspect_ratio ?? '1:1')
  )
  const rotation = Number(
    video.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ??
      video.tags?.rotate ??
      0
  )
  assert(Number.isFinite(duration) && duration > 0)
  assert(Number.isInteger(video.width) && video.width > 0)
  assert(Number.isInteger(video.height) && video.height > 0)
  assert(Number.isFinite(sar) && sar > 0 && Number.isFinite(rotation))
  const fps = ratio(video.r_frame_rate)
  assert(Number.isFinite(fps) && fps > 0)
  return {
    duration,
    width: video.width,
    height: video.height,
    sar,
    rotation,
    fps,
    codec: video.codec_name,
    pixelFormat: video.pix_fmt,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name,
    audioSampleRate: audio ? Number(audio.sample_rate) : null,
    formatName: value.format.format_name
  }
}

export function geometry(source, crop) {
  const rotated = Math.abs(source.rotation % 180) === 90
  const width = rotated ? source.height : source.width
  const height = rotated ? source.width : source.height
  const sar = rotated ? 1 / source.sar : source.sar
  const croppedWidth = crop ? Math.max(1, Math.round(width * crop.width)) : width
  const croppedHeight = crop ? Math.max(1, Math.round(height * crop.height)) : height
  const displayedWidth = croppedWidth * sar
  const factor = Math.min(
    POLICY.maxEdge / Math.max(displayedWidth, croppedHeight),
    Math.max(
      1,
      POLICY.minHeight / croppedHeight,
      Math.sqrt(POLICY.minPixels / (displayedWidth * croppedHeight))
    )
  )
  const scaleWidth = Math.max(1, Math.floor(displayedWidth * factor + 1e-8))
  const scaleHeight = Math.max(1, Math.floor(croppedHeight * factor + 1e-8))
  const output = {
    scaleWidth,
    scaleHeight,
    width: Math.ceil(scaleWidth / 2) * 2,
    height: Math.max(POLICY.minHeight, Math.ceil(scaleHeight / 2) * 2)
  }
  if (output.width * output.height < POLICY.minPixels) {
    if (output.width >= output.height)
      output.height = Math.ceil(POLICY.minPixels / output.width / 2) * 2
    else output.width = Math.ceil(POLICY.minPixels / output.height / 2) * 2
  }
  return output
}

function filters(source, recipe = {}) {
  const shape = geometry(source, recipe.crop)
  const crop = recipe.crop
  return [
    ...(crop
      ? [
          `crop=w='max(1,round(iw*${crop.width}))':h='max(1,round(ih*${crop.height}))':x='min(iw-ow,round(iw*${crop.x}))':y='min(ih-oh,round(ih*${crop.y}))':exact=1`
        ]
      : []),
    `scale=${shape.scaleWidth}:${shape.scaleHeight}`,
    'setsar=1',
    `pad=${shape.width}:${shape.height}`,
    `fps=${POLICY.fps}`
  ].join(',')
}

export function compressionArgs(
  sourcePath,
  targetPath,
  source,
  recipe = {},
  threads = POLICY.threads
) {
  const selectedDuration = recipe.range
    ? recipe.range.endSeconds - recipe.range.startSeconds
    : source.duration
  assert(Number.isFinite(selectedDuration) && selectedDuration >= 0.1)
  if (recipe.range)
    assert(recipe.range.startSeconds >= 0 && recipe.range.endSeconds <= source.duration)
  assert([2, 4].includes(threads))
  const duration = Math.floor(selectedDuration * POLICY.fps + 1e-8) / POLICY.fps
  return [
    '-nostdin',
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...(recipe.range ? ['-ss', String(recipe.range.startSeconds)] : []),
    '-i',
    sourcePath,
    '-t',
    String(duration),
    '-map',
    '0:v:0',
    '-vf',
    filters(source, recipe),
    '-fps_mode',
    'cfr',
    '-c:v',
    'libx264',
    '-preset',
    POLICY.preset,
    '-threads',
    String(threads),
    '-pix_fmt',
    'yuv420p',
    '-map_metadata',
    '-1',
    '-metadata:s:v:0',
    'rotate=0',
    '-crf',
    String(POLICY.crf),
    '-maxrate',
    POLICY.maxVideoKbps + 'k',
    '-bufsize',
    POLICY.bufferKbps + 'k',
    ...(source.hasAudio && !recipe.removeAudio
      ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', POLICY.audioKbps + 'k', '-ar', '48000']
      : ['-an']),
    '-movflags',
    '+faststart',
    '-movie_timescale',
    String(POLICY.fps * 1000),
    targetPath
  ]
}

function executable(name, variable) {
  if (process.env[variable]) return { path: process.env[variable], origin: variable }
  try {
    const installed = require(name)
    return { path: typeof installed === 'string' ? installed : installed.path, origin: name }
  } catch (error) {
    if (name !== '@ffprobe-installer/ffprobe' || error.code !== 'MODULE_NOT_FOUND') throw error
    return { path: 'ffprobe', origin: 'PATH fallback; installer unavailable' }
  }
}

async function successful(executablePath, args, timeoutMs = 60_000, memory) {
  const result = await runProcess(executablePath, args, {
    timeoutMs,
    ...(memory ? { onSpawn: memory.onSpawn, onClose: memory.onClose } : {})
  })
  assert.equal(result.reason, null, `child failed: ${result.reason}`)
  assert.equal(result.code, 0, result.stderr.slice(-1500))
  return result
}

async function probe(path, ffprobe) {
  const result = await successful(
    ffprobe,
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
    15_000
  )
  return parseProbe(result.stdout)
}

async function digest(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function makeFixtures(root, quick, ffmpeg, ffprobe) {
  const duration = quick ? 1.25 : 3.25
  const width = quick ? 854 : 1280
  const height = quick ? 480 : 720
  const fixtures = []
  for (const name of SOURCES.slice(0, 2)) {
    const hasAudio = name === 'h264-audio'
    const path = join(root, name + '.mp4')
    await successful(ffmpeg, [
      '-nostdin',
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${width}x${height}:rate=${hasAudio ? 30 : 25}`,
      ...(hasAudio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []),
      '-t',
      String(duration),
      '-c:v',
      hasAudio ? 'libx264' : 'libx265',
      '-preset',
      'ultrafast',
      ...(hasAudio
        ? ['-crf', '16', '-threads', '2']
        : ['-x265-params', 'pools=1:frame-threads=2:log-level=error', '-crf', '18']),
      '-pix_fmt',
      'yuv420p',
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
      path
    ])
    fixtures.push({ name, path, metadata: await probe(path, ffprobe), sha256: await digest(path) })
  }
  const rotatedPath = join(root, SOURCES[2] + '.mp4')
  await successful(ffmpeg, [
    '-nostdin',
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-display_rotation:v:0',
    '90',
    '-i',
    fixtures[0].path,
    '-c',
    'copy',
    rotatedPath
  ])
  const metadata = await probe(rotatedPath, ffprobe)
  assert.equal(Math.abs(metadata.rotation), 90, 'fixture must contain a real MP4 display matrix')
  fixtures.push({
    name: SOURCES[2],
    path: rotatedPath,
    metadata,
    sha256: await digest(rotatedPath)
  })
  return fixtures
}

async function validateOutput(fixture, output, recipe, tools) {
  const info = await probe(output, tools.ffprobe)
  const shape = geometry(fixture.metadata, recipe.crop)
  const selectedDuration = recipe.range
    ? recipe.range.endSeconds - recipe.range.startSeconds
    : fixture.metadata.duration
  const bytes = (await stat(output)).size
  assert(bytes > 0 && bytes < POLICY.maxBytes)
  assert(info.formatName.split(',').includes('mp4'))
  assert.equal(info.codec, 'h264')
  assert.equal(info.pixelFormat, 'yuv420p')
  assert.equal(info.fps, POLICY.fps)
  assert.equal(info.sar, 1)
  assert.equal(info.rotation, 0)
  assert.equal(info.width, shape.width)
  assert.equal(info.height, shape.height)
  assert.equal(info.hasAudio, fixture.metadata.hasAudio && !recipe.removeAudio)
  if (info.hasAudio) {
    assert.equal(info.audioCodec, 'aac')
    assert.equal(info.audioSampleRate, 48_000)
  }
  assert(info.duration <= selectedDuration + 1e-6)
  assert(selectedDuration - info.duration <= POLICY.durationToleranceSeconds)
  assert(info.width % 2 === 0 && info.height % 2 === 0)
  assert(Math.max(info.width, info.height) <= POLICY.maxEdge && info.height >= POLICY.minHeight)
  assert(
    info.width * info.height >= POLICY.minPixels && info.width * info.height <= POLICY.maxPixels
  )
  const comparison = await successful(tools.ffmpeg, [
    '-nostdin',
    '-hide_banner',
    '-xerror',
    ...(recipe.range ? ['-ss', String(recipe.range.startSeconds)] : []),
    '-i',
    fixture.path,
    '-i',
    output,
    '-t',
    String(info.duration),
    '-filter_complex_threads',
    '1',
    '-filter_complex',
    `[0:v]${filters(fixture.metadata, recipe)},setpts=PTS-STARTPTS[ref];[1:v]setpts=PTS-STARTPTS[out];[ref][out]ssim[checked]`,
    '-map',
    '[checked]',
    '-an',
    '-f',
    'null',
    devNull
  ])
  const ssim = Number(/SSIM[^\r\n]*All:([\d.]+)/.exec(comparison.stderr)?.[1])
  assert(Number.isFinite(ssim) && ssim >= QUALITY_FLOOR, `decode/reference SSIM mismatch: ${ssim}`)
  await successful(tools.ffmpeg, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-xerror',
    '-i',
    output,
    '-map',
    '0',
    '-f',
    'null',
    devNull
  ])
  return { ...info, bytes, ssimAll: round(ssim * 10000) / 10000, sha256: await digest(output) }
}

async function encodeRow({
  root,
  fixture,
  scenario,
  variant,
  sample,
  recipe,
  threads,
  tools,
  emit
}) {
  const target = join(root, `${scenario}-${variant}-${sample}.mp4`)
  const memory = await tools.sampler.begin()
  const measured = await measure(() =>
    successful(
      tools.ffmpeg,
      compressionArgs(fixture.path, target, fixture.metadata, recipe, threads),
      90_000,
      memory
    )
  )
  const nativeChildMemory = await memory.finish()
  const output = await validateOutput(fixture, target, recipe, tools)
  const sourceUnchanged = (await digest(fixture.path)) === fixture.sha256
  assert(sourceUnchanged)
  await emit({
    suite: 'video',
    scenario,
    variant,
    sample,
    workload: {
      input: fixture.name,
      source: fixture.metadata,
      sourceBytes: (await stat(fixture.path)).size,
      recipe,
      threads,
      jobs: 1,
      policyVersion: POLICY.version
    },
    metrics: measured.metrics,
    nativeChildMemory,
    checks: {
      encodingExited: true,
      outputContract: true,
      decoded: true,
      visualReferenceMatches: true,
      sourceUnchanged
    },
    output
  })
  await rm(target)
}

export function validateProcessObservation(observation, { tree, timeout = false }) {
  assert(observation.checks.fixtureReady)
  assert(observation.checks.parentStopped)
  assert(observation.checks.ownedCleanupComplete)
  assert.equal(typeof observation.descendantSurvived, 'boolean')
  assert.equal(observation.reason, timeout ? 'timeout' : 'cancelled')
  if (tree) assert(observation.checks.descendantStopped)
}

async function processObservations(ffmpeg, emit) {
  const timedOut = await runProcess(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-re',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=24',
      '-t',
      '30',
      '-f',
      'null',
      devNull
    ],
    { timeoutMs: 600 }
  )
  const compressionStopped = timedOut.pid ? await waitForExit(timedOut.pid) : false
  await emit({
    suite: 'video',
    scenario: 'compression-timeout',
    variant: 'process-observation',
    sample: 0,
    workload: { child: 'standalone FFmpeg', timeoutMs: 600 },
    metrics: null,
    checks: { timedOut: timedOut.reason === 'timeout', childStopped: compressionStopped },
    observation: { reason: timedOut.reason, terminationMs: timedOut.wallMs }
  })
  assert.equal(timedOut.reason, 'timeout')
  assert(compressionStopped)
  for (const [scenario, tree, timeout] of [
    ['parent-kill-counterexample', false, false],
    ['download-tree-cancel', true, false],
    ['download-tree-timeout', true, true]
  ]) {
    const observation = await observeProcessTree({ tree, timeout })
    await emit({
      suite: 'video',
      scenario,
      variant: 'process-observation',
      sample: 0,
      workload: { child: 'synthetic Node parent + descendant', tree, timeout },
      metrics: null,
      checks: observation.checks,
      observation: { ...observation, checks: undefined }
    })
    validateProcessObservation(observation, { tree, timeout })
  }
}

export async function runBench({ base, quick = false, sampleCount = 3, emit }) {
  assert(Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 5)
  assert(typeof emit === 'function')
  const ffmpeg = executable('ffmpeg-static', 'FFMPEG_PATH')
  const ffprobe = executable('@ffprobe-installer/ffprobe', 'FFPROBE_PATH')
  const versions = {}
  for (const [name, tool] of [
    ['ffmpeg', ffmpeg],
    ['ffprobe', ffprobe]
  ]) {
    const version = await successful(tool.path, ['-version'], 15_000)
    versions[name] = {
      origin: tool.origin,
      executable: basename(tool.path),
      version: version.stdout.split('\n')[0].slice(0, 500)
    }
  }
  const root = await mkdtemp(join(base, 'video-owned-'))
  let sampler
  let samplerClosed = false
  try {
    sampler = await createMemorySampler()
    const tools = { ffmpeg: ffmpeg.path, ffprobe: ffprobe.path, sampler }
    const fixtures = await makeFixtures(root, quick, tools.ffmpeg, tools.ffprobe)
    for (let sample = 0; sample < sampleCount; sample++) {
      const variants = sample % 2 ? [...THREAD_VARIANTS].reverse() : THREAD_VARIANTS
      for (const fixture of fixtures) {
        for (const variant of variants)
          await encodeRow({
            root,
            fixture,
            scenario: fixture.name,
            variant,
            sample,
            recipe: {},
            threads: variant.endsWith('-4') ? 4 : 2,
            tools,
            emit
          })
      }
      await encodeRow({
        root,
        fixture: fixtures[0],
        scenario: 'fractional-retained-audio',
        variant: 'production',
        sample,
        recipe: { range: { startSeconds: 0.125, endSeconds: quick ? 1.075 : 2.275 } },
        threads: 2,
        tools,
        emit
      })
      await encodeRow({
        root,
        fixture: fixtures[2],
        scenario: 'crop-range-remove-audio',
        variant: 'production',
        sample,
        recipe: {
          range: { startSeconds: 0.1, endSeconds: quick ? 1.1 : 2.1 },
          crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
          removeAudio: true
        },
        threads: 2,
        tools,
        emit
      })
      const batchVariants = sample % 2 ? [...BATCH_VARIANTS].reverse() : BATCH_VARIANTS
      for (const variant of batchVariants) {
        const batch = fixtures.slice(0, 2)
        const targets = batch.map((fixture) =>
          join(root, `batch-${variant}-${sample}-${fixture.name}.mp4`)
        )
        const concurrency = variant.endsWith('-2') ? 2 : 1
        const memory = await sampler.begin()
        const measured = await measure(() =>
          pool(batch, concurrency, (fixture, index) =>
            successful(
              tools.ffmpeg,
              compressionArgs(fixture.path, targets[index], fixture.metadata),
              90_000,
              memory
            )
          )
        )
        const nativeChildMemory = await memory.finish()
        const outputs = []
        for (let index = 0; index < batch.length; index++) {
          outputs.push(await validateOutput(batch[index], targets[index], {}, tools))
          assert.equal(await digest(batch[index].path), batch[index].sha256)
        }
        await emit({
          suite: 'video',
          scenario: 'two-clip-batch',
          variant,
          sample,
          workload: {
            inputs: batch.map((fixture) => ({ name: fixture.name, source: fixture.metadata })),
            jobs: 2,
            threadsPerJob: 2,
            concurrency,
            policyVersion: POLICY.version
          },
          metrics: measured.metrics,
          nativeChildMemory,
          checks: {
            encodingExited: true,
            outputContract: true,
            decoded: true,
            visualReferenceMatches: true,
            sourceUnchanged: true
          },
          outputs
        })
        for (const target of targets) await rm(target)
      }
    }
    await sampler.close()
    samplerClosed = true
    await processObservations(tools.ffmpeg, emit)
    return {
      profiles: PROFILES.length,
      expectedRows: 10 * sampleCount + 4,
      versions,
      nativeMemoryObserver: sampler.metadata,
      policy: POLICY,
      checks: {
        allGeneratedInputsUnchanged: true,
        outputValidated: true,
        ownedChildrenStopped: true,
        nativeMemorySamplerStopped: true,
        ownedRootCleaned: true
      },
      calibration:
        'Encoding subprocess stage; actual policy geometry/audio/timescale. Setup, probe, SSIM, full decode and cleanup excluded from wall time.',
      limitations: [
        'Generated testsrc2 only; no real footage, hardware encoding or product UI.',
        'CRF first pass only; short fixtures do not trigger the real 20 MB two-pass fallback.',
        'Node metrics exclude FFmpeg CPU/RSS; nativeChildMemory separately samples its RSS. Sampling misses short peaks and adds equal observation overhead to strategies.',
        'Synthetic descendants exercise kill primitives, not the complete downloader/FFmpeg application lifecycle.'
      ]
    }
  } finally {
    try {
      if (sampler && !samplerClosed) await sampler.abort()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}
