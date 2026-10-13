import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { PROFILES } from './image-chain.mjs'
import {
  blendProtectedPixels,
  inspectPsdAlphaRoundtrip,
  loadPsd,
  makeFeatherMask,
  runImageJob
} from './image-worker.mjs'

test('Feather alpha retains soft pixels and hard image-boundary edges', () => {
  const box = { left: 2, top: 2, right: 8, bottom: 8 }
  const alpha = (mask, x, y) => mask[(y * 10 + x) * 4 + 3]
  const feathered = makeFeatherMask(10, 10, box, 2)
  assert.equal(alpha(feathered, 0, 5), 0)
  assert.equal(alpha(feathered, 2, 5), 0)
  assert.equal(alpha(feathered, 3, 5), 128)
  assert.equal(alpha(feathered, 5, 5), 255)
  const hardEdges = makeFeatherMask(10, 10, box, 2, ['left', 'top'])
  assert.equal(alpha(hardEdges, 0, 0), 255)
  assert.equal(alpha(hardEdges, 9, 0), 0)
  const hardMask = makeFeatherMask(10, 10, box, 0)
  assert.equal(alpha(hardMask, 2, 5), 255)
  assert.equal(alpha(hardMask, 1, 5), 0)
})

test('Protected blend combines mask/generated alpha and retains original alpha', () => {
  const original = Buffer.from([20, 40, 60, 0, 20, 40, 60, 128, 20, 40, 60, 255, 20, 40, 60, 128])
  const generated = Buffer.from([
    220, 240, 160, 255, 220, 240, 160, 128, 220, 240, 160, 0, 220, 240, 160, 255
  ])
  const result = blendProtectedPixels(original, generated, Buffer.from([0, 255, 255, 128]))
  assert.deepEqual(
    [...result],
    [20, 40, 60, 0, 120, 140, 110, 128, 20, 40, 60, 255, 120, 140, 110, 128]
  )
  assert.deepEqual(
    [...original],
    [20, 40, 60, 0, 20, 40, 60, 128, 20, 40, 60, 255, 20, 40, 60, 128]
  )
})

test('Invalid synthetic pixels and profiles fail before processing', async () => {
  assert.throws(() => blendProtectedPixels(Buffer.alloc(4), Buffer.alloc(8), Buffer.alloc(1)))
  assert.throws(() => makeFeatherMask(10, 10, { left: 8, top: 2, right: 2, bottom: 8 }, 2))
  assert.throws(() => makeFeatherMask(10, 10, { left: 2, top: 2, right: 8, bottom: 8 }, -1))
  await assert.rejects(() => runImageJob({ scenario: 'unknown', sourcePath: '', outputDir: '' }))
  assert.equal(PROFILES.length, 18)
  assert.equal(new Set(PROFILES.map(({ scenario, variant }) => `${scenario}:${variant}`)).size, 18)
})

test('Raw PSD readback preserves opaque composite and every transparent layer byte', async () => {
  const { readPsd, writePsdBuffer } = await loadPsd()
  const palette = [
    [255, 0, 0, 0],
    [60, 120, 180, 128],
    [20, 40, 60, 255],
    [255, 0, 0, 128]
  ]
  const data = new Uint8ClampedArray(
    Array.from({ length: 64 }, (_, index) => palette[index % 4]).flat()
  )
  const opaque = data.map((channel, index) => (index % 4 === 3 ? 255 : channel))
  const imageData = { width: 8, height: 8, data }
  const document = {
    width: 8,
    height: 8,
    imageData: { ...imageData, data: opaque },
    children: [{ name: 'Group', children: [{ name: 'Raster', imageData }] }]
  }
  const encoded = writePsdBuffer(document, {
    noBackground: true,
    trimImageData: false,
    generateThumbnail: false
  })
  const metadata = readPsd(encoded, {
    skipCompositeImageData: true,
    skipLayerImageData: true,
    skipThumbnail: true
  })
  assert.equal(metadata.width, 8)
  assert.equal(metadata.height, 8)
  assert.equal(metadata.imageData, undefined)
  assert.equal(metadata.children[0].children[0].name, 'Raster')
  const restored = readPsd(encoded, { useImageData: true, skipThumbnail: true })
  assert.deepEqual(restored.imageData.data, opaque)
  assert.deepEqual(restored.children[0].children[0].imageData.data, data)
})

test('PSD transparent composite behavior remains visible as a bounded observation', async () => {
  const observed = await inspectPsdAlphaRoundtrip()
  assert.equal(observed.transparentComposite.inputToFirstComposite.changedAlphaBytes, 0)
  assert(observed.transparentComposite.firstToSecondComposite.changedRgbChannels > 0)
  assert.deepEqual(observed.transparentComposite.inputToSecondLayer, {
    changedRgbChannels: 0,
    changedAlphaBytes: 0,
    maxRgbDelta: 0
  })
  assert(observed.verySmallComposite.inputToFirstComposite.changedAlphaBytes > 0)
})

test('Ordinary image worker module does not eagerly load the PSD library', () => {
  const url = JSON.stringify(new URL('./image-worker.mjs', import.meta.url).href)
  const script = `import {createRequire} from 'node:module'; await import(${url}); const require=createRequire(${url}); process.stdout.write(String(Boolean(require.cache[require.resolve('ag-psd')])));`
  const observed = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 3000,
    windowsHide: true
  })
  assert.equal(observed.toString('utf8'), 'false')
})
