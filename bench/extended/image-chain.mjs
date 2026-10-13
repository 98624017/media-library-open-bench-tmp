import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import sharp from 'sharp'
import { readPsd, writePsdBuffer } from 'ag-psd'
import { measure, pool } from '../platform/metrics.mjs'
import {
  IMAGE_SCENARIOS,
  describePsd,
  imageOutputPath,
  inspectPsdAlphaRoundtrip,
  isolateMemory,
  runImageJob
} from './image-worker.mjs'

const VARIANTS = ['serial', 'bounded-2', 'worker-per-item']
const WORKER_TIMEOUT_MS = 40_000
const CORNER_COLORS = [
  [220, 30, 40],
  [40, 200, 80],
  [25, 70, 220],
  [230, 210, 40]
]
const ORIENTATION_CORNERS = [
  [0, 1, 2, 3],
  [1, 0, 3, 2],
  [3, 2, 1, 0],
  [2, 3, 0, 1],
  [0, 2, 1, 3],
  [2, 0, 3, 1],
  [3, 1, 2, 0],
  [1, 3, 0, 2]
]
const PATCH_COLOR = [240, 70, 170, 255]
const MODEL_COLOR = [15, 180, 120, 128]
const require = createRequire(import.meta.url)

export const PROFILES = IMAGE_SCENARIOS.flatMap((scenario) =>
  VARIANTS.map((variant) => ({ scenario, variant }))
)

const hash = (data) => createHash('sha256').update(data).digest('hex')
const pixel = (image, x, y) => [
  ...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)
]
const closeColor = (actual, expected, tolerance = 2) =>
  assert(
    expected.every((channel, index) => Math.abs(actual[index] - channel) <= tolerance),
    `Pixel color mismatch: ${actual} vs ${expected}`
  )
const readRgba = async (input) => {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

function raster(width, height, alpha = false) {
  const raw = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = CORNER_COLORS[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)]
      const offset = (y * width + x) * 4
      const noise = ((x * 3 + y * 5) % 9) - 4
      for (let channel = 0; channel < 3; channel++) raw[offset + channel] = color[channel] + noise
      raw[offset + 3] = alpha ? (x < width / 8 ? 0 : x < width / 4 ? 128 : 255) : 255
    }
  }
  return raw
}

function psdPixelDigest(document) {
  const pixels = []
  const visit = (layers) => {
    for (const layer of layers ?? []) {
      if (layer.imageData)
        pixels.push([
          layer.name,
          layer.imageData.width,
          layer.imageData.height,
          hash(layer.imageData.data)
        ])
      visit(layer.children)
    }
  }
  visit(document.children)
  return hash(JSON.stringify({ composite: hash(document.imageData.data), pixels }))
}

