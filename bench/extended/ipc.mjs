import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { measure } from '../platform/metrics.mjs'

const SIZES = ['medium', 'large']
export const PROFILES = SIZES.flatMap((size) => [
  ...['base64', 'array-buffer', 'file-url'].map((variant) => ({
    scenario: `decode-${size}`,
    variant
  })),
  { scenario: `clipboard-${size}`, variant: 'native-png-roundtrip' }
])

function fixture(width, height) {
  const raw = Buffer.alloc(width * height * 3)
  let state = 7831
  for (let index = 0; index < raw.length; index++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    raw[index] = state & 255
  }
  const points = [
    [0, 0],
    [17, 23],
    [width - 1, height - 1],
    [width >> 1, height >> 1]
  ]
  const pixels = points.map(([x, y]) =>
    Array.from(raw.subarray((y * width + x) * 3, (y * width + x) * 3 + 3))
  )
  return { raw, points, pixels }
}

async function decodeInRenderer({ variant, repeats, points }) {
  const results = []
  for (let index = 0; index < repeats; index++) {
    const started = performance.now()
    const payload = await window.benchAPI.readImage(variant)
    const transported = performance.now()
    const image = new Image()
    let ownedUrl
    if (variant === 'file-url') image.src = payload
    else if (variant === 'base64') image.src = `data:image/png;base64,${payload}`
    else {
      const bytes = new Uint8Array(payload)
      ownedUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
      image.src = ownedUrl
    }
    try {
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      const pixels = points.map(([x, y]) =>
        Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3)
      )
      results.push({
        width: image.naturalWidth,
        height: image.naturalHeight,
        pixels,
        transportMs: transported - started,
        decodeAndSampleMs: performance.now() - transported,
        totalMs: performance.now() - started
      })
    } finally {
      if (ownedUrl) URL.revokeObjectURL(ownedUrl)
    }
  }
  return { results, processMemoryScope: 'Renderer timings, without precise renderer memory peaks' }
}

export async function runBench({ base, quick, sampleCount, emit, electron }) {
  const { app, BrowserWindow, clipboard, ipcMain, nativeImage } = electron
  if (process.platform === 'win32') sharp.cache(false)
  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: {
      preload: fileURLToPath(new URL('./ipc-preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  const page = join(base, 'decode-page.html')
  await writeFile(
    page,
    '<!doctype html><meta charset="utf-8"><title>Synthetic decode fixture</title>'
  )
  await win.loadFile(page)
  let current
  ipcMain.handle('bench:read-image', (_event, variant) => {
    assert(['base64', 'array-buffer', 'file-url'].includes(variant))
    if (variant === 'base64') return current.png.toString('base64')
    if (variant === 'array-buffer')
      return current.png.buffer.slice(
        current.png.byteOffset,
        current.png.byteOffset + current.png.length
      )
    return pathToFileURL(current.path).href
  })
  try {
    for (const size of SIZES) {
      const width = quick ? (size === 'medium' ? 128 : 512) : size === 'medium' ? 1024 : 2048
      const height = width
      const source = fixture(width, height)
      const png = await sharp(source.raw, { raw: { width, height, channels: 3 } })
        .png()
        .toBuffer()
      const path = join(base, `生成 图片 ${size}.png`)
      await writeFile(path, png)
      current = { png, path }
      const repeats = quick ? 2 : 4
      for (let sample = 0; sample < sampleCount; sample++) {
        const variants = ['base64', 'array-buffer', 'file-url']
        const rotated = variants
          .slice(sample % variants.length)
          .concat(variants.slice(0, sample % variants.length))
        for (const variant of rotated) {
          const measured = await measure(() =>
            win.webContents.executeJavaScript(
              `(${decodeInRenderer.toString()})(${JSON.stringify({ variant, repeats, points: source.points })})`
            )
          )
          for (const result of measured.value.results) {
            assert.equal(result.width, width)
            assert.equal(result.height, height)
            assert.deepEqual(result.pixels, source.pixels)
          }
          await emit({
            suite: 'ipc',
            scenario: `decode-${size}`,
            variant,
            sample,
            workload: { width, height, pngBytes: png.length, repeats },
            metrics: measured.metrics,
            checks: { pixelsMatch: true, dimensionsMatch: true },
            renderer: measured.value,
            rendererProcessesAfter: app
              .getAppMetrics()
              .filter((entry) => entry.type === 'Tab')
              .map((entry) => ({
                type: entry.type,
                workingSetSizeKiB: entry.memory.workingSetSize,
                peakWorkingSetSizeKiB: entry.memory.peakWorkingSetSize
              })),
            transferBytesPerRequest:
              variant === 'base64'
                ? Buffer.byteLength(png.toString('base64'))
                : variant === 'array-buffer'
                  ? png.length
                  : Buffer.byteLength(pathToFileURL(path).href)
          })
        }
        const image = nativeImage.createFromBuffer(png)
        let measured
        try {
          measured = await measure(() => {
            clipboard.writeImage(image)
            const read = clipboard.readImage()
            if (read.isEmpty()) return null
            return read.toPNG()
          })
        } catch (error) {
          await emit({
            suite: 'ipc',
            scenario: `clipboard-${size}`,
            variant: 'native-png-roundtrip',
            sample,
            workload: { width, height, pngBytes: png.length },
            metrics: null,
            checks: { available: false },
            status: 'unsupported',
            diagnostic: { name: error.name, code: error.code ?? null }
          })
          continue
        }
        if (measured.value === null) {
          await emit({
            suite: 'ipc',
            scenario: `clipboard-${size}`,
            variant: 'native-png-roundtrip',
            sample,
            workload: { width, height, pngBytes: png.length },
            metrics: null,
            checks: { available: false },
            status: 'unsupported',
            diagnostic: { reason: 'Native clipboard returned an empty image' }
          })
          continue
        }
        const decoded = await sharp(measured.value)
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })
        assert.equal(decoded.info.width, width)
        assert.equal(decoded.info.height, height)
        assert.deepEqual(decoded.data, source.raw)
        await emit({
          suite: 'ipc',
          scenario: `clipboard-${size}`,
          variant: 'native-png-roundtrip',
          sample,
          workload: { width, height, pngBytes: png.length },
          metrics: measured.metrics,
          checks: { available: true, allPixelsMatch: true },
          outputPngBytes: measured.value.length
        })
      }
    }
    return {
      calibration:
        'Real ipcMain.invoke/contextBridge, Chromium image decode and native clipboard; measurements end after decoded pixels are available',
      limits: [
        'Generated RGB PNG only',
        'File URLs may hit Chromium decoded/file caches within a sample; OS caches are not reset',
        'Main RSS excludes renderer peaks; renderer working-set observations are KiB and post-operation only',
        'GPU disabled; no product rendering/input certification'
      ]
    }
  } finally {
    ipcMain.removeHandler('bench:read-image')
    clipboard.clear()
    win.destroy()
  }
}
