import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import sharp from 'sharp'

if (process.platform === 'win32') sharp.cache(false)
let psdPromise

export async function loadPsd() {
  if (!psdPromise) {
    psdPromise = import('ag-psd').then((module) => {
      // Only PSD work loads this library; raw ImageData avoids a native Canvas dependency.
      module.initializeCanvas(
        () => {
          throw new Error('Synthetic PSD profiles do not use Canvas')
        },
        (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })
      )
      return module
    })
  }
  return psdPromise
}

export const IMAGE_SCENARIOS = [
  'exif-crop-export',
  'editor-alpha-rotation',
  'local-crop-feather',
  'text-mask-restore-blend',
  'psd-metadata-read',
  'psd-raster-roundtrip'
]

export function imageOutputPath(job, extension) {
  return join(job.outputDir, `${job.id}.${extension}`)
}

export function isolateMemory() {
  const { heapUsed, external, arrayBuffers } = process.memoryUsage()
  return { heapUsedBytes: heapUsed, externalBytes: external, arrayBuffersBytes: arrayBuffers }
}

export function makeFeatherMask(width, height, box, feather, hardSides = []) {
  assert(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)
  assert(Number.isFinite(feather) && feather >= 0)
  assert(['left', 'top', 'right', 'bottom'].every((side) => Number.isFinite(box[side])))
  assert(box.right > box.left && box.bottom > box.top)
  const raw = Buffer.alloc(width * height * 4, 255)
  const hardLeft = hardSides.includes('left')
  const hardTop = hardSides.includes('top')
  const hardRight = hardSides.includes('right')
  const hardBottom = hardSides.includes('bottom')
  const strength = (distance) => {
    if (feather === 0) return distance >= 0 ? 1 : 0
    const position = Math.max(0, Math.min(1, distance / feather))
    return position ** 2 * (3 - 2 * position)
  }
  for (let y = 0; y < height; y++) {
    const top = hardTop ? 1 : strength(y - box.top)
    const bottom = hardBottom ? 1 : strength(box.bottom - y)
    for (let x = 0; x < width; x++) {
      const left = hardLeft ? 1 : strength(x - box.left)
      const right = hardRight ? 1 : strength(box.right - x)
      const coverage = Math.min(top, bottom, left, right)
      raw[(y * width + x) * 4 + 3] = Math.round(coverage * 255)
    }
  }
  return raw
}

export function blendProtectedPixels(original, generated, mask) {
  assert(original.length === generated.length && original.length === mask.length * 4)
  const output = Buffer.from(original)
  for (let index = 0; index < mask.length; index++) {
    const offset = index * 4
    const weight = (mask[index] * generated[offset + 3]) / (255 * 255)
    for (let channel = 0; channel < 3; channel++) {
      output[offset + channel] = Math.round(
        original[offset + channel] +
          weight * (generated[offset + channel] - original[offset + channel])
      )
    }
  }
  return output
}

export function describePsd(psd) {
  const names = []
  const visit = (layers) => {
    for (const layer of layers ?? []) {
      names.push(layer.name ?? '')
      visit(layer.children)
    }
  }
  visit(psd.children)
  return { width: psd.width, height: psd.height, names }
}

export async function inspectPsdAlphaRoundtrip() {
  const { readPsd, writePsdBuffer } = await loadPsd()
  const changes = (before, after) => {
    assert.equal(before.length, after.length)
    let changedRgbChannels = 0
    let changedAlphaBytes = 0
    let maxRgbDelta = 0
    for (let index = 0; index < before.length; index++) {
      const delta = Math.abs(before[index] - after[index])
      if (index % 4 === 3) changedAlphaBytes += Number(delta > 0)
      else {
        changedRgbChannels += Number(delta > 0)
        maxRgbDelta = Math.max(maxRgbDelta, delta)
      }
    }
    return { changedRgbChannels, changedAlphaBytes, maxRgbDelta }
  }
  const probe = (size) => {
    const palette = [
      [220, 30, 40, 0],
      [60, 120, 180, 128],
      [20, 40, 60, 255],
      [230, 210, 40, 128]
    ]
    const data = new Uint8ClampedArray(
      Array.from({ length: size * size }, (_, index) => palette[index % palette.length]).flat()
    )
    const imageData = { width: size, height: size, data }
    const document = {
      width: size,
      height: size,
      imageData,
      children: [{ name: 'Group', children: [{ name: 'Raster', imageData }] }]
    }
    const options = { noBackground: true, trimImageData: false, generateThumbnail: false }
    const first = readPsd(writePsdBuffer(document, options), {
      useImageData: true,
      skipThumbnail: true
    })
    const second = readPsd(writePsdBuffer(first, options), {
      useImageData: true,
      skipThumbnail: true
    })
    return {
      width: size,
      height: size,
      inputToFirstComposite: changes(data, first.imageData.data),
      firstToSecondComposite: changes(first.imageData.data, second.imageData.data),
      inputToSecondLayer: changes(data, second.children[0].children[0].imageData.data)
    }
  }
  return {
    classification: 'Observations, not passing controls or product-path failures',
    transparentComposite: probe(8),
    verySmallComposite: probe(2),
    calibration:
      '8-bit white-matte composite encoding has RGB quantization; layers use raw RGBA. Very-small RLE alpha behavior is recorded separately. Timed lossless profiles use opaque supplied composites and transparent layers.'
  }
}

