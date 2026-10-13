import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as io from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { basename, extname, join, relative, sep } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import { measure, pool, round } from './metrics.mjs'

const KIB = 1024
const MIB = KIB * KIB
const COPY_MARKER = '.synthetic-copy-pending'
const COPY_CONCURRENCY = 4

async function exists(path) {
  try {
    await io.access(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// Wait for every admitted write before failure cleanup removes its destination.
async function drainedPool(items, concurrency, worker) {
  let failed = false
  let failure
  await pool(items, concurrency, async (item, index) => {
    if (failed) return
    try {
      await worker(item, index)
    } catch (error) {
      if (!failed) failure = error
      failed = true
    }
  })
  if (failed) throw failure
}

function numberedPath(directory, name, suffix) {
  const extension = extname(name)
  const stem = basename(name, extension)
  return join(directory, suffix === 0 ? name : `${stem}_${suffix}${extension}`)
}

function saveSync(directory, item) {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true })
  let suffix = 0
  while (fs.existsSync(numberedPath(directory, item.name, suffix))) suffix++
  const path = numberedPath(directory, item.name, suffix)
  fs.writeFileSync(path, item.buffer)
  return path
}

async function saveAsync(directory, item) {
  if (!(await exists(directory))) await io.mkdir(directory, { recursive: true })
  let suffix = 0
  while (await exists(numberedPath(directory, item.name, suffix))) suffix++
  const path = numberedPath(directory, item.name, suffix)
  await io.writeFile(path, item.buffer)
  return path
}

async function saveBuffers(directory, items, variant) {
  if (variant === 'baseline-sync')
    return items.map((item) => saveSync(directory, item))
  const paths = []
  const concurrency =
    variant === 'hypothetical-async-sequential' ? 1 : COPY_CONCURRENCY
  await drainedPool(items, concurrency, async (item, index) => {
    paths[index] = await saveAsync(directory, item)
  })
  return paths
}

async function fileDigest(path) {
  const digest = createHash('sha256')
  for await (const chunk of fs.createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

async function snapshot(directory) {
  const entries = []
  async function visit(current) {
    for (const entry of await io.readdir(current, { withFileTypes: true })) {
      if (entry.name === COPY_MARKER) continue
      const path = join(current, entry.name)
      const name = relative(directory, path).split(sep).join('/')
      if (entry.isDirectory()) {
        entries.push({ path: name, kind: 'directory' })
        await visit(path)
      } else {
        assert(
          entry.isFile(),
          'Generated fixtures must contain only regular files/directories'
        )
        entries.push({
          path: name,
          kind: 'file',
          size: (await io.stat(path)).size,
          sha256: await fileDigest(path)
        })
      }
    }
  }
  await visit(directory)
  entries.sort((left, right) => left.path.localeCompare(right.path))
  return {
    fileCount: entries.filter((entry) => entry.kind === 'file').length,
    directoryCount: entries.filter((entry) => entry.kind === 'directory')
      .length,
    bytes: entries.reduce((total, entry) => total + (entry.size ?? 0), 0),
    sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex')
  }
}

function verifyKindsAndSize(source, target) {
  if (source.isDirectory())
    assert(target.isDirectory(), 'Copied directory kind differs')
  else {
    assert(target.isFile(), 'Copied file kind differs')
    assert.equal(target.size, source.size, 'Copied file size differs')
  }
}

// Timed migration verification intentionally checks kind/size, not file contents.
function verifySync(source, target) {
  for (const name of fs.readdirSync(source)) {
    if (name === COPY_MARKER) continue
    const sourcePath = join(source, name)
    const targetPath = join(target, name)
    assert(fs.existsSync(targetPath), 'Copied entry is missing')
    const sourceInfo = fs.statSync(sourcePath)
    verifyKindsAndSize(sourceInfo, fs.statSync(targetPath))
    if (sourceInfo.isDirectory()) verifySync(sourcePath, targetPath)
  }
}

async function discoverTree(source, target) {
  const entries = []
  async function visit(from, to) {
    for (const entry of await io.readdir(from, { withFileTypes: true })) {
      if (entry.name === COPY_MARKER) continue
      const fromPath = join(from, entry.name)
      const toPath = join(to, entry.name)
      entries.push({
        from: fromPath,
        to: toPath,
        directory: entry.isDirectory()
      })
      if (entry.isDirectory()) await visit(fromPath, toPath)
    }
  }
  await visit(source, target)
  return entries
}

async function verifyAsync(source, target) {
  const entries = await discoverTree(source, target)
  await drainedPool(entries, COPY_CONCURRENCY, async (entry) => {
    await io.access(entry.to)
    const [sourceInfo, targetInfo] = await Promise.all([
      io.stat(entry.from),
      io.stat(entry.to)
    ])
    verifyKindsAndSize(sourceInfo, targetInfo)
  })
}

async function copyBounded(source, target, { signal, onCopied } = {}) {
  const entries = await discoverTree(source, target)
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (entry.directory) await io.mkdir(entry.to, { recursive: true })
  }
  let copied = 0
  await drainedPool(
    entries.filter((entry) => !entry.directory),
    COPY_CONCURRENCY,
    async (entry) => {
      signal?.throwIfAborted()
      await io.copyFile(entry.from, entry.to)
      onCopied?.(++copied)
    }
  )
  signal?.throwIfAborted()
}

function migrateSync(source, target, { afterCopy } = {}) {
  const existed = fs.existsSync(target)
  if (existed)
    assert.equal(fs.readdirSync(target).length, 0, 'Target must be empty')
  const marker = join(source, COPY_MARKER)
  fs.writeFileSync(marker, 'synthetic in-progress marker', { flag: 'wx' })
  try {
    fs.mkdirSync(target, { recursive: true })
    const copyStarted = performance.now()
    fs.cpSync(source, target, {
      recursive: true,
      filter: (path) => basename(path) !== COPY_MARKER
    })
    const copyMs = performance.now() - copyStarted
    afterCopy?.(target)
    const verifyStarted = performance.now()
    verifySync(source, target)
    return {
      copyMs: round(copyMs),
      verificationMs: round(performance.now() - verifyStarted)
    }
  } catch (error) {
    if (existed) {
      for (const name of fs.readdirSync(target))
        fs.rmSync(join(target, name), { recursive: true, force: true })
    } else fs.rmSync(target, { recursive: true, force: true })
    throw error
  } finally {
    fs.rmSync(marker)
  }
}

async function migrateAsync(source, target, variant, hooks = {}) {
  const existed = await exists(target)
  if (existed)
    assert.equal((await io.readdir(target)).length, 0, 'Target must be empty')
  const marker = join(source, COPY_MARKER)
  await io.writeFile(marker, 'synthetic in-progress marker', { flag: 'wx' })
  try {
    await io.mkdir(target, { recursive: true })
    const copyStarted = performance.now()
    if (variant === 'hypothetical-async-cp') {
      await io.cp(source, target, {
        recursive: true,
        filter: (path) => basename(path) !== COPY_MARKER
      })
    } else await copyBounded(source, target, hooks)
    const copyMs = performance.now() - copyStarted
    await hooks.afterCopy?.(target)
    const verifyStarted = performance.now()
    await verifyAsync(source, target)
    return {
      copyMs: round(copyMs),
      verificationMs: round(performance.now() - verifyStarted)
    }
  } catch (error) {
    if (existed) {
      for (const name of await io.readdir(target))
        await io.rm(join(target, name), { recursive: true, force: true })
    } else await io.rm(target, { recursive: true, force: true })
    throw error
  } finally {
    await io.rm(marker)
  }
}

function migration(source, target, variant, hooks) {
  return variant === 'baseline-sync'
    ? migrateSync(source, target, hooks)
    : migrateAsync(source, target, variant, hooks)
}

function payloadItems(count, size) {
  const buffer = randomBytes(size)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  return Array.from({ length: count }, (_, index) => ({
    name: `résultat 素材 ${index}.dat`,
    buffer,
    sha256
  }))
}

async function verifyPayloads(paths, items) {
  assert.equal(paths.length, items.length)
  for (let index = 0; index < paths.length; index++) {
    assert.equal((await io.stat(paths[index])).size, items[index].buffer.length)
    assert.equal(await fileDigest(paths[index]), items[index].sha256)
  }
}

async function runSamples({
  root,
  scenario,
  variants,
  sampleCount,
  metadata,
  prepare,
  operation,
  check,
  emit
}) {
  let rowCount = 0
  for (let sample = 1; sample <= sampleCount; sample++) {
    const offset = (sample - 1) % variants.length
    const ordered = [...variants.slice(offset), ...variants.slice(0, offset)]
    for (const [order, variant] of ordered.entries()) {
      const directory = await io.mkdtemp(join(root, `${scenario}-`))
      try {
        const context = await prepare(directory)
        const { value, metrics } = await measure(() =>
          operation(context, variant)
        )
        const checks = await check(context, value)
        await emit({
          suite: 'file-io',
          scenario,
          variant,
          sample,
          order: order + 1,
          ...metadata,
          cacheState: 'fresh-destination-generated-inputs-no-os-cache-reset',
          metrics: {
            ...metrics,
            ...(scenario === 'migration-tree' ? value : {}),
            megabytesPerSecond: round(
              metadata.bytes / MIB / (metrics.wallMs / 1000)
            )
          },
          checks
        })
        rowCount++
      } finally {
        await io.rm(directory, { recursive: true, force: true })
      }
    }
  }
  return rowCount
}

async function benchSave(root, quick, sampleCount, emit, large) {
  const items = payloadItems(
    large ? (quick ? 2 : 4) : quick ? 12 : 100,
    large ? (quick ? MIB : 16 * MIB) : 64 * KIB
  )
  const seeded = large
    ? []
    : [
        items[0].name,
        basename(numberedPath('', items[0].name, 1)),
        items[1].name
      ]
  const oldBytes = Buffer.from('preserve pre-existing collision')
  return runSamples({
    root,
    scenario: large ? 'save-large-burst' : 'save-small-burst',
    sampleCount,
    emit,
    variants: [
      'baseline-sync',
      'hypothetical-async-sequential',
      'hypothetical-async-bounded-4'
    ],
    metadata: {
      fileCount: items.length,
      bytes: items.length * items[0].buffer.length,
      payloadSizeBytes: items[0].buffer.length,
      seededCollisions: seeded.length,
      scope:
        'pre-buffered-output-directory-check-name-allocation-write-no-fsync'
    },
    prepare: async (directory) => {
      const target = join(
        directory,
        'outputs with spaces',
        '2026-01-01',
        '素材'
      )
      if (seeded.length) {
        await io.mkdir(target, { recursive: true })
        for (const name of seeded)
          await io.writeFile(join(target, name), oldBytes)
      }
      return { target }
    },
    operation: ({ target }, variant) => saveBuffers(target, items, variant),
    check: async ({ target }, paths) => {
      await verifyPayloads(paths, items)
      for (const [index, item] of items.entries()) {
        const suffix = seeded.length && index < 2 ? 2 - index : 0
        assert.equal(paths[index], numberedPath(target, item.name, suffix))
      }
      for (const name of seeded)
        assert.deepEqual(await io.readFile(join(target, name)), oldBytes)
      assert.equal(
        (await io.readdir(target)).length,
        items.length + seeded.length
      )
      assert.equal(new Set(paths).size, items.length)
      return {
        contentMatches: true,
        fileCountMatches: true,
        seededFilesPreserved: true,
        namesAndCollisionSuffixesMatch: true,
        uniqueDestinations: true
      }
    }
  })
}

async function importBurst(target, items, thumbnail, variant) {
  const synchronous = variant === 'baseline-sync-batches-2'
  const concurrency = variant === 'hypothetical-async-batches-4' ? 4 : 2
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const batch = items.slice(offset, offset + concurrency)
    // An immediate boundary represents thumbnail completion; decoding is measured separately.
    const outcomes = await Promise.allSettled(
      batch.map(async (item) => {
        const original = join(target, 'originals', item.name)
        const preview = join(target, 'previews', item.name)
        if (synchronous) fs.copyFileSync(item.source, original)
        else await io.copyFile(item.source, original)
        await immediate()
        if (synchronous) fs.writeFileSync(preview, thumbnail.buffer)
        else await io.writeFile(preview, thumbnail.buffer)
      })
    )
    const failure = outcomes.find((outcome) => outcome.status === 'rejected')
    if (failure) throw failure.reason
  }
}

async function benchImport(root, quick, sampleCount, emit) {
  const items = payloadItems(quick ? 6 : 40, quick ? 128 * KIB : 2 * MIB)
  const thumbnail = payloadItems(1, quick ? 4 * KIB : 64 * KIB)[0]
  const source = join(root, 'import sources café')
  await io.mkdir(source)
  await drainedPool(items, COPY_CONCURRENCY, async (item) =>
    io.writeFile(join(source, item.name), item.buffer)
  )
  const sources = items.map((item) => ({
    ...item,
    source: join(source, item.name)
  }))
  const originalSnapshot = await snapshot(source)
  return runSamples({
    root,
    scenario: 'import-original-plus-preview',
    sampleCount,
    emit,
    variants: [
      'baseline-sync-batches-2',
      'hypothetical-async-batches-2',
      'hypothetical-async-batches-4'
    ],
    metadata: {
      fileCount: items.length * 2,
      sourceFileCount: items.length,
      bytes: items.length * (items[0].buffer.length + thumbnail.buffer.length),
      payloadSizeBytes: items[0].buffer.length,
      thumbnailSizeBytes: thumbnail.buffer.length,
      scope:
        'copy-original-then-write-precomputed-preview-with-yield-no-decode-db-or-fsync'
    },
    prepare: async (directory) => {
      await io.mkdir(join(directory, 'originals'))
      await io.mkdir(join(directory, 'previews'))
      return { target: directory }
    },
    operation: ({ target }, variant) =>
      importBurst(target, sources, thumbnail, variant),
    check: async ({ target }) => {
      await verifyPayloads(
        items.map((item) => join(target, 'originals', item.name)),
        items
      )
      await verifyPayloads(
        items.map((item) => join(target, 'previews', item.name)),
        items.map((item) => ({ ...item, ...thumbnail }))
      )
      assert.equal((await snapshot(target)).fileCount, items.length * 2)
      assert.deepEqual(await snapshot(source), originalSnapshot)
      return {
        contentMatches: true,
        fileCountMatches: true,
        sourcePreserved: true
      }
    }
  })
}

async function benchMigration(root, quick, sampleCount, emit) {
  const source = join(root, 'migration source café 空格')
  const smallCount = quick ? 24 : 1200
  const small = randomBytes(4 * KIB)
  const large = randomBytes(quick ? 2 * MIB : 32 * MIB)
  await io.mkdir(source)
  const directories = Array.from({ length: quick ? 4 : 60 }, (_, index) =>
    join(source, 'dated media', `set ${index}`, '素材')
  )
  for (const directory of directories)
    await io.mkdir(directory, { recursive: true })
  await drainedPool(
    Array.from({ length: smallCount }, (_, index) => index),
    COPY_CONCURRENCY,
    async (index) =>
      io.writeFile(
        join(directories[index % directories.length], `café ${index}.dat`),
        small
      )
  )
  await io.writeFile(join(source, 'large media.dat'), large)
  await io.mkdir(join(source, 'empty directory 空'))
  const expected = await snapshot(source)
  return runSamples({
    root,
    scenario: 'migration-tree',
    sampleCount,
    emit,
    variants: [
      'baseline-sync',
      'hypothetical-async-cp',
      'hypothetical-async-bounded-4'
    ],
    metadata: {
      fileCount: expected.fileCount,
      directoryCount: expected.directoryCount,
      bytes: expected.bytes,
      smallFileSizeBytes: small.length,
      largeFileSizeBytes: large.length,
      scope:
        'copy-regular-tree-marker-exclusion-and-full-kind-size-verification-no-db-rewrite-or-root-commit'
    },
    prepare: async (directory) => ({
      target: join(directory, 'migration target 空格')
    }),
    operation: ({ target }, variant) => migration(source, target, variant),
    check: async ({ target }) => {
      const actual = await snapshot(target)
      assert.deepEqual(actual, expected)
      assert.deepEqual(await snapshot(source), expected)
      assert.equal(await exists(join(source, COPY_MARKER)), false)
      assert.equal(await exists(join(target, COPY_MARKER)), false)
      return {
        contentMatches: true,
        fileCountMatches: true,
        sourcePreserved: true,
        emptyDirectoriesPreserved: true,
        markerExcludedAndRemoved: true,
        copiedTreeSha256: actual.sha256
      }
    }
  })
}

async function contractChecks(root) {
  const directory = await io.mkdtemp(join(root, 'contracts-'))
  const source = join(directory, 'source café 空格')
  await io.mkdir(source)
  const buffer = Buffer.from('generated source bytes')
  for (let index = 0; index < 12; index++)
    await io.writeFile(join(source, `${index}.dat`), buffer)
  const expected = await snapshot(source)
  for (const variant of [
    'baseline-sync',
    'hypothetical-async-cp',
    'hypothetical-async-bounded-4'
  ]) {
    const target = join(directory, variant)
    await io.mkdir(target)
    const hooks = {
      afterCopy: (copied) =>
        fs.writeFileSync(join(copied, '0.dat'), 'wrong size')
    }
    await assert.rejects(
      async () => migration(source, target, variant, hooks),
      /size differs/
    )
    assert.deepEqual(await io.readdir(target), [])
    assert.equal(await exists(join(source, COPY_MARKER)), false)
    assert.deepEqual(await snapshot(source), expected)
    await io.writeFile(join(target, 'preserve.dat'), buffer)
    await assert.rejects(
      async () => migration(source, target, variant),
      /must be empty/
    )
    assert.deepEqual(await io.readFile(join(target, 'preserve.dat')), buffer)
  }
  const controller = new AbortController()
  const cancelledTarget = join(directory, 'cancelled target')
  let copied = 0
  await assert.rejects(
    migrateAsync(source, cancelledTarget, 'hypothetical-async-bounded-4', {
      signal: controller.signal,
      onCopied: (count) => {
        copied = count
        if (count === 1) controller.abort(new Error('synthetic cancellation'))
      }
    }),
    /synthetic cancellation/
  )
  await immediate()
  assert(copied > 0 && copied < expected.fileCount)
  assert.equal(await exists(cancelledTarget), false)
  assert.equal(await exists(join(source, COPY_MARKER)), false)
  assert.deepEqual(await snapshot(source), expected)

  const target = join(directory, 'verification controls')
  await io.cp(source, target, { recursive: true })
  await io.writeFile(join(target, '0.dat'), Buffer.alloc(buffer.length, 7))
  verifySync(source, target)
  await verifyAsync(source, target)
  assert.notEqual((await snapshot(target)).sha256, expected.sha256)
  await io.rm(join(target, '0.dat'))
  assert.throws(() => verifySync(source, target), /missing/)
  await assert.rejects(verifyAsync(source, target), { code: 'ENOENT' })
  await io.mkdir(join(target, '0.dat'))
  assert.throws(() => verifySync(source, target), /kind differs/)
  await assert.rejects(verifyAsync(source, target), /kind differs/)
  return {
    failureRollbackPreservesExistingEmptyDirectory: true,
    nonemptyTargetRejectedWithoutMutation: true,
    cancellationDrainsWritesBeforeCleanup: true,
    sourcePreserved: true,
    missingWrongSizeAndWrongKindRejected: true,
    sameSizeContentCorruptionOutsideTimedVerificationDetectedByDigest: true
  }
}

export async function runFileIoBench({
  base,
  quick = false,
  sampleCount = 3,
  emit
}) {
  assert(typeof base === 'string' && base.length > 0)
  assert(Number.isInteger(sampleCount) && sampleCount > 0 && sampleCount <= 5)
  assert.equal(typeof emit, 'function')
  await io.mkdir(base, { recursive: true })
  const root = await io.mkdtemp(join(base, 'file-io-'))
  let summary
  try {
    const checks = await contractChecks(root)
    let rowCount = await benchSave(root, quick, sampleCount, emit, false)
    rowCount += await benchSave(root, quick, sampleCount, emit, true)
    rowCount += await benchImport(root, quick, sampleCount, emit)
    rowCount += await benchMigration(root, quick, sampleCount, emit)
    summary = { summary: { rowCount, scenarioCount: 4, sampleCount }, checks }
  } finally {
    await io.rm(root, { recursive: true, force: true })
  }
  return {
    ...summary,
    checks: {
      ...summary.checks,
      ownedTemporaryRootCleaned: !(await exists(root))
    }
  }
}
