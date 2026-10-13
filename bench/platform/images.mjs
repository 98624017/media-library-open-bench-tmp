import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { measure, pool, round } from './metrics.mjs'

export const CACHE_POLICIES = ['disabled', 'default', 'fileless']

export function setCachePolicy(sharp, policy) {
  assert(CACHE_POLICIES.includes(policy), `Unknown cache policy: ${policy}`)
  sharp.cache(false)
  if (policy === 'default') sharp.cache(true)
  if (policy === 'fileless') sharp.cache({ memory: 50, files: 0, items: 100 })
  return sharp.cache()
}

function pixels(width, height) {
  const raw = Buffer.alloc(width * height * 3)
  let seed = 7919
  for (let index = 0; index < raw.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    raw[index] = ((index / (width * 3)) & 255) ^ ((seed >>> 24) & 31)
  }
  return raw
}

async function fixtures(sharp, root, quick) {
  const width = quick ? 768 : 4096
  const height = quick ? 576 : 3072
  const source = sharp(pixels(width, height), {
    raw: { width, height, channels: 3 }
  })
  const formats = {
    jpeg: {
      extension: 'jpg',
      encode: (input) => input.jpeg({ quality: 92 }),
      count: quick ? 2 : 12
    },
    png: {
      extension: 'png',
      encode: (input) => input.png({ compressionLevel: 6 }),
      count: quick ? 2 : 6
    },
    webp: {
      extension: 'webp',
      encode: (input) =>
        input
          .resize({ width: 2048, withoutEnlargement: true })
          .webp({ quality: 82 }),
      count: 2
    },
    tiff: {
      extension: 'tif',
      encode: (input) =>
        input
          .resize({ width: 2048, withoutEnlargement: true })
          .tiff({ compression: 'lzw' }),
      count: 2
    },
    avif: {
      extension: 'avif',
      encode: (input) =>
        input
          .resize({ width: 1024, withoutEnlargement: true })
          .avif({ quality: 55, effort: 1 }),
      count: 2
    }
  }
  const files = {}
  const dimensions = {}
  let bytes = 0
  for (const [format, options] of Object.entries(formats)) {
    const paths = Array.from({ length: options.count }, (_, index) =>
      join(root, `generated ${index}.${options.extension}`)
    )
    await options.encode(source.clone()).toFile(paths[0])
    for (const path of paths.slice(1)) await copyFile(paths[0], path)
    bytes += (await stat(paths[0])).size * paths.length
    files[format] = paths
    const metadata = await sharp(paths[0]).metadata()
    dimensions[format] = { width: metadata.width, height: metadata.height }
  }
  return { files, dimensions, width, height, bytes }
}

const digest = (buffers) => {
  const hash = createHash('sha256')
  for (const buffer of buffers) hash.update(buffer)
  return hash.digest('hex')
}

export async function runImageBench({
  base,
  quick,
  sampleCount,
  emit,
  cachePolicy
}) {
  const loadedAt = performance.now()
  const { default: sharp } = await import('sharp')
  const loadMs = round(performance.now() - loadedAt)
  sharp.cache(false)
  const root = await mkdtemp(join(base, 'image-policies-'))
  try {
    await mkdir(join(root, 'sources'))
    const input = await fixtures(sharp, join(root, 'sources'), quick)
    const configuredCache = setCachePolicy(sharp, cachePolicy)
    const preview = (file) =>
      sharp(file)
        .rotate()
        .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
    const assetThumbnail = (file) =>
      sharp(file)
        .rotate()
        .resize(120, 120, { fit: 'cover' })
        .jpeg({ quality: 70 })
        .toBuffer()
    const inspectAndThumbnail = async (file) => {
      const pipeline = sharp(file)
      await pipeline.metadata()
      await pipeline
        .rotate()
        .resize({ width: 1, height: 1, fit: 'inside' })
        .raw()
        .toBuffer()
      return assetThumbnail(file)
    }
    const scenarios = [
      {
        name: 'asset-thumbnail-unique-jpeg',
        format: 'jpeg',
        files: input.files.jpeg,
        operation: assetThumbnail,
        dimensions: [120, 120]
      },
      {
        name: 'preflight-plus-thumbnail-unique-jpeg',
        format: 'jpeg',
        files: input.files.jpeg,
        operation: inspectAndThumbnail,
        dimensions: [120, 120]
      },
      ...Object.entries(input.files).map(([format, files]) => ({
        name: `preview-unique-${format}`,
        format,
        files,
        operation: preview
      })),
      ...['jpeg', 'png'].map((format) => ({
        name: `preview-repeated-${format}`,
        format,
        files: Array.from(
          { length: quick ? 3 : 12 },
          () => input.files[format][0]
        ),
        operation: preview
      }))
    ]
    const rows = []
    for (const scenario of scenarios) {
      let expectedDigest
      for (let sample = 0; sample < sampleCount; sample++) {
        const { value, metrics } = await measure(async () => {
          const results = []
          await pool(scenario.files, 2, async (file, index) => {
            results[index] = await scenario.operation(file)
          })
          return results
        })
        assert.equal(value.length, scenario.files.length)
        const outputDigest = digest(value)
        if (expectedDigest)
          assert.equal(
            outputDigest,
            expectedDigest,
            'Cached output differs between samples'
          )
        expectedDigest = outputDigest
        // Output decoding belongs to correctness validation, outside the measured pipeline.
        sharp.cache(false)
        for (const buffer of value) {
          const metadata = await sharp(buffer).metadata()
          assert.equal(metadata.format, 'jpeg')
          if (scenario.dimensions) {
            assert.equal(metadata.width, scenario.dimensions[0])
            assert.equal(metadata.height, scenario.dimensions[1])
          } else {
            assert(metadata.width > 0 && metadata.width <= 400)
            assert(metadata.height > 0 && metadata.height <= 400)
          }
        }
        setCachePolicy(sharp, cachePolicy)
        // Validation resets cache, so samples start with the same cache state.
        const row = {
          suite: 'images',
          scenario: scenario.name,
          variant: cachePolicy,
          sample,
          count: scenario.files.length,
          inputWidth: input.dimensions[scenario.format].width,
          inputHeight: input.dimensions[scenario.format].height,
          generatedWidth: input.width,
          generatedHeight: input.height,
          fixtureSemantics: 'RGB; no EXIF rotation or transparency',
          fixtureBytes: input.bytes,
          duplicateBytesAtDistinctPaths: true,
          concurrency: 2,
          cacheStartsEmpty: true,
          cache: configuredCache,
          sharpVersions: sharp.versions,
          firstProcessImportMs: rows.length === 0 ? loadMs : null,
          metrics,
          checks: {
            outputDigest,
            outputCount: value.length,
            dimensionsValid: true
          }
        }
        rows.push(row)
        await emit(row)
      }
    }
    return rows
  } finally {
    sharp.cache(false)
    await rm(root, { recursive: true, force: true })
  }
}
