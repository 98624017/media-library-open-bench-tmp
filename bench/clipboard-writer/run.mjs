import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import electronPath from 'electron'
import { saveReport } from '../extended/report-file.mjs'
import { createMemorySampler } from '../extended/video-memory.mjs'
import { registerOwnedGroup, stopTree } from '../extended/termination.mjs'
import {
  EXPECTED_CHROME,
  EXPECTED_ELECTRON,
  FIXTURES,
  PROBE_SOURCES,
  SHARP_VERSIONS,
  VARIANTS,
  digest,
  inspectNativeFormat,
  inspectPixels,
  prepareFixture
} from './fixtures.mjs'
import { validateReport } from './validation.mjs'
import controlProtocol from './protocol.cjs'

const execute = promisify(execFile)
const NATIVE_DEADLINE_MS = 45000
const NATIVE_CLEANUP_MS = 5000
const { createCoordinatorControl } = controlProtocol

async function stopChild(child, closed, isClosed) {
  if (child.pid && (process.platform !== 'win32' || !isClosed()))
    await stopTree(child.pid, NATIVE_CLEANUP_MS)
  await closed
}

async function runOne({
  base,
  fixtureDirectory,
  fixture,
  variant,
  sample,
  sampler,
  macReader,
  artifactDirectory,
  checkpoint
}) {
  const directory = await mkdtemp(join(base, 'native-'))
  const userData = join(directory, 'user-data')
  await mkdir(userData)
  const config = join(directory, 'configuration.json')
  const control = await createCoordinatorControl()
  try {
    await writeFile(
      config,
      JSON.stringify({
        fixture,
        variant,
        fixtureDirectory,
        outputDirectory: directory,
        userData,
        controlEndpoint: control.endpoint
      }),
      'utf8'
    )
  } catch (error) {
    await control.close()
    throw error
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    electronPath,
    [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      fileURLToPath(new URL('./native.cjs', import.meta.url)),
      `--configuration=${config}`
    ],
    {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      timeout: NATIVE_DEADLINE_MS,
      killSignal: 'SIGKILL'
    }
  )
  let isClosed = false
  let diagnostic = ''
  const startupStdout = { bytes: 0, blankChunks: 0, nonblankChunks: 0 }
  let spawnError
  let memoryWindow
  let memoryFinished = false
  let unregisterOwnedGroup
  child.once('error', (error) => {
    spawnError = error
  })
  child.stdin.on('error', (error) => {
    spawnError = error
  })
  child.stderr.on('data', (data) => {
    diagnostic = (diagnostic + data).slice(-2500)
  })
  child.stdout.on('data', (data) => {
    startupStdout.bytes += data.length
    if (data.toString().trim()) startupStdout.nonblankChunks++
    else startupStdout.blankChunks++
  })
  const closed = new Promise((done) =>
    child.once('close', (code, signal) => {
      isClosed = true
      done({ code, signal })
    })
  )
  let timer
  const deadline = new Promise((done) => {
    timer = setTimeout(() => done({ expired: true }), NATIVE_DEADLINE_MS)
  })
  const next = async (type) => {
    const event = await Promise.race([
      control.next(type).then((message) => ({ message })),
      closed.then((exit) => ({ exit })),
      deadline
    ])
    const context = `requested ${type}; startup stdout ${JSON.stringify(startupStdout)}; ${spawnError?.message ?? diagnostic}`
    assert(!event.expired, `Native fixture exceeded its outside-process deadline: ${context}`)
    assert(!event.exit, `Native process stopped before ${type}: ${context}`)
    return event.message
  }
  const send = (command) => control.send(command)
  let row = { sample, variant, status: 'starting' }
  try {
    if (process.platform !== 'win32') unregisterOwnedGroup = await registerOwnedGroup(child.pid)
    const ready = await next('ready')
    assert.equal(ready.pid, child.pid)
    assert.equal(ready.runtime.electron, EXPECTED_ELECTRON)
    assert.equal(ready.runtime.chrome, EXPECTED_CHROME)
    row = {
      ...row,
      ...ready,
      status: 'prepared',
      controlTransport: 'loopback-tcp-jsonl',
      startupStdout: { ...startupStdout }
    }
    delete row.type
    delete row.pid
    await checkpoint(row)
    memoryWindow = await sampler.begin()
    await memoryWindow.onSpawn(child.pid)
    send('write')
    const written = await next('written')
    memoryWindow.onClose(child.pid)
    const memory = await memoryWindow.finish()
    memoryFinished = true
    row = {
      ...row,
      writeMs: written.writeMs,
      rssBeforeBytes: written.rssBeforeBytes,
      rssAfterBytes: written.rssAfterBytes,
      memory,
      status: 'written'
    }
    await checkpoint(row)
    let native = null
    const nativeBytes = new Map()
    const diagnosticFiles = []
    const retainSmallFormats =
      process.argv.includes('--diagnostic-native-formats') &&
      fixture.quick &&
      fixture.width <= 256 &&
      fixture.height <= 256
    const preserveSmallFile = async (filename, bytes) => {
      if (!retainSmallFormats) return
      assert(bytes.length <= 1024 * 1024, 'Diagnostic native image exceeded its one-MiB bound')
      await mkdir(artifactDirectory, { recursive: true })
      const target = `sample-${sample}-${variant}-${filename}`
      await writeFile(join(artifactDirectory, target), bytes, { flag: 'wx' })
      diagnosticFiles.push({
        path: `diagnostics/native-formats/${target}`,
        bytes: bytes.length,
        sha256: digest(bytes)
      })
    }
    if (process.platform === 'darwin') {
      const result = await execute(macReader, [directory], {
        timeout: 10000,
        killSignal: 'SIGKILL',
        maxBuffer: 32768
      })
      native = JSON.parse(result.stdout)
      row = { ...row, native, diagnostics: { nativeReader: native }, status: 'native-observed' }
      await checkpoint(row)
      assert.equal(native.readOnly, true)
      for (const entry of native.images) {
        if (!entry.bytes) continue
        const bytes = await readFile(join(directory, entry.filename))
        nativeBytes.set(entry.format, bytes)
        await preserveSmallFile(entry.filename, bytes)
      }
      row = { ...row, diagnostics: { ...row.diagnostics, files: [...diagnosticFiles] } }
      await checkpoint(row)
      native = {
        ...native,
        images: await Promise.all(
          native.images.map(async (entry) => {
            const pixels = entry.bytes ? await inspectPixels(nativeBytes.get(entry.format)) : null
            return { format: entry.format, declared: entry.declared, bytes: entry.bytes, pixels }
          })
        )
      }
    }
    send('readback')
    const read = await next('readback')
    const representations = await Promise.all(
      read.representations.map(async (entry) => ({
        scale: entry.scale,
        size: entry.size,
        pixels: await inspectPixels(await readFile(join(directory, entry.filename)))
      }))
    )
    const preparedBytes = await readFile(join(directory, 'prepared-1.png'))
    const readbackBytes = await readFile(join(directory, 'readback.png'))
    const preparedPixels = await inspectPixels(preparedBytes)
    const readbackPixels = await inspectPixels(readbackBytes)
    if (native) {
      await preserveSmallFile('prepared.png', preparedBytes)
      await preserveSmallFile('readback.png', readbackBytes)
      const nativeFormats = await Promise.all(
        native.images
          .filter((entry) => entry.bytes)
          .map(async (entry) => ({
            format: entry.format,
            ...(await inspectNativeFormat(nativeBytes.get(entry.format), preparedBytes))
          }))
      )
      row = {
        ...row,
        diagnostics: { ...row.diagnostics, files: [...diagnosticFiles], nativeFormats }
      }
    }
    row = {
      ...row,
      status: 'readback-observed',
      preparedAfter: read.preparedAfter,
      formats: read.formats,
      readback: read.readback,
      representations,
      preparedPixels,
      readbackPixels,
      native
    }
    await checkpoint(row)
    assert.deepEqual(
      readbackPixels,
      preparedPixels,
      'Full clipboard RGB/alpha pixels differ from the prepared bitmap'
    )
    if (fixture.mode === 'buffer')
      assert.equal(
        preparedPixels.rgbaSha256,
        fixture.representations[0].rgbaSha256,
        'Generated RGB/alpha source changed during NativeImage preparation'
      )
    assert.deepEqual(
      read.preparedAfter.size,
      ready.prepared.size,
      'Writer changed native dimensions'
    )
    for (const representation of representations) {
      const source = fixture.representations.find((entry) => entry.scale === representation.scale)
      // An explicit @2x path can infer 1x; its unrelated 1x sibling is not the decoder's source.
      if (!source || (fixture.mode === 'path-2x' && representation.scale !== 2)) continue
      assert.equal(representation.pixels.width, source.width)
      assert.equal(representation.pixels.height, source.height)
      assert.equal(
        representation.pixels.rgbaSha256,
        source.rgbaSha256,
        'Writer changed a generated source representation'
      )
    }
    for (const entry of native?.images ?? [])
      if (entry.pixels)
        assert.deepEqual(
          entry.pixels,
          preparedPixels,
          `Native ${entry.format} pixels differ from the prepared bitmap`
        )
    for (const scale of ready.prepared.scales)
      assert(
        read.preparedAfter.scales.includes(scale),
        'Writer discarded a prepared scale representation'
      )
    send('exit')
    const complete = await next('complete')
    const exit = await Promise.race([closed, deadline])
    assert(!exit.expired, 'Native process did not exit before its outside-process deadline')
    assert.equal(exit.code, 0, diagnostic)
    assert.equal(complete.clipboardCleared, true)
    return {
      ...row,
      status: 'complete',
      preparedAfter: read.preparedAfter,
      formats: read.formats,
      readback: read.readback,
      representations,
      preparedPixels,
      readbackPixels,
      native,
      clipboardCleared: true,
      checks: { pixelsMatch: true, dimensionsMatch: true, representationsPreserved: true }
    }
  } finally {
    clearTimeout(timer)
    try {
      await stopChild(child, closed, () => isClosed)
    } finally {
      await control.close()
    }
    if (memoryWindow && !memoryFinished) {
      memoryWindow.onClose(child.pid)
      await memoryWindow.finish()
    }
    await rm(directory, { recursive: true, force: true })
    if (unregisterOwnedGroup) await unregisterOwnedGroup()
  }
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name, fallback) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
  const name = option('fixture')
  const label = option('label', `${process.platform}-${process.arch}`)
  const quick = args.includes('--quick')
  const samples = Number(option('samples', quick ? '1' : '7'))
  assert(FIXTURES.includes(name) && /^[A-Za-z0-9_-]+$/.test(label))
  assert(Number.isInteger(samples) && samples >= 1 && samples <= 9)
  if (process.platform === 'darwin' && !quick) assert(samples >= 7)
  const outputDirectory = resolve(option('output', `results/clipboard-${label}-${name}`))
  const macReader = process.env.BENCH_MAC_CLIPBOARD_READER
  if (process.platform === 'darwin')
    assert(macReader, 'Missing read-only native clipboard observer')
  const path = join(outputDirectory, 'report.json')
  const base = await mkdtemp(join(tmpdir(), 'clipboard-writer-fixture-'))
  const report = {
    schemaVersion: 1,
    completed: false,
    cleanedOwnedDirectory: false,
    label,
    platform: process.platform,
    arch: process.arch,
    sourceRevision: process.env.BENCH_SOURCE_REVISION ?? null,
    samples,
    rows: [],
    adoption: 'manual-review-required',
    memoryScope:
      'Outside-process 100 ms sampling of Electron Main during the write handshake; startup, readback, helper processes, OS clipboard server and preparation are excluded. Brief peaks may be missed.'
  }
  let sampler
  try {
    await saveReport(path, report)
    const packageManifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8')
    )
    report.dependencies = {
      electron: packageManifest.devDependencies.electron,
      sharp: packageManifest.dependencies.sharp
    }
    report.sharpVersions = SHARP_VERSIONS
    if (process.platform === 'darwin') report.nativeReaderSha256 = digest(await readFile(macReader))
    report.probeSourceSha256 = Object.fromEntries(
      await Promise.all(
        PROBE_SOURCES.map(async (filename) => [
          filename,
          digest(await readFile(new URL(filename, import.meta.url)))
        ])
      )
    )
    const fixtureDirectory = join(base, 'images')
    await mkdir(fixtureDirectory)
    report.fixture = await prepareFixture(fixtureDirectory, name, quick)
    await saveReport(path, report)
    try {
      sampler = await createMemorySampler()
    } catch (error) {
      throw new Error(`Memory observer startup failed: ${error.name}: ${error.message}`, {
        cause: error
      })
    }
    assert.equal(
      sampler.metadata.prewarmSucceeded,
      true,
      'External RSS observer failed its own process read'
    )
    for (let sample = 0; sample < samples; sample++) {
      for (const variant of sample % 2 === 0 ? VARIANTS : [...VARIANTS].reverse()) {
        const position = report.rows.length
        const checkpoint = async (row) => {
          report.rows[position] = row
          await saveReport(path, report)
        }
        const row = await runOne({
          base,
          fixtureDirectory,
          fixture: report.fixture,
          variant,
          sample,
          sampler,
          macReader,
          artifactDirectory: join(outputDirectory, 'diagnostics', 'native-formats'),
          checkpoint
        })
        await checkpoint(row)
      }
    }
    await sampler.close()
    sampler = null
    await rm(base, { recursive: true, force: true })
    report.cleanedOwnedDirectory = true
    report.completed = true
    report.summary = validateReport(report)
    await saveReport(path, report)
    process.stdout.write(`${label}/${name}: ${report.rows.length} native samples verified\n`)
    return 0
  } catch (error) {
    report.completed = false
    report.error = { name: error.name, message: error.message }
    process.stderr.write(`${name}: ${error.message}\n`)
    return 1
  } finally {
    if (sampler) await sampler.abort()
    await rm(base, { recursive: true, force: true })
    report.cleanedOwnedDirectory = true
    await saveReport(path, report)
  }
}

process.exitCode = await main()
