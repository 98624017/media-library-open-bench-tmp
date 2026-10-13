import assert from 'node:assert/strict'
import { median } from '../platform/metrics.mjs'
import {
  EXPECTED_CHROME,
  EXPECTED_ELECTRON,
  EXPECTED_SHARP,
  FIXTURES,
  PROBE_SOURCES,
  VARIANTS,
  fixtureLayout
} from './fixtures.mjs'

const isDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const validSize = (size) =>
  Number.isInteger(size?.width) &&
  size.width > 0 &&
  Number.isInteger(size.height) &&
  size.height > 0
const validPixels = (pixels) =>
  validSize(pixels) &&
  isDigest(pixels.rgbaSha256) &&
  Number.isInteger(pixels.transparentPixels) &&
  pixels.transparentPixels >= 0 &&
  Number.isInteger(pixels.semiTransparentPixels) &&
  pixels.semiTransparentPixels >= 0

const distribution = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return { min: sorted[0], median: median(sorted), max: sorted.at(-1), values: sorted }
}

export function validateReport(report) {
  assert.equal(report.completed, true, 'Incomplete fixture report')
  assert.equal(report.cleanedOwnedDirectory, true, 'Fixture cleanup was not confirmed')
  assert.equal(report.adoption, 'manual-review-required')
  assert(FIXTURES.includes(report.fixture.name))
  assert.equal(typeof report.fixture.quick, 'boolean')
  const { scales, ...expectedLayout } = fixtureLayout(report.fixture.name, report.fixture.quick)
  for (const [field, value] of Object.entries(expectedLayout))
    assert.equal(report.fixture[field], value)
  if (!report.fixture.quick)
    assert(/^[0-9a-f]{40}$/.test(report.sourceRevision), 'Missing exact source revision')
  assert.deepEqual(Object.keys(report.probeSourceSha256).sort(), [...PROBE_SOURCES].sort())
  assert(Object.values(report.probeSourceSha256).every(isDigest), 'Missing probe source digest')
  assert.equal(report.dependencies.electron, EXPECTED_ELECTRON)
  assert.equal(report.dependencies.sharp, EXPECTED_SHARP)
  assert.equal(report.sharpVersions.sharp, EXPECTED_SHARP)
  if (report.platform === 'darwin') assert(isDigest(report.nativeReaderSha256))
  assert(report.fixture.representations.length > 0)
  assert.deepEqual(
    report.fixture.representations.map((entry) => entry.scale),
    scales
  )
  for (const source of report.fixture.representations) {
    assert(validSize(source) && isDigest(source.rgbaSha256) && isDigest(source.encodedSha256))
    assert.equal(source.width, report.fixture.width * source.scale)
    assert.equal(source.height, report.fixture.height * source.scale)
  }
  assert(Number.isInteger(report.samples) && report.samples > 0 && report.samples <= 9)
  if (report.platform === 'darwin' && !report.fixture.quick) assert(report.samples >= 7)
  assert.equal(report.rows.length, report.samples * VARIANTS.length, 'Missing native samples')
  const ids = new Set()
  for (const row of report.rows) {
    assert.equal(row.status, 'complete', 'Native write/readback was not completed')
    assert.equal(row.clipboardCleared, true, 'Owned clipboard cleanup was not confirmed')
    assert.equal(row.runtime.electron, EXPECTED_ELECTRON)
    assert.equal(row.runtime.chrome, EXPECTED_CHROME)
    assert.deepEqual(row.runtime, report.rows[0].runtime, 'Native runtime differs across samples')
    assert.equal(row.platform, report.platform)
    assert.equal(row.arch, report.arch)
    assert.equal(row.isolatedUserData, true)
    assert(VARIANTS.includes(row.variant))
    assert(Number.isInteger(row.sample) && row.sample >= 0 && row.sample < report.samples)
    const id = `${row.sample}:${row.variant}`
    assert(!ids.has(id), 'Duplicate native sample')
    ids.add(id)
    assert(Number.isFinite(row.writeMs) && row.writeMs > 0, 'Missing write-only timing')
    assert(Number.isSafeInteger(row.rssBeforeBytes) && row.rssBeforeBytes > 0)
    assert(Number.isSafeInteger(row.rssAfterBytes) && row.rssAfterBytes > 0)
    assert.equal(row.memory.prewarmSucceeded, true)
    assert.equal(row.memory.samplingIntervalMs, 100)
    assert.equal(row.memory.platform, report.platform)
    assert.equal(row.memory.missingChildren, 0)
    assert.equal(row.memory.children.length, 1, 'Wrong external memory scope')
    const observer = row.memory.children[0]
    assert(
      Number.isInteger(observer.samples) &&
        observer.samples >= 2 &&
        observer.observedPeakRssBytes > 0 &&
        observer.missing === false &&
        observer.lastUnavailableReason === null,
      'Missing outside-process memory observation'
    )
    assert(
      row.checks.pixelsMatch && row.checks.dimensionsMatch && row.checks.representationsPreserved
    )
    assert(validSize(row.prepared.size) && row.prepared.scales.length > 0)
    assert.deepEqual(row.preparedAfter.size, row.prepared.size)
    assert(row.prepared.scales.every((scale) => row.preparedAfter.scales.includes(scale)))
    assert.deepEqual(
      row.representations.map((entry) => entry.scale),
      row.preparedAfter.scales
    )
    assert(validPixels(row.preparedPixels) && validPixels(row.readbackPixels))
    assert.deepEqual(row.readbackPixels, row.preparedPixels, 'Clipboard pixels differ from oracle')
    assert(Array.isArray(row.formats) && row.formats.length > 0)
    for (const representation of row.representations) {
      assert(validSize(representation.size) && validPixels(representation.pixels))
      const source = report.fixture.representations.find(
        (entry) => entry.scale === representation.scale
      )
      if (!source || (report.fixture.mode === 'path-2x' && representation.scale !== 2)) continue
      assert.equal(representation.pixels.width, source.width)
      assert.equal(representation.pixels.height, source.height)
      assert.equal(representation.pixels.rgbaSha256, source.rgbaSha256)
    }
    if (report.fixture.mode === 'buffer')
      assert.equal(row.preparedPixels.rgbaSha256, report.fixture.representations[0].rgbaSha256)
    if (report.platform === 'darwin') {
      if (report.fixture.mode.startsWith('path'))
        assert(
          (report.fixture.mode === 'path-2x' ? [2] : [1, 2, 3]).every((scale) =>
            row.prepared.scales.includes(scale)
          ),
          'Native path did not prepare its original Retina representations'
        )
      assert.equal(row.native.readOnly, true)
      assert.deepEqual(
        row.native.images.map((entry) => entry.format),
        ['public.png', 'public.tiff']
      )
      assert(row.native.formats.length > 0)
      assert(
        row.native.images.some((entry) => entry.bytes > 0),
        'No native PNG/TIFF readback'
      )
      for (const entry of row.native.images) {
        assert.equal(entry.declared, row.native.formats.includes(entry.format))
        assert(!entry.declared || entry.bytes > 0, 'Declared native image format was not readable')
        if (entry.bytes > 0) assert.deepEqual(entry.pixels, row.preparedPixels)
        else assert.equal(entry.pixels, null)
      }
    }
  }
  for (let sample = 0; sample < report.samples; sample++) {
    const rows = report.rows.filter((row) => row.sample === sample)
    assert.deepEqual(
      rows.map((row) => row.variant),
      sample % 2 === 0 ? VARIANTS : [...VARIANTS].reverse(),
      'Variant order was not rotated'
    )
    const [baseline, candidate] = VARIANTS.map((variant) =>
      rows.find((row) => row.variant === variant)
    )
    for (const field of [
      'prepared',
      'preparedAfter',
      'representations',
      'preparedPixels',
      'readbackPixels',
      'formats',
      'native'
    ]) {
      assert.deepEqual(candidate[field], baseline[field], `Writer compatibility differs: ${field}`)
    }
  }
  return Object.fromEntries(
    VARIANTS.map((variant) => {
      const rows = report.rows.filter((row) => row.variant === variant)
      return [
        variant,
        {
          writeMs: distribution(rows.map((row) => row.writeMs)),
          observedMainPeakRssBytes: distribution(
            rows.map((row) => row.memory.children[0].observedPeakRssBytes)
          ),
          observedMainGrowthBytes: distribution(
            rows.map((row) =>
              Math.max(0, row.memory.children[0].observedPeakRssBytes - row.rssBeforeBytes)
            )
          )
        }
      ]
    })
  )
}
