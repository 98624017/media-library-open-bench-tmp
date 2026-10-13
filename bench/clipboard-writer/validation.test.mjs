import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  EXPECTED_CHROME,
  EXPECTED_ELECTRON,
  EXPECTED_SHARP,
  FIXTURES,
  PROBE_SOURCES,
  VARIANTS,
  fixtureLayout
} from './fixtures.mjs'
import { summarizeEvidence } from './summarize.mjs'
import { validateReport } from './validation.mjs'

const revision = 'a'.repeat(40)
const sha256 = 'b'.repeat(64)

function report(name = 'transparent') {
  const { scales, ...layout } = fixtureLayout(name, false)
  const pixels = (scale = 1) => ({
    width: layout.width * scale,
    height: layout.height * scale,
    rgbaSha256: sha256,
    transparentPixels: layout.transparent ? 10 : 0,
    semiTransparentPixels: layout.transparent ? 20 : 0
  })
  const nativeScales = layout.mode === 'path-2x' ? [1, 2] : scales
  const description = () => ({
    size: { width: layout.width, height: layout.height },
    scales: [...nativeScales]
  })
  const colorMetadata = (format = 'png') => ({
    format,
    width: layout.width,
    height: layout.height,
    space: 'srgb',
    channels: 4,
    depth: 'uchar',
    density: null,
    bitsPerSample: 8,
    hasAlpha: true,
    hasProfile: false,
    orientation: null,
    icc: null,
    pngColorChunks: []
  })
  const bitmapMetadata = () => ({
    width: layout.width,
    height: layout.height,
    bitsPerSample: 8,
    bitsPerPixel: 32,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    bitmapFormat: 2,
    colorSpaceName: 'NSCalibratedRGBColorSpace'
  })
  const sourceDelta = () => ({
    dimensionsMatch: true,
    comparedPixels: layout.width * layout.height,
    differingPixels: 0,
    channels: ['red', 'green', 'blue', 'alpha'].map((name) => ({
      name,
      changed: 0,
      absoluteDeltaSum: 0,
      signedDeltaSum: 0,
      maxAbsoluteDelta: 0
    })),
    examples: []
  })
  return {
    schemaVersion: 1,
    completed: true,
    cleanedOwnedDirectory: true,
    adoption: 'manual-review-required',
    label: 'test-evidence',
    sourceRevision: revision,
    probeSourceSha256: Object.fromEntries(PROBE_SOURCES.map((file) => [file, sha256])),
    dependencies: { electron: EXPECTED_ELECTRON, sharp: EXPECTED_SHARP },
    sharpVersions: { sharp: EXPECTED_SHARP, vips: 'test-version' },
    nativeReaderSha256: sha256,
    platform: 'darwin',
    arch: 'arm64',
    samples: 7,
    fixture: {
      name,
      quick: false,
      ...layout,
      representations: scales.map((scale) => ({
        scale,
        width: layout.width * scale,
        height: layout.height * scale,
        rgbaSha256: sha256,
        encodedSha256: sha256
      }))
    },
    rows: Array.from({ length: 7 }, (_, sample) =>
      (sample % 2 ? [...VARIANTS].reverse() : VARIANTS).map((variant) => ({
        sample,
        variant,
        status: 'complete',
        clipboardCleared: true,
        isolatedUserData: true,
        platform: 'darwin',
        arch: 'arm64',
        runtime: { electron: EXPECTED_ELECTRON, chrome: EXPECTED_CHROME },
        writeMs: variant === 'write-image' ? 10 + sample : 9 + sample,
        rssBeforeBytes: 100,
        rssAfterBytes: 180,
        memory: {
          prewarmSucceeded: true,
          samplingIntervalMs: 100,
          platform: 'darwin',
          missingChildren: 0,
          children: [
            { samples: 3, observedPeakRssBytes: 200, missing: false, lastUnavailableReason: null }
          ]
        },
        checks: { pixelsMatch: true, dimensionsMatch: true, representationsPreserved: true },
        prepared: description(),
        preparedAfter: description(),
        representations: nativeScales.map((scale) => ({
          scale,
          size: { width: layout.width * scale, height: layout.height * scale },
          pixels: pixels(scale)
        })),
        preparedPixels: pixels(),
        readbackPixels: pixels(),
        formats: ['image/png'],
        native: {
          readOnly: true,
          formats: ['public.png'],
          images: [
            {
              format: 'public.png',
              declared: true,
              bytes: 10,
              pixels: pixels(),
              colorMetadata: colorMetadata(),
              bitmapMetadata: bitmapMetadata(),
              sourceDelta: sourceDelta()
            },
            {
              format: 'public.tiff',
              declared: false,
              bytes: 0,
              pixels: null,
              colorMetadata: null,
              bitmapMetadata: null,
              sourceDelta: null
            }
          ]
        }
      }))
    ).flat()
  }
}