async function makeFixtures(root, quick) {
  const width = quick ? 512 : 1536
  const height = quick ? 384 : 1024
  const raw = raster(width, height)
  const jobs = Object.fromEntries(IMAGE_SCENARIOS.map((scenario) => [scenario, []]))
  for (let orientation = 1; orientation <= 8; orientation++) {
    const sourcePath = join(root, `orientation-${orientation}.jpg`)
    await sharp(raw, { raw: { width, height, channels: 4 } })
      .jpeg({ quality: 98, chromaSubsampling: '4:4:4' })
      .withMetadata({ orientation })
      .toFile(sourcePath)
    const metadata = await sharp(sourcePath).metadata()
    assert.equal(metadata.orientation, orientation)
    const orientedWidth = orientation >= 5 ? height : width
    const orientedHeight = orientation >= 5 ? width : height
    const crop = {
      left: Math.floor(orientedWidth / 8),
      top: Math.floor(orientedHeight / 8),
      width: Math.floor((orientedWidth * 3) / 4),
      height: Math.floor((orientedHeight * 3) / 4)
    }
    jobs['exif-crop-export'].push({
      id: `exif-${orientation}`,
      sourcePath,
      orientation,
      width,
      height,
      crop
    })
  }
  const alphaPath = join(root, 'alpha-source.png')
  await sharp(raster(width, height, true), { raw: { width, height, channels: 4 } })
    .png()
    .toFile(alphaPath)
  const crop = {
    left: 0,
    top: Math.floor(height / 8),
    width: Math.floor((width * 3) / 4),
    height: Math.floor((height * 3) / 4)
  }
  const count = quick ? 2 : 4
  for (let index = 0; index < count; index++) {
    jobs['editor-alpha-rotation'].push({
      id: `editor-${index}`,
      sourcePath: alphaPath,
      width,
      height,
      crop,
      angle: index % 2 === 0 ? 90 : 37,
      fontSize: Math.floor(crop.height / 10),
      eraser: {
        left: Math.floor(crop.width / 3),
        top: Math.floor(crop.height / 3),
        width: Math.floor(crop.width / 3),
        height: Math.floor(crop.height / 3)
      }
    })
  }
  const patchPath = join(root, 'generated-patch.png')
  await sharp({
    create: {
      width: quick ? 192 : 768,
      height: quick ? 128 : 512,
      channels: 4,
      background: { r: PATCH_COLOR[0], g: PATCH_COLOR[1], b: PATCH_COLOR[2], alpha: 1 }
    }
  })
    .png()
    .toFile(patchPath)
  const size = Math.floor(height / 2)
  const inset = Math.max(2, Math.floor(size / 24))
  const feather = Math.max(4, Math.floor(size / 12))
  for (let index = 0; index < count; index++) {
    const edge = index % 2 === 1
    jobs['local-crop-feather'].push({
      id: `patch-${index}`,
      sourcePath: alphaPath,
      generatedPath: patchPath,
      width,
      height,
      size,
      left: edge ? 0 : Math.floor(width / 3),
      top: edge ? 0 : Math.floor(height / 4),
      feather,
      hardSides: edge ? ['left', 'top'] : [],
      maskBox: {
        left: edge ? 0 : inset,
        top: edge ? 0 : inset,
        right: size - inset,
        bottom: size - inset
      }
    })
  }
  const workWidth = quick ? 400 : 1280
  const workHeight = quick ? 600 : 1920
  const workPath = join(root, 'protected-work.png')
  await sharp(raster(workWidth, workHeight, true), {
    raw: { width: workWidth, height: workHeight, channels: 4 }
  })
    .png()
    .toFile(workPath)
  const scaledWidth = Math.floor(workWidth / 2)
  const scaledHeight = Math.floor(workHeight / 2)
  const content = await sharp({
    create: {
      width: scaledWidth,
      height: scaledHeight,
      channels: 4,
      background: {
        r: MODEL_COLOR[0],
        g: MODEL_COLOR[1],
        b: MODEL_COLOR[2],
        alpha: MODEL_COLOR[3] / 255
      }
    }
  })
    .png()
    .toBuffer()
  const modelPath = join(root, 'provider-right-padding.png')
  await sharp(content)
    .extend({
      right: Math.floor(scaledWidth / 10),
      left: 0,
      top: 0,
      bottom: 0,
      background: '#ffffff'
    })
    .png()
    .toFile(modelPath)
  for (let index = 0; index < 2; index++) {
    jobs['text-mask-restore-blend'].push({
      id: `protected-${index}`,
      sourcePath: workPath,
      generatedPath: modelPath,
      width: workWidth,
      height: workHeight,
      scaledWidth,
      scaledHeight,
      feather: quick ? 8 : 24,
      maskBox: {
        left: Math.floor(workWidth / 3),
        top: Math.floor(workHeight / 3),
        right: Math.floor((workWidth * 2) / 3),
        bottom: Math.floor((workHeight * 2) / 3)
      }
    })
  }
  const psdWidth = quick ? 256 : 640
  const psdHeight = quick ? 192 : 480
  const layers = Array.from({ length: quick ? 2 : 6 }, (_, index) => ({
    name: `Raster ${index + 1}`,
    left: ((index % 2) * psdWidth) / 2,
    top: ((index % 2) * psdHeight) / 2,
    imageData: {
      width: psdWidth / 2,
      height: psdHeight / 2,
      data: new Uint8ClampedArray(raster(psdWidth / 2, psdHeight / 2, true))
    }
  }))
  const midpoint = layers.length / 2
  const document = {
    width: psdWidth,
    height: psdHeight,
    imageData: {
      width: psdWidth,
      height: psdHeight,
      data: new Uint8ClampedArray(raster(psdWidth, psdHeight))
    },
    children: [
      { name: 'Group A', children: layers.slice(0, midpoint) },
      { name: 'Group B', children: layers.slice(midpoint) }
    ]
  }
  const psdPath = join(root, 'generated-layers.psd')
  await writeFile(
    psdPath,
    writePsdBuffer(document, { noBackground: true, trimImageData: false, generateThumbnail: false })
  )
  const expectedPsd = { ...describePsd(document), pixelDigest: psdPixelDigest(document) }
  for (const scenario of ['psd-metadata-read', 'psd-raster-roundtrip']) {
    for (let index = 0; index < (quick ? 1 : 2); index++)
      jobs[scenario].push({ id: `psd-${index}`, sourcePath: psdPath, expectedPsd })
  }
  for (const [scenario, scenarioJobs] of Object.entries(jobs))
    for (const job of scenarioJobs) job.scenario = scenario
  const sources = [
    ...new Set(
      Object.values(jobs)
        .flat()
        .flatMap((job) => [job.sourcePath, job.generatedPath].filter(Boolean))
    )
  ]
  return {
    jobs,
    inputHashes: await Promise.all(
      sources.map(async (path) => ({ path, digest: hash(await readFile(path)) }))
    )
  }
}

