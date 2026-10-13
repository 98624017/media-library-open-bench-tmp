import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { digest, inspectNativeFormat, inspectPixels } from './fixtures.mjs'

const raw = Buffer.from([0, 0, 0, 0, 3, 6, 9, 85, 9, 12, 15, 170, 21, 24, 27, 255])
const png = (bytes, height = 2) =>
  sharp(bytes, { raw: { width: 2, height, channels: 4 } })
    .png()
    .toBuffer()

test('native format diagnostics preserve the ordinary RGBA control and identify channel deltas', async () => {
  const reference = await png(raw)
  const equal = await inspectNativeFormat(reference, reference)
  assert.deepEqual(equal.pixels, await inspectPixels(reference))
  assert.equal(equal.encodedSha256, digest(reference))
  assert.equal(equal.differenceFromPrepared.differingPixels, 0)
  assert.equal(equal.ignoredIccDiagnostic.diagnosticOnly, true)
  assert.equal(equal.ignoredIccDiagnostic.differenceFromPrepared.differingPixels, 0)
  assert.equal(equal.pixels.transparentPixels, 1)
  assert.equal(equal.pixels.semiTransparentPixels, 2)
  const changed = Buffer.from(raw)
  changed[8]++
  const difference = await inspectNativeFormat(await png(changed), reference)
  assert.equal(difference.differenceFromPrepared.differingPixels, 1)
  assert.deepEqual(difference.differenceFromPrepared.channels[0], {
    name: 'red',
    changed: 1,
    absoluteDeltaSum: 1,
    signedDeltaSum: 1,
    maxAbsoluteDelta: 1
  })
  assert.equal(difference.differenceFromPrepared.channels[3].changed, 0)
  assert.deepEqual(difference.differenceFromPrepared.examples[0], {
    x: 0,
    y: 1,
    actual: [10, 12, 15, 170],
    reference: [9, 12, 15, 170]
  })
})

test('ICC inspection records profile/chunks and a diagnostic alternative without replacing standard decode', async () => {
  const colors = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 128, 128, 128, 255])
  const reference = await png(colors)
  const profiled = await sharp(reference).withIccProfile('p3').png().toBuffer()
  const result = await inspectNativeFormat(profiled, reference)
  assert.deepEqual(result.pixels, await inspectPixels(profiled))
  assert(result.metadata.icc.bytes >= 128)
  assert.match(result.metadata.icc.sha256, /^[0-9a-f]{64}$/)
  assert.equal(result.metadata.icc.signature, 'acsp')
  assert(result.metadata.pngColorChunks.some((chunk) => chunk.type === 'iCCP'))
  assert.notEqual(result.ignoredIccDiagnostic.pixels.rgbaSha256, result.pixels.rgbaSha256)
  assert.equal(result.ignoredIccDiagnostic.diagnosticOnly, true)
})

test('diagnostic geometry mismatch is recorded without inventing an RGBA comparison', async () => {
  const result = await inspectNativeFormat(await png(Buffer.alloc(24, 255), 3), await png(raw))
  assert.equal(result.differenceFromPrepared.dimensionsMatch, false)
  assert.equal(result.differenceFromPrepared.differingPixels, undefined)
})
