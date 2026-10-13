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
  'protocol.cjs',
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
  return summarizePixels(decoded)
}

function summarizePixels(decoded) {
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

function pixelDifference(actual, reference) {
  const dimensionsMatch =
    actual.info.width === reference.info.width && actual.info.height === reference.info.height
  if (!dimensionsMatch || actual.info.channels !== 4 || reference.info.channels !== 4)
    return {
      dimensionsMatch,
      channels: actual.info.channels,
      referenceChannels: reference.info.channels
    }
  const channels = ['red', 'green', 'blue', 'alpha'].map((name) => ({
    name,
    changed: 0,
    absoluteDeltaSum: 0,
    signedDeltaSum: 0,
    maxAbsoluteDelta: 0
  }))
  let differingPixels = 0
  const examples = []
  for (let offset = 0; offset < actual.data.length; offset += 4) {
    let differs = false
    for (let channel = 0; channel < 4; channel++) {
      const delta = actual.data[offset + channel] - reference.data[offset + channel]
      if (!delta) continue
      differs = true
      const stats = channels[channel]
      stats.changed++
      stats.absoluteDeltaSum += Math.abs(delta)
      stats.signedDeltaSum += delta
      stats.maxAbsoluteDelta = Math.max(stats.maxAbsoluteDelta, Math.abs(delta))
    }
    if (!differs) continue
    differingPixels++
    if (examples.length < 8)
      examples.push({
        x: (offset / 4) % actual.info.width,
        y: Math.floor(offset / 4 / actual.info.width),
        actual: [...actual.data.subarray(offset, offset + 4)],
        reference: [...reference.data.subarray(offset, offset + 4)]
      })
  }
  return {
    dimensionsMatch,
    comparedPixels: actual.data.length / 4,
    differingPixels,
    channels,
    examples
  }
}

function pngColorChunks(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return []
  const chunks = []
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset)
    assert(offset + length + 12 <= bytes.length, 'Truncated generated PNG chunk')
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP'].includes(type))
      chunks.push({
        type,
        bytes: length,
        sha256: digest(data),
        ...(type === 'iCCP'
          ? { profileName: data.toString('utf8', 0, Math.max(0, data.indexOf(0))) }
          : { rawValues: [...data] })
      })
    offset += length + 12
    if (type === 'IEND') break
  }
  return chunks
}

function colorMetadata(metadata, bytes) {
  const icc = metadata.icc
  return {
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    space: metadata.space,
    channels: metadata.channels,
    depth: metadata.depth,
    density: metadata.density ?? null,
    bitsPerSample: metadata.bitsPerSample ?? null,
    hasAlpha: metadata.hasAlpha,
    hasProfile: metadata.hasProfile,
    orientation: metadata.orientation ?? null,
    icc: icc
      ? {
          bytes: icc.length,
          sha256: digest(icc),
          ...(icc.length >= 128
            ? {
                profileClass: icc.toString('ascii', 12, 16),
                colorSpace: icc.toString('ascii', 16, 20),
                pcs: icc.toString('ascii', 20, 24),
                signature: icc.toString('ascii', 36, 40)
              }
            : {})
        }
      : null,
    pngColorChunks: pngColorChunks(bytes)
  }
}

export async function inspectNativeFormat(bytes, referenceBytes) {
  const metadata = await sharp(bytes).metadata()
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const reference = await sharp(referenceBytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  // Diagnostic only: the ordinary color-managed decode remains the strict control's input.
  const ignoredIcc = await sharp(bytes, { ignoreIcc: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return {
    encodedBytes: bytes.length,
    encodedSha256: digest(bytes),
    metadata: colorMetadata(metadata, bytes),
    pixels: summarizePixels(decoded),
    differenceFromPrepared: pixelDifference(decoded, reference),
    ignoredIccDiagnostic: {
      diagnosticOnly: true,
      pixels: summarizePixels(ignoredIcc),
      differenceFromPrepared: pixelDifference(ignoredIcc, reference)
    }
  }
}
