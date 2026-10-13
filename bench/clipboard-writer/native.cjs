const assert = require('node:assert/strict')
const { readFileSync, writeFileSync, writeSync } = require('node:fs')
const { join } = require('node:path')
const { app, clipboard, nativeImage } = require('electron')
const { connectNativeControl } = require('./protocol.cjs')

let control
const emit = (message) => control.send(message)
const describe = (image) => ({
  size: image.getSize(),
  scales: image.getScaleFactors().sort((a, b) => a - b)
})
let phase = 'starting'

async function main() {
  const argument = process.argv.find((value) => value.startsWith('--configuration='))
  assert(argument, 'Missing named native configuration argument')
  const configuration = JSON.parse(readFileSync(argument.slice('--configuration='.length), 'utf8'))
  assert(['write-image', 'write-dictionary'].includes(configuration.variant))
  app.setPath('userData', configuration.userData)
  app.commandLine.appendSwitch('disable-gpu')
  app.on('before-quit', (event) => event.preventDefault())
  await app.whenReady()
  assert.equal(app.getPath('userData'), configuration.userData)
  const fixture = configuration.fixture
  const source = fixture.representations.find(
    (entry) => entry.scale === (fixture.mode === 'path-2x' ? 2 : 1)
  )
  const sourcePath = join(configuration.fixtureDirectory, source.filename)
  const image =
    fixture.mode === 'buffer'
      ? nativeImage.createFromBuffer(readFileSync(sourcePath))
      : nativeImage.createFromPath(sourcePath)
  assert(!image.isEmpty(), 'Generated NativeImage preparation failed')
  const prepared = describe(image)
  control = await connectNativeControl(configuration.controlEndpoint)
  clipboard.clear()
  phase = 'ready'
  await emit({
    type: 'ready',
    pid: process.pid,
    runtime: process.versions,
    platform: process.platform,
    arch: process.arch,
    prepared,
    isolatedUserData: true
  })
  while (true) {
    try {
      const { command } = await control.next('command')
      if (command === 'write') {
        assert.equal(phase, 'ready')
        const rssBeforeBytes = process.memoryUsage.rss()
        const started = performance.now()
        if (configuration.variant === 'write-image') clipboard.writeImage(image)
        else clipboard.write({ image })
        const writeMs = performance.now() - started
        const rssAfterBytes = process.memoryUsage.rss()
        phase = 'written'
        await emit({ type: 'written', writeMs, rssBeforeBytes, rssAfterBytes })
      } else if (command === 'readback') {
        assert.equal(phase, 'written')
        const formats = clipboard.availableFormats().sort()
        const result = clipboard.readImage()
        assert(!result.isEmpty(), 'Clipboard returned an empty image')
        writeFileSync(join(configuration.outputDirectory, 'readback.png'), result.toPNG())
        const representations = image
          .getScaleFactors()
          .sort((a, b) => a - b)
          .map((scale) => {
            const filename = `prepared-${scale}.png`
            writeFileSync(
              join(configuration.outputDirectory, filename),
              image.toPNG({ scaleFactor: scale })
            )
            return { scale, size: image.getSize(scale), filename }
          })
        if (!representations.some((entry) => entry.scale === 1)) {
          writeFileSync(
            join(configuration.outputDirectory, 'prepared-1.png'),
            image.toPNG({ scaleFactor: 1 })
          )
        }
        phase = 'readback'
        await emit({
          type: 'readback',
          formats,
          readback: describe(result),
          representations,
          preparedAfter: describe(image)
        })
      } else if (command === 'exit') {
        assert.equal(phase, 'readback')
        clipboard.clear()
        await emit({ type: 'complete', clipboardCleared: true })
        control.close()
        app.exit(0)
        return
      } else throw new Error('Unknown native command')
    } catch (error) {
      await emit({ type: 'error', phase, name: error.name, message: error.message })
      clipboard.clear()
      control.close()
      app.exit(1)
      return
    }
  }
}

main().catch(async (error) => {
  const failure = { type: 'error', phase, name: error.name, message: error.message }
  try {
    if (control) await emit(failure)
    else writeSync(2, `${JSON.stringify(failure)}\n`)
  } catch (transportError) {
    writeSync(
      2,
      `${JSON.stringify({ ...failure, transportError: transportError.code ?? transportError.name })}\n`
    )
  }
  control?.close()
  app.exit(1)
})
