const assert = require('node:assert/strict')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { createInterface } = require('node:readline')
const { app, clipboard, nativeImage } = require('electron')

const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
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
  clipboard.clear()
  phase = 'ready'
  emit({
    type: 'ready',
    pid: process.pid,
    runtime: process.versions,
    platform: process.platform,
    arch: process.arch,
    prepared,
    isolatedUserData: true
  })
  const input = createInterface({ input: process.stdin })
  input.on('line', (line) => {
    try {
      assert(line.length < 128, 'Native command exceeded its bound')
      const command = JSON.parse(line).command
      if (command === 'write') {
        assert.equal(phase, 'ready')
        const rssBeforeBytes = process.memoryUsage.rss()
        const started = performance.now()
        if (configuration.variant === 'write-image') clipboard.writeImage(image)
        else clipboard.write({ image })
        const writeMs = performance.now() - started
        const rssAfterBytes = process.memoryUsage.rss()
        phase = 'written'
        emit({ type: 'written', writeMs, rssBeforeBytes, rssAfterBytes })
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
        emit({
          type: 'readback',
          formats,
          readback: describe(result),
          representations,
          preparedAfter: describe(image)
        })
      } else if (command === 'exit') {
        assert.equal(phase, 'readback')
        clipboard.clear()
        emit({ type: 'complete', clipboardCleared: true })
        app.exit(0)
      } else throw new Error('Unknown native command')
    } catch (error) {
      emit({ type: 'error', phase, name: error.name, message: error.message })
      clipboard.clear()
      app.exit(1)
    }
  })
}

main().catch((error) => {
  emit({ type: 'error', phase, name: error.name, message: error.message })
  app.exit(1)
})