function reportWithNativeTiffSourceDelta() {
  const data = report()
  for (const row of data.rows) {
    const png = row.native.images[0]
    const tiff = structuredClone(png)
    tiff.format = 'public.tiff'
    tiff.colorMetadata.format = 'tiff'
    tiff.colorMetadata.hasProfile = true
    tiff.colorMetadata.icc = {
      bytes: 3144,
      sha256,
      profileClass: 'mntr',
      colorSpace: 'RGB ',
      pcs: 'XYZ ',
      signature: 'acsp'
    }
    tiff.pixels.rgbaSha256 = 'c'.repeat(64)
    tiff.sourceDelta.differingPixels = 1
    tiff.sourceDelta.channels[0] = {
      name: 'red',
      changed: 1,
      absoluteDeltaSum: 1,
      signedDeltaSum: 1,
      maxAbsoluteDelta: 1
    }
    row.native.images[1] = tiff
    row.native.formats.push('public.tiff')
  }
  return data
}

test('ordinary TIFF source delta passes only with exact same-flavor pixels and native color/alpha metadata', () => {
  const data = reportWithNativeTiffSourceDelta()
  validateReport(data)
  assert.notEqual(
    data.rows[0].native.images[1].pixels.rgbaSha256,
    data.rows[0].preparedPixels.rgbaSha256
  )
  for (const mutate of [
    (entry) => {
      entry.pixels.rgbaSha256 = 'd'.repeat(64)
    },
    (entry) => {
      entry.pixels.semiTransparentPixels++
    },
    (entry) => {
      entry.colorMetadata.icc.sha256 = 'd'.repeat(64)
    },
    (entry) => {
      entry.bitmapMetadata.bitmapFormat = 0
    },
    (entry) => {
      entry.bitmapMetadata.colorSpaceName = 'NSDeviceRGBColorSpace'
    },
    (entry) => {
      entry.colorMetadata.orientation = 1
    },
    (entry) => {
      entry.colorMetadata.pngColorChunks.push({ type: 'sRGB', bytes: 1, sha256 })
    },
    (entry) => {
      entry.bytes = 0
    },
    (entry) => {
      entry.colorMetadata = undefined
    },
    (entry) => {
      entry.bitmapMetadata = undefined
    },
    (entry) => {
      entry.sourceDelta.channels[3].changed = 1
    }
  ]) {
    const changed = reportWithNativeTiffSourceDelta()
    mutate(changed.rows[1].native.images[1])
    assert.throws(() => validateReport(changed))
  }
  for (const row of data.rows) row.native.images[0].pixels.rgbaSha256 = 'c'.repeat(64)
  assert.throws(() => validateReport(data), 'Native PNG must still reproduce source RGBA exactly')
})