async function validateExif(job) {
  const output = await readRgba(imageOutputPath(job, 'jpg'))
  assert.equal(output.width, job.crop.width)
  assert.equal(output.height, job.crop.height)
  assert.equal((await sharp(imageOutputPath(job, 'jpg')).metadata()).orientation, undefined)
  const points = [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.2, 0.8],
    [0.8, 0.8]
  ]
  for (let index = 0; index < points.length; index++)
    closeColor(
      pixel(
        output,
        Math.floor(output.width * points[index][0]),
        Math.floor(output.height * points[index][1])
      ),
      CORNER_COLORS[ORIENTATION_CORNERS[job.orientation - 1][index]],
      14
    )
  return {
    digest: hash(output.data),
    checks: ['oriented-dimensions', 'all-eight-exif-layouts', 'exif-removed']
  }
}

async function validateEditor(job) {
  const output = await readRgba(imageOutputPath(job, 'png'))
  if (job.angle === 90) {
    assert.equal(output.width, job.crop.height)
    assert.equal(output.height, job.crop.width)
    const restored = await readRgba(
      await sharp(imageOutputPath(job, 'png')).rotate(270).png().toBuffer()
    )
    closeColor(
      pixel(restored, Math.floor(job.crop.width / 3), Math.floor((job.crop.height * 3) / 16)),
      [239, 20, 40, 255]
    )
    assert.equal(
      pixel(restored, Math.floor(job.crop.width / 20), Math.floor(job.crop.height / 2))[3],
      0
    )
    assert.equal(
      pixel(restored, job.eraser.left + 2, job.eraser.top + Math.floor(job.eraser.height * 0.8))[3],
      0
    )
  } else {
    const radians = (job.angle * Math.PI) / 180
    assert(
      Math.abs(
        output.width - (job.crop.width * Math.cos(radians) + job.crop.height * Math.sin(radians))
      ) <= 2
    )
    assert(
      Math.abs(
        output.height - (job.crop.width * Math.sin(radians) + job.crop.height * Math.cos(radians))
      ) <= 2
    )
    assert.equal(pixel(output, 0, 0)[3], 0)
    for (const [background, expected] of [
      ['white', [255, 255, 255]],
      ['black', [0, 0, 0]]
    ])
      closeColor(
        pixel(await readRgba(imageOutputPath(job, `${background}.jpg`)), 0, 0),
        expected,
        8
      )
  }
  let textPixels = 0
  for (let offset = 0; offset < output.data.length; offset += 4)
    if (
      output.data[offset] > 180 &&
      output.data[offset + 1] < 60 &&
      output.data[offset + 2] > 150 &&
      output.data[offset + 3] > 150
    )
      textPixels++
  assert(textPixels > job.fontSize, 'Text must remain visible after erasing and rotation')
  return {
    digest: hash(output.data),
    checks: [
      'editor-layer-order',
      'alpha-preserved',
      'text-after-eraser',
      'whole-image-rotation',
      'transparent-expansion',
      'selected-jpeg-background'
    ]
  }
}