async function cropExport(job) {
  const intermediate = await sharp(job.sourcePath)
    .rotate()
    .extract(job.crop)
    .png({ compressionLevel: 0 })
    .toBuffer()
  await sharp(intermediate)
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 95, mozjpeg: true })
    .toFile(imageOutputPath(job, 'jpg'))
}

const svg = (width, height, body) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`
  )

async function editorComposite(job) {
  const { width, height } = job.crop
  const eraser = job.eraser
  const brush = svg(
    width,
    height,
    `<rect x="${width / 4}" y="${height / 8}" width="${width / 4}" height="${height / 8}" fill="#ef1428"/>`
  )
  const erase = svg(
    width,
    height,
    `<rect x="${eraser.left}" y="${eraser.top}" width="${eraser.width}" height="${eraser.height}" fill="white"/>`
  )
  const text = svg(
    width,
    height,
    `<text x="${eraser.left + 6}" y="${eraser.top + job.fontSize * 1.5}" font-family="sans-serif" font-size="${job.fontSize}" fill="#fa14dc">TEST 23</text>`
  )
  const intermediate = await sharp(job.sourcePath)
    .rotate()
    .extract(job.crop)
    .composite([{ input: brush }, { input: erase, blend: 'dest-out' }, { input: text }])
    .png()
    .toBuffer()
  const result = await sharp(intermediate)
    .rotate(job.angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  await writeFile(imageOutputPath(job, 'png'), result)
  for (const background of ['white', 'black']) {
    await sharp(result)
      .flatten({ background })
      .jpeg({ quality: 95 })
      .toFile(imageOutputPath(job, `${background}.jpg`))
  }
}

async function localPatch(job, observe) {
  const scene = await sharp(job.sourcePath).rotate().png().toBuffer()
  const patch = await sharp(job.generatedPath)
    .rotate()
    .resize(job.size, job.size, { fit: 'fill', kernel: 'lanczos3' })
    .png()
    .toBuffer()
  const raw = makeFeatherMask(job.size, job.size, job.maskBox, job.feather, job.hardSides)
  observe()
  const mask = await sharp(raw, { raw: { width: job.size, height: job.size, channels: 4 } })
    .png()
    .toBuffer()
  const masked = await sharp(patch)
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer()
  await sharp(scene)
    .composite([{ input: masked, left: job.left, top: job.top }])
    .png()
    .toFile(imageOutputPath(job, 'png'))
}

async function protectedComposite(job, observe) {
  const normalized = await sharp(job.generatedPath).rotate().png().toBuffer()
  const cropped = await sharp(normalized)
    .extract({ left: 0, top: 0, width: job.scaledWidth, height: job.scaledHeight })
    .png()
    .toBuffer()
  await sharp(cropped)
    .resize(job.width, job.height, { fit: 'fill', kernel: 'lanczos3' })
    .png()
    .toFile(imageOutputPath(job, 'aligned.png'))
  const rawMask = makeFeatherMask(job.width, job.height, job.maskBox, job.feather)
  const maskPng = await sharp(rawMask, {
    raw: { width: job.width, height: job.height, channels: 4 }
  })
    .png()
    .toBuffer()
  const [original, generated, mask] = await Promise.all([
    sharp(job.sourcePath).ensureAlpha().raw().toBuffer(),
    sharp(imageOutputPath(job, 'aligned.png')).ensureAlpha().raw().toBuffer(),
    sharp(maskPng).flatten({ background: '#000000' }).grayscale().raw().toBuffer()
  ])
  const output = blendProtectedPixels(original, generated, mask)
  observe()
  await sharp(output, { raw: { width: job.width, height: job.height, channels: 4 } })
    .png()
    .toFile(imageOutputPath(job, 'png'))
}

async function psdOperation(job, observe) {
  const { readPsd, writePsdBuffer } = await loadPsd()
  const source = await readFile(job.sourcePath)
  if (job.scenario === 'psd-metadata-read') {
    return describePsd(
      readPsd(source, {
        skipCompositeImageData: true,
        skipLayerImageData: true,
        skipThumbnail: true
      })
    )
  }
  const document = readPsd(source, { useImageData: true, skipThumbnail: true })
  observe()
  const output = writePsdBuffer(document, {
    generateThumbnail: false,
    trimImageData: false,
    noBackground: true
  })
  observe()
  await writeFile(imageOutputPath(job, 'psd'), output)
  return describePsd(document)
}

export async function runImageJob(job, observe = () => {}) {
  assert(IMAGE_SCENARIOS.includes(job.scenario))
  assert(typeof job.sourcePath === 'string' && typeof job.outputDir === 'string')
  let result = null
  if (job.scenario === 'exif-crop-export') await cropExport(job)
  else if (job.scenario === 'editor-alpha-rotation') await editorComposite(job)
  else if (job.scenario === 'local-crop-feather') await localPatch(job, observe)
  else if (job.scenario === 'text-mask-restore-blend') await protectedComposite(job, observe)
  else result = await psdOperation(job, observe)
  observe()
  return { id: job.id, result }
}

if (!isMainThread) {
  const start = isolateMemory()
  const peak = { ...start }
  const observe = () => {
    const current = isolateMemory()
    for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], current[key])
  }
  const timer = setInterval(observe, 5)
  try {
    const value = await runImageJob(workerData, observe)
    parentPort.postMessage({
      ok: true,
      value,
      isolateMemory: { start, end: isolateMemory(), observedPeak: peak }
    })
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      errorType: error instanceof Error ? error.name : 'UnknownError'
    })
  } finally {
    clearInterval(timer)
    parentPort.close()
  }
}
