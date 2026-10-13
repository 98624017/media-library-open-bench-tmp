import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { abortable, fixtureLookup, parseProxyResolution, PROFILES } from './network.mjs'

test('HTTP/PAC resolution preserves candidate order and rejects unsupported SOCKS', () => {
  assert.deepEqual(parseProxyResolution('DIRECT; PROXY 127.0.0.1:1234'), { kind: 'direct' })
  assert.deepEqual(parseProxyResolution('PROXY 127.0.0.1:1234; DIRECT'), {
    kind: 'proxy',
    proxyUri: 'http://127.0.0.1:1234'
  })
  assert.deepEqual(parseProxyResolution('HTTP localhost:1234'), {
    kind: 'proxy',
    proxyUri: 'http://localhost:1234'
  })
  assert.throws(() => parseProxyResolution('SOCKS5 localhost:1234; DIRECT'))
  assert.throws(() => parseProxyResolution('PROXY user:password@localhost:1234'))
})

test('abort settles before late resolution and late resource is disposed exactly once', async () => {
  const controller = new AbortController()
  let releaseCount = 0
  const resource = { name: 'generated-resource' }
  const result = abortable(delay(35, resource), controller.signal, (late) => {
    assert.equal(late, resource)
    releaseCount++
  })
  controller.abort(new DOMException('Synthetic deadline', 'TimeoutError'))
  await assert.rejects(result, (error) => error.name === 'TimeoutError')
  await delay(50)
  assert.equal(releaseCount, 1)
})

test('late rejection remains handled after cancellation', async () => {
  const controller = new AbortController()
  const lateFailure = delay(25).then(() => {
    throw new Error('Generated late failure')
  })
  const pending = abortable(lateFailure, controller.signal)
  controller.abort(new DOMException('Cancelled', 'AbortError'))
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  await delay(40)
})

test('sixteen profiles produce ten rows per sample and six once-only controls', () => {
  assert.equal(PROFILES.filter((profile) => profile.samples === undefined).length, 10)
  assert.equal(PROFILES.filter((profile) => profile.samples === 1).length, 6)
  assert.equal(
    new Set(PROFILES.map((profile) => profile.scenario + '/' + profile.variant)).size,
    16
  )
})

test('fixture DNS maps only its registered alias and supports both lookup result shapes', () => {
  fixtureLookup('bench-origin.test', {}, (error, address, family) => {
    assert.equal(error, null)
    assert.equal(address, '127.0.0.1')
    assert.equal(family, 4)
  })
  fixtureLookup('bench-origin.test', { all: true }, (error, addresses) => {
    assert.equal(error, null)
    assert.deepEqual(addresses, [{ address: '127.0.0.1', family: 4 }])
  })
  fixtureLookup('unregistered.test', {}, (error) => assert.equal(error.code, 'ENOTFOUND'))
})