async function validatePatch(job) {
  const [source, output] = await Promise.all([
    readRgba(job.sourcePath),
    readRgba(imageOutputPath(job, 'png'))
  ])
  assert.equal(output.width, job.width)
  assert.equal(output.height, job.height)
  closeColor(
    pixel(output, job.left + Math.floor(job.size / 2), job.top + Math.floor(job.size / 2)),
    PATCH_COLOR
  )
  closeColor(
    pixel(output, job.width - 2, job.height - 2),
    pixel(source, job.width - 2, job.height - 2)
  )
  if (job.hardSides.length > 0) closeColor(pixel(output, 0, 0), PATCH_COLOR)
  else {
    const x = job.left + job.maskBox.left + Math.floor(job.feather / 2)
    const y = job.top + Math.floor(job.size / 2)
    const before = pixel(source, x, y)
    const after = pixel(output, x, y)
    assert(after.slice(0, 3).some((channel, index) => Math.abs(channel - before[index]) > 3))
    assert(after.slice(0, 3).some((channel, index) => Math.abs(channel - PATCH_COLOR[index]) > 3))
  }
  return {
    digest: hash(output.data),
    checks: [
      'patch-dimensions',
      'lanczos-square-patch',
      'outside-source-preserved',
      'smooth-feather',
      'image-boundary-hard-edge'
    ]
  }
}

async function validateProtected(job) {
  const [source, output, aligned] = await Promise.all([
    readRgba(job.sourcePath),
    readRgba(imageOutputPath(job, 'png')),
    readRgba(imageOutputPath(job, 'aligned.png'))
  ])
  assert.equal(output.width, job.width)
  assert.equal(output.height, job.height)
  assert.equal(aligned.width, job.width)
  assert.equal(aligned.height, job.height)
  closeColor(pixel(aligned, job.width - 1, job.height - 1), MODEL_COLOR)
  for (let offset = 3; offset < output.data.length; offset += 4)
    assert.equal(
      output.data[offset],
      source.data[offset],
      'Protected composite must retain every original alpha byte'
    )
  closeColor(
    pixel(output, Math.floor(job.width / 4), Math.floor(job.height / 4)),
    pixel(source, Math.floor(job.width / 4), Math.floor(job.height / 4))
  )
  const center = [Math.floor(job.width / 2), Math.floor(job.height / 2)]
  const originalPixel = pixel(source, ...center)
  closeColor(
    pixel(output, ...center),
    originalPixel.map((channel, index) =>
      index === 3
        ? channel
        : Math.round(
            channel * (1 - MODEL_COLOR[3] / 255) + (MODEL_COLOR[index] * MODEL_COLOR[3]) / 255
          )
    )
  )
  const x = job.maskBox.left + Math.floor(job.feather / 2)
  const y = Math.floor(job.height / 2)
  const before = pixel(source, x, y)
  const after = pixel(output, x, y)
  assert(after.slice(0, 3).some((channel, index) => Math.abs(channel - before[index]) > 2))
  assert(after.slice(0, 3).some((channel, index) => Math.abs(channel - MODEL_COLOR[index]) > 2))
  return {
    digest: hash(output.data),
    checks: [
      'trailing-padding-removed',
      'restored-original-dimensions',
      'original-alpha-byte-preserved',
      'protected-region-preserved',
      'generated-alpha-strength',
      'feathered-blend'
    ]
  }
}