test('complete rotated native samples retain distributions; missing rows/observer/cleanup fail', () => {
  assert.equal(validateReport(report())['write-image'].writeMs.median, 13)
  for (const mutate of [
    (data) => {
      data.rows.pop()
    },
    (data) => {
      data.rows[0].memory.children[0].samples = 0
    },
    (data) => {
      data.rows[0].status = 'written'
    },
    (data) => {
      data.rows[0].status = 'readback-observed'
    },
    (data) => {
      data.cleanedOwnedDirectory = false
    },
    (data) => {
      data.rows[0].native.images[0].bytes = 0
    },
    (data) => {
      data.probeSourceSha256 = undefined
    },
    (data) => {
      data.rows[0].memory.children[0].lastUnavailableReason = 'ps-exit:2'
    },
    (data) => {
      data.rows[0].memory.prewarmSucceeded = false
    },
    (data) => {
      data.rows[0].preparedPixels = undefined
    },
    (data) => {
      data.fixture.width = 1
    }
  ]) {
    const data = report()
    mutate(data)
    assert.throws(() => validateReport(data))
  }
})

test('pixel, native-format, representation, runtime and duplicate-sample drift reject equivalence', () => {
  for (const mutate of [
    (data) => {
      data.rows[1].readbackPixels.rgbaSha256 = 'different'
    },
    (data) => {
      data.rows[1].native.formats.push('public.tiff')
    },
    (data) => {
      data.rows[1].prepared.scales.pop()
    },
    (data) => {
      data.rows[1].runtime.electron = '40.0.0'
    },
    (data) => {
      data.rows[1].runtime.node = 'different-version'
    },
    (data) => {
      data.dependencies.sharp = '0.35.0'
    },
    (data) => {
      data.rows[1].variant = data.rows[0].variant
    },
    (data) => {
      data.rows.reverse()
    }
  ]) {
    const data = report()
    mutate(data)
    assert.throws(() => validateReport(data))
  }
})

test('Retina original source representations and inferred 1x retain native density', () => {
  for (const name of ['retina-siblings', 'retina-2x']) {
    const data = report(name)
    validateReport(data)
    const original = data.rows[0].representations.find((entry) => entry.scale === 2)
    original.pixels.rgbaSha256 = 'c'.repeat(64)
    assert.throws(() => validateReport(data))
  }
})

test('stage summary rejects absent/source/runtime/observer evidence and partial supervisor receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clipboard-summary-validation-'))
  const writeStage = async (data, supervisor = {}) => {
    const directory = join(root, `clipboard-test-evidence-${data.fixture.name}`)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'report.json'), JSON.stringify(data), 'utf8')
    await writeFile(
      join(directory, 'supervisor.json'),
      JSON.stringify({
        completed: true,
        reason: 'exit',
        suite: 'clipboard-writer',
        exitCode: 0,
        label: data.label,
        sourceRevision: revision,
        ...supervisor
      }),
      'utf8'
    )
  }
  try {
    for (const name of FIXTURES) await writeStage(report(name))
    assert.equal((await summarizeEvidence(root, 'test-evidence', revision)).completed, true)
    for (const mutate of [
      (data) => {
        delete data.probeSourceSha256
      },
      (data) => {
        data.sourceRevision = 'c'.repeat(40)
      },
      (data) => {
        data.sharpVersions.vips = 'changed'
      },
      (data) => {
        data.nativeReaderSha256 = 'c'.repeat(64)
      },
      (data) => {
        data.rows[0].memory.children[0].samples = 0
      },
      (data) => {
        data.rows.pop()
      }
    ]) {
      const data = report('retina-2x')
      mutate(data)
      await writeStage(data)
      assert.equal((await summarizeEvidence(root, 'test-evidence', revision)).completed, false)
    }
    await writeStage(report('retina-2x'), { completed: false, reason: 'deadline' })
    assert.equal((await summarizeEvidence(root, 'test-evidence', revision)).completed, false)
    await rm(join(root, 'clipboard-test-evidence-retina-2x'), { recursive: true })
    assert.equal((await summarizeEvidence(root, 'test-evidence', revision)).completed, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
