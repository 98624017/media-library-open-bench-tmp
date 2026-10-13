import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import { Readable } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import protocol from './protocol.cjs'

const { createCoordinatorControl, connectNativeControl } = protocol

test('native writer handshake works with Windows EOF stdin/blank stdout and waits for terminal flush', async () => {
  const configuration = {
    variant: 'write-image',
    userData: '/owned/user-data',
    fixtureDirectory: '/owned/images',
    outputDirectory: '/owned/output',
    controlEndpoint: { port: 12345, nonce: '00000000-0000-0000-0000-000000000000' },
    fixture: { mode: 'buffer', representations: [{ scale: 1, filename: 'source.png' }] }
  }
  const messages = []
  const exits = []
  const commands = ['write', 'readback', 'exit']
  let releaseTerminal
  const terminalFlush = new Promise((resolve) => {
    releaseTerminal = resolve
  })
  const peer = {
    next: async () => ({ type: 'command', command: commands.shift() }),
    send: async (message) => {
      messages.push(message)
      if (message.type === 'complete') await terminalFlush
    },
    close: () => {}
  }
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 1, height: 1 }),
    getScaleFactors: () => [1],
    toPNG: () => Buffer.from('generated')
  }
  const app = {
    setPath: () => {},
    getPath: () => configuration.userData,
    commandLine: { appendSwitch: () => {} },
    on: () => {},
    whenReady: async () => {},
    exit: (code) => exits.push(code)
  }
  const realRequire = createRequire(import.meta.url)
  let writes = 0
  const injectedRequire = (name) =>
    name === 'electron'
      ? {
          app,
          clipboard: {
            clear: () => {},
            availableFormats: () => ['image/png'],
            writeImage: () => {
              writes++
            },
            readImage: () => image
          },
          nativeImage: { createFromBuffer: () => image }
        }
      : name === './protocol.cjs'
        ? { connectNativeControl: async () => peer }
        : name === 'node:fs'
          ? {
              readFileSync: (path) =>
                path.endsWith('configuration.json')
                  ? JSON.stringify(configuration)
                  : Buffer.from('generated'),
              writeFileSync: () => {},
              writeSync: () => {}
            }
          : realRequire(name)
  const stdout = []
  // Pinned Electron 39.8.3 uses an always-EOF stdin on Windows; stdout is not a protocol channel.
  runInNewContext(readFileSync(new URL('./native.cjs', import.meta.url), 'utf8'), {
    require: injectedRequire,
    Buffer,
    performance,
    process: {
      argv: ['electron', 'native.cjs', '--configuration=/owned/configuration.json'],
      stdin: Readable.from([]),
      stdout: { write: (line) => stdout.push(`\r\n${line}`) },
      stderr: { write: () => {} },
      platform: 'win32',
      arch: 'x64',
      pid: 123,
      versions: {},
      memoryUsage: { rss: () => 100 }
    }
  })
  await tick()
  assert(
    messages.some((message) => message.type === 'complete'),
    `EOF stdin prevented the control handshake: ${JSON.stringify({ messages, exits, stdout })}`
  )
  assert.equal(writes, 1)
  assert.deepEqual(exits, [], 'App exited before terminal message flush')
  releaseTerminal()
  await tick()
  assert.deepEqual(exits, [0])
  assert.equal(stdout.length, 0)
})

test('loopback control preserves queued terminal frame before EOF', async () => {
  const control = await createCoordinatorControl()
  const native = await connectNativeControl(control.endpoint)
  try {
    await native.send({ type: 'ready' })
    assert.equal((await control.next('ready')).type, 'ready')
    control.send('exit')
    assert.equal((await native.next('command')).command, 'exit')
    await native.send({ type: 'complete', clipboardCleared: true })
    native.close()
    assert.equal((await control.next('complete')).clipboardCleared, true)
    await assert.rejects(control.next('missing'), /ended without a frame before missing/)
  } finally {
    native.close()
    await control.close()
  }
})

test('blank, broken and incomplete control frames fail with requested phase and bounded shape', async () => {
  for (const payload of ['\n', '{broken}\n', '{"type":"ready"']) {
    const control = await createCoordinatorControl()
    const socket = net.connect(control.endpoint.port, '127.0.0.1')
    try {
      socket.end(`${JSON.stringify({ type: 'hello', nonce: control.endpoint.nonce })}\n${payload}`)
      await assert.rejects(
        control.next('ready'),
        (error) =>
          error.name === 'NativeProtocolError' &&
          /before ready/.test(error.message) &&
          /bytes:/.test(error.message)
      )
    } finally {
      socket.destroy()
      await control.close()
    }
  }
})