async function validatePsd(job, value) {
  assert.deepEqual(value.result, {
    width: job.expectedPsd.width,
    height: job.expectedPsd.height,
    names: job.expectedPsd.names
  })
  if (job.scenario === 'psd-metadata-read')
    return {
      digest: hash(JSON.stringify(value.result)),
      checks: ['metadata-dimensions', 'nested-layer-names']
    }
  const buffer = await readFile(imageOutputPath(job, 'psd'))
  assert.equal(buffer.subarray(0, 4).toString('ascii'), '8BPS')
  const document = readPsd(buffer, { useImageData: true, skipThumbnail: true })
  assert.equal(psdPixelDigest(document), job.expectedPsd.pixelDigest)
  assert.deepEqual(describePsd(document), value.result)
  return {
    digest: job.expectedPsd.pixelDigest,
    checks: [
      'psd-signature',
      'nested-layer-metadata',
      'lossless-layer-pixels',
      'supplied-composite-preserved'
    ]
  }
}

async function validateJob(job, value) {
  if (job.scenario === 'exif-crop-export') return validateExif(job)
  if (job.scenario === 'editor-alpha-rotation') return validateEditor(job)
  if (job.scenario === 'local-crop-feather') return validatePatch(job)
  if (job.scenario === 'text-mask-restore-blend') return validateProtected(job)
  return validatePsd(job, value)
}

function inWorker(job) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./image-worker.mjs', import.meta.url), {
      workerData: job,
      execArgv: []
    })
    let response
    let failure
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      void worker.terminate().catch((error) => {
        failure = error
      })
    }, WORKER_TIMEOUT_MS)
    worker.on('message', (message) => {
      if (response) failure = new Error('Duplicate synthetic worker response')
      response = message
    })
    worker.once('error', (error) => {
      failure = error
    })
    worker.once('exit', (code) => {
      clearTimeout(timeout)
      if (failure || timedOut || code !== 0 || response?.ok !== true)
        reject(
          new Error(timedOut ? 'Synthetic image worker timed out' : 'Synthetic image worker failed')
        )
      else resolve(response)
    })
  })
}

async function runVariant(jobs, variant, observe) {
  const values = new Array(jobs.length)
  const failures = []
  await pool(jobs, variant === 'bounded-2' ? 2 : 1, async (job, index) => {
    try {
      values[index] =
        variant === 'worker-per-item'
          ? await inWorker(job)
          : { value: await runImageJob(job, observe) }
    } catch (error) {
      failures.push(error)
    }
    observe()
  })
  if (failures.length > 0) throw new AggregateError(failures, 'Synthetic image profile failed')
  return values
}

function workload(jobs) {
  const first = jobs[0]
  return {
    jobs: jobs.length,
    exifOrientations: first.scenario === 'exif-crop-export' ? 8 : 0,
    sourceDimensions: first.expectedPsd
      ? [first.expectedPsd.width, first.expectedPsd.height]
      : first.width
        ? [first.width, first.height]
        : null,
    croppedCanvasDimensions: first.crop ? [first.crop.width, first.crop.height] : null,
    userRotationAngles:
      first.scenario === 'editor-alpha-rotation' ? [...new Set(jobs.map((job) => job.angle))] : [],
    psdNamedNodes: first.expectedPsd?.names.length ?? 0,
    psdPixelContract: first.expectedPsd
      ? 'opaque supplied composite; zero/partial/full alpha in every raster layer'
      : null,
    includes: 'decode, transform, encode; output writes except metadata-only read',
    excludes: 'fixture creation, validation, output cleanup',
    workerLifecycle: 'worker-per-item includes fresh thread startup, imports, messaging and exit'
  }
}

