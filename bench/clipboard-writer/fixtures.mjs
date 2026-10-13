import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

export const VARIANTS = ['write-image', 'write-dictionary']
export const FIXTURES = ['rgb-2k', 'rgb-4k', 'transparent', 'retina-siblings', 'retina-2x']
export const EXPECTED_ELECTRON = '39.8.3'
export const EXPECTED_CHROME = '142.0.7444.265'
export const EXPECTED_SHARP = '0.34.5'
export const PROBE_SOURCES = [
  'fixtures.mjs',
  'native.cjs',
  'read-mac.swift',
  'run.mjs',
  'validation.mjs',
  'launch.mjs',
  'summarize.mjs',
  '../platform/metrics.mjs',
  '../extended/launch.mjs',
  '../extended/video-memory.mjs',
  '../extended/video-memory.py',
  '../extended/termination.mjs',
  '../extended/report-file.mjs',
  '../../.github/workflows/native-clipboard-writer.yml'
]
export const SHARP_VERSIONS = sharp.versions
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

function pixels(width, height, transparent) {
  const raw = Buffer.alloc(width * height * 4)
  let state = 7831
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4
    const alpha = transparent ? (pixel % 4) * 85 : 255
    for (let channel = 0; channel < 3; channel++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      // Multiples of three avoid introducing arbitrary premultiplication rounding in alpha controls.
      raw[offset + channel] =
        alpha === 0 ? 0 : transparent ? (state & 255) - ((state & 255) % 3) : state & 255
    }
    raw[offset + 3] = alpha
  }
  return raw
}

export function fixtureLayout(name, quick) {
  assert(FIXTURES.includes(name), 'Unknown generated fixture')
  const retina = name.startsWith('retina')
  const width = retina
    ? 64
    : name === 'transparent'
      ? 128
      : quick
        ? name === 'rgb-2k'
          ? 128
          : 256
        : name === 'rgb-2k'
          ? 2048
          : 4096
  const height = retina ? 48 : name === 'transparent' ? 96 : width
  const transparent = retina || name === 'transparent'
  const mode = retina ? (name === 'retina-2x' ? 'path-2x' : 'path-siblings') : 'buffer'
  return { width, height, transparent, mode, scales: retina ? [1, 2, 3] : [1] }
}

export async function prepareFixture(directory, name, quick) {
  const { width, height, transparent, mode, scales } = fixtureLayout(name, quick)
  const representations = []
  for (const scale of scales) {
    const raw = pixels(width * scale, height * scale, transparent)
    const png = await sharp(raw, {
      raw: { width: width * scale, height: height * scale, channels: 4 }
    })
      .png()
      .toBuffer()
    const filename = `generated image${scale === 1 ? '' : `@${scale}x`}.png`
    await writeFile(join(directory, filename), png)
    representations.push({
      scale,
      filename,
      width: width * scale,
      height: height * scale,
      encodedBytes: png.length,
      encodedSha256: digest(png),
      rgbaSha256: digest(raw)
    })
  }
  return { name, mode, width, height, transparent, quick, representations }
}

export async function inspectPixels(bytes) {
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let transparentPixels = 0
  let semiTransparentPixels = 0
  for (let offset = 3; offset < decoded.data.length; offset += 4) {
    if (decoded.data[offset] === 0) transparentPixels++
    else if (decoded.data[offset] !== 255) semiTransparentPixels++
  }
  return {
    width: decoded.info.width,
    height: decoded.info.height,
    rgbaSha256: digest(decoded.data),
    transparentPixels,
    semiTransparentPixels
  }
}