export async function runBench({ base, quick = false, sampleCount = 3, emit }) {
  assert(typeof base === 'string' && typeof emit === 'function')
  assert(Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 5)
  const root = await mkdtemp(join(base, 'image-chain-'))
  let rows = 0
  let psdAlphaObservations
  const expectedDigests = new Map()
  try {
    psdAlphaObservations = await inspectPsdAlphaRoundtrip()
    const fixtures = await makeFixtures(root, quick)
    for (let sample = 0; sample < sampleCount; sample++) {
      const order = [
        ...VARIANTS.slice(sample % VARIANTS.length),
        ...VARIANTS.slice(0, sample % VARIANTS.length)
      ]
      for (const scenario of IMAGE_SCENARIOS) {
        for (const variant of order) {
          const outputDir = await mkdtemp(join(root, 'outputs-'))
          const jobs = fixtures.jobs[scenario].map((job) => ({ ...job, outputDir }))
          const start = isolateMemory()
          const peak = { ...start }
          const observe = () => {
            const current = isolateMemory()
            for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], current[key])
          }
          const timer = setInterval(observe, 5)
          let measured
          try {
            measured = await measure(() => runVariant(jobs, variant, observe))
          } finally {
            clearInterval(timer)
          }
          const end = isolateMemory()
          const validated = await Promise.all(
            jobs.map((job, index) => validateJob(job, measured.value[index].value))
          )
          const outputDigest = hash(validated.map((value) => value.digest).join(':'))
          if (expectedDigests.has(scenario))
            assert.equal(
              outputDigest,
              expectedDigests.get(scenario),
              'Variants and samples must produce equivalent pixels and metadata'
            )
          else expectedDigests.set(scenario, outputDigest)
          await emit({
            suite: 'image-chain',
            scenario,
            variant,
            sample,
            workload: workload(jobs),
            metrics: measured.metrics,
            checks: { outputsValidated: true, equivalentOutput: true },
            outputDigest,
            validatedChecks: [...new Set(validated.flatMap((value) => value.checks))],
            memory: {
              processRssScope:
                'entire process including all Worker threads and native Sharp allocations',
              mainIsolate: { start, end, observedPeak: peak },
              workers: measured.value.flatMap((value) =>
                value.isolateMemory ? [{ id: value.value.id, ...value.isolateMemory }] : []
              ),
              caveat:
                'Isolate snapshots exclude native libvips memory; sampled peaks can miss short allocations. CPU is process-wide; lifetime RSS includes earlier profiles and validation.'
            }
          })
          rows++
          await rm(outputDir, { recursive: true, force: true })
        }
      }
    }
    for (const source of fixtures.inputHashes)
      assert.equal(
        hash(await readFile(source.path)),
        source.digest,
        'Synthetic inputs must remain unchanged'
      )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  return {
    rows,
    profiles: PROFILES.length,
    runtime: {
      sharp: sharp.versions.sharp,
      agPsd: require('ag-psd/package.json').version,
      cachePolicy: process.platform === 'win32' ? 'disabled' : 'default'
    },
    checks: {
      allTimedPixelAndMetadataControlsPassed: true,
      variantAndSampleDigestsEqual: true,
      inputFilesUnchanged: true,
      ownedTemporaryRootRemoved: true
    },
    observations: { psdAlpha: psdAlphaObservations },
    calibration:
      'Synthetic operational shapes, not imported product source. Serial batch export and fresh per-item text-composite Worker reflect inspected owners; bounded-2 and raster PSD rewrites are experiments.',
    limitations: [
      'Sharp 0.34.5 only; Linux development 0.33.5 is unchanged and not represented',
      'Generated pattern and default sans-serif only; no real photo/font corpus, Adobe/Photopea or complete product UI certification',
      'PSD V2 normally preserves downloaded bytes; metadata-only readback is product-shaped, full raster roundtrip is a library experiment',
      'Lossless PSD timing uses an opaque supplied composite; independent probes retain observed transparent-composite quantization and very-small RLE alpha behavior',
      'No target-byte quality search, mask polygon unions, installed fonts, paid API, OS cache purge or hardware/display test',
      'Each editor fixture encodes both JPEG backgrounds; digest equivalence is within a platform because available sans-serif glyphs vary'
    ]
  }
}
