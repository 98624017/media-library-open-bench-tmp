import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici'
import { measure, round } from '../platform/metrics.mjs'

const TRANSPORTS = ['electron-session', 'node-undici']
const MODES = ['direct', 'manual', 'pac']
const FAILURE_SCENARIOS = ['body-stall-deadline', 'mid-body-interruption', 'caller-abort']
const LARGE_BODY_BYTES = 16 * 1024 * 1024
const SMALL_BODY_BYTES = 64 * 1024
const ORIGIN_ALIAS = 'bench-origin.test'

export const PROFILES = [
  ...MODES.flatMap((scenario) => TRANSPORTS.map((variant) => ({ scenario, variant }))),
  ...['buffered-download', 'file-stream-download'].flatMap((scenario) =>
    TRANSPORTS.map((variant) => ({ scenario, variant }))
  ),
  ...FAILURE_SCENARIOS.flatMap((scenario) =>
    TRANSPORTS.map((variant) => ({ scenario, variant, samples: 1 }))
  )
]

export function parseProxyResolution(text) {
  assert(typeof text === 'string' && text.length <= 1024)
  for (const entry of text.split(';').map((value) => value.trim())) {
    if (!entry) continue
    if (entry === 'DIRECT') return { kind: 'direct' }
    const proxy = /^(?:PROXY|HTTP)\s+([^\s]+)$/i.exec(entry)
    if (proxy) {
      const url = new URL('http://' + proxy[1])
      assert(!url.username && !url.password && url.pathname === '/' && url.port)
      return { kind: 'proxy', proxyUri: url.origin }
    }
    if (/^SOCKS/i.test(entry))
      throw new Error('SOCKS resolution is outside the product HTTP proxy contract')
  }
  return { kind: 'direct' }
}

export function fixtureLookup(hostname, options, callback) {
  if (hostname !== ORIGIN_ALIAS) {
    callback(Object.assign(new Error('Unregistered synthetic origin host'), { code: 'ENOTFOUND' }))
    return
  }
  if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
  else callback(null, '127.0.0.1', 4)
}

export function abortable(pending, signal, onLateResolve) {
  return new Promise((resolve, reject) => {
    let finished = false
    const abort = () => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
    pending.then(
      (value) => {
        if (finished) {
          onLateResolve?.(value)
          return
        }
        finished = true
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        if (finished) return
        finished = true
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
    if (signal.aborted) abort()
  })
}

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function payload(bytes) {
  const block = Buffer.from(Array.from({ length: 256 }, (_, index) => index))
  const buffer = Buffer.alloc(bytes)
  for (let offset = 0; offset < bytes; offset += block.length) block.copy(buffer, offset)
  return buffer
}

function trackSocket(socket, set) {
  set.add(socket)
  socket.once('close', () => set.delete(socket))
  socket.on('error', () => {})
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  return `127.0.0.1:${address.port}`
}

async function waitForDrain(sets) {
  const deadline = performance.now() + 3000
  while (sets.some((set) => set.size > 0)) {
    assert(performance.now() < deadline, 'owned network sockets did not drain')
    await delay(20)
  }
}

async function createServers({ smallBody, largeBody }) {
  const incoming = new Set()
  const upstream = new Set()
  const originSockets = new Set()
  const proxyLocalPorts = new Set()
  const requests = new Map()
  const totals = {
    pacRequests: 0,
    connectRequests: 0,
    forwardRequests: 0,
    rejectedTargets: 0,
    unexpectedRequests: 0
  }
  let originAddress
  let proxyAddress
  const origin = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://' + originAddress)
    if (url.pathname === '/proxy.pac') {
      totals.pacRequests++
      response.writeHead(200, {
        'content-type': 'application/x-ns-proxy-autoconfig',
        'cache-control': 'no-store'
      })
      response.end(
        `function FindProxyForURL(url, host) { return url.indexOf('/probe/direct') >= 0 ? 'DIRECT' : 'PROXY ${proxyAddress}'; }`
      )
      return
    }
    const id = url.searchParams.get('case')
    if (!id || id.length > 128) {
      totals.unexpectedRequests++
      response.writeHead(400)
      response.end()
      return
    }
    const previous = requests.get(id)
    const observation = {
      count: (previous?.count ?? 0) + 1,
      route: proxyLocalPorts.has(request.socket.remotePort) ? 'proxy' : 'direct',
      bytesSent: 0,
      ended: false
    }
    requests.set(id, observation)
    const body = url.pathname === '/large' ? largeBody : smallBody
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-bench-route': observation.route
    })
    if (FAILURE_SCENARIOS.some((scenario) => url.pathname.endsWith('/' + scenario))) {
      const first = body.subarray(0, Math.min(4096, body.length - 1))
      response.write(first)
      observation.bytesSent += first.length
      let interruptionTimer
      if (url.pathname.endsWith('/mid-body-interruption')) {
        interruptionTimer = setTimeout(
          () => response.destroy(new Error('Synthetic interrupted body')),
          70
        )
      }
      response.once('close', () => clearTimeout(interruptionTimer))
    } else {
      observation.bytesSent = body.length
      observation.ended = true
      response.end(body)
    }
    request.resume()
  })
  origin.on('connection', (socket) => trackSocket(socket, originSockets))
  originAddress = await listen(origin)
  const logicalOriginAddress = `${ORIGIN_ALIAS}:${new URL('http://' + originAddress).port}`
  const allowedTarget = (url) =>
    [originAddress, logicalOriginAddress].includes(url.host) &&
    url.protocol === 'http:' &&
    !url.username &&
    !url.password
  const proxy = http.createServer((request, response) => {
    let target
    try {
      target = new URL(request.url)
    } catch {
      response.writeHead(400)
      response.end()
      return
    }
    if (!allowedTarget(target)) {
      totals.rejectedTargets++
      response.writeHead(403)
      response.end()
      return
    }
    totals.forwardRequests++
    const forward = http.request(
      {
        hostname: '127.0.0.1',
        port: target.port,
        path: target.pathname + target.search,
        method: request.method,
        headers: { ...request.headers, host: target.host },
        agent: false
      },
      (result) => {
        response.writeHead(result.statusCode, result.headers)
        result.pipe(response)
        result.once('error', () => response.destroy())
      }
    )
    forward.on('socket', (socket) => {
      trackSocket(socket, upstream)
      socket.once('connect', () => {
        const localPort = socket.localPort
        proxyLocalPorts.add(localPort)
        socket.once('close', () => proxyLocalPorts.delete(localPort))
      })
    })
    forward.once('error', () => response.destroy())
    request.pipe(forward)
    response.once('close', () => forward.destroy())
  })
  proxy.on('connection', (socket) => trackSocket(socket, incoming))
  proxy.on('connect', (request, client, head) => {
    const target = new URL('http://' + request.url)
    if (!allowedTarget(target)) {
      totals.rejectedTargets++
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    totals.connectRequests++
    const remote = net.createConnection({ host: '127.0.0.1', port: Number(target.port) })
    trackSocket(remote, upstream)
    remote.once('connect', () => {
      const localPort = remote.localPort
      proxyLocalPorts.add(localPort)
      remote.once('close', () => proxyLocalPorts.delete(localPort))
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) remote.write(head)
      client.pipe(remote)
      remote.pipe(client)
    })
    client.once('close', () => remote.destroy())
    remote.once('close', () => client.destroy())
    remote.once('error', () => client.destroy())
  })
  try {
    proxyAddress = await listen(proxy)
  } catch (error) {
    for (const socket of [...originSockets, ...incoming, ...upstream]) socket.destroy()
    await new Promise((resolve) => origin.close(resolve))
    throw error
  }
  const socketSets = [incoming, upstream, originSockets]
  return {
    originAddress,
    logicalOriginAddress,
    proxyAddress,
    requests,
    totals,
    async drain(session) {
      await session.closeAllConnections()
      for (const socket of [...incoming, ...upstream, ...originSockets]) socket.destroy()
      await waitForDrain(socketSets)
      return true
    },
    async close(session) {
      await this.drain(session)
      await Promise.all(
        [origin, proxy].map(
          (server) =>
            new Promise((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()))
            })
        )
      )
      assert.equal(totals.rejectedTargets, 0)
      assert.equal(totals.unexpectedRequests, 0)
      assert(socketSets.every((set) => set.size === 0))
    }
  }
}

async function configure(electron, mode, servers) {
  // setProxy may start PAC loading before it resolves; closing connections afterwards can abort it.
  await electron.session.defaultSession.closeAllConnections()
  const config =
    mode === 'direct'
      ? { mode: 'direct' }
      : mode === 'manual'
        ? {
            mode: 'fixed_servers',
            proxyRules: servers.proxyAddress,
            proxyBypassRules: '<-loopback>'
          }
        : {
            mode: 'pac_script',
            pacScript: `http://${servers.originAddress}/proxy.pac`,
            proxyBypassRules: '<-loopback>'
          }
  const results = await Promise.allSettled([
    electron.app.setProxy(config),
    electron.session.defaultSession.setProxy(config)
  ])
  const failures = results.filter((result) => result.status === 'rejected')
  assert.equal(
    failures.length,
    0,
    `isolated Electron proxy apply failed: ${failures.map((failure) => failure.reason.name)}`
  )
}

async function consumeRequest({
  url,
  transport,
  session,
  mode = 'buffer',
  file,
  deadlineMs = 10_000,
  signal,
  onHeaders,
  state = {}
}) {
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(new DOMException('Synthetic request deadline', 'TimeoutError')),
    deadlineMs
  )
  const abort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let dispatcher
  let response
  let failed = false
  const lateDisposals = []
  try {
    const resolutionText = await abortable(session.resolveProxy(url), controller.signal)
    const resolution = parseProxyResolution(resolutionText)
    state.resolution = resolutionText
    if (controller.signal.aborted) throw controller.signal.reason
    if (transport === 'node-undici')
      dispatcher =
        resolution.kind === 'proxy'
          ? new ProxyAgent(resolution.proxyUri)
          : new Agent({ connect: { lookup: fixtureLookup } })
    const options = {
      method: state.failureCase ? 'POST' : 'GET',
      ...(state.failureCase ? { body: 'generated-one-shot-request' } : {}),
      signal: controller.signal,
      redirect: 'error',
      headers: { 'cache-control': 'no-store' }
    }
    const pendingResponse =
      transport === 'electron-session'
        ? session.fetch(url, options)
        : undiciFetch(url, { ...options, dispatcher })
    response = await abortable(pendingResponse, controller.signal, (late) => {
      if (late.body)
        lateDisposals.push(
          late.body.cancel().catch((error) => {
            state.lateCancelError = error.name
          })
        )
    })
    state.headersReceived = true
    state.observedRoute = response.headers.get('x-bench-route')
    assert.equal(response.status, 200)
    const expectedBytes = Number(response.headers.get('content-length'))
    assert(
      Number.isInteger(expectedBytes) && expectedBytes > 0 && expectedBytes <= LARGE_BODY_BYTES
    )
    onHeaders?.()
    const pendingBody =
      mode === 'file'
        ? pipeline(Readable.fromWeb(response.body), createWriteStream(file, { flags: 'wx' }), {
            signal: controller.signal
          })
        : response.arrayBuffer()
    pendingBody.then(
      () => {
        state.nativeBodySettled = true
      },
      () => {
        state.nativeBodySettled = true
      }
    )
    const received = await abortable(pendingBody, controller.signal)
    const buffer = mode === 'file' ? null : Buffer.from(received)
    const bytes = buffer ? buffer.length : (await stat(file)).size
    assert.equal(bytes, expectedBytes)
    state.bodyFinished = true
    return { buffer, bytes, resolution: resolutionText, observedRoute: state.observedRoute }
  } catch (error) {
    failed = true
    state.errorName = error.name
    state.errorCode = error.code ?? error.cause?.code ?? null
    state.abortReason = controller.signal.aborted ? controller.signal.reason?.name : null
    throw error
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', abort)
    if (dispatcher) {
      if (failed) await dispatcher.destroy()
      else await dispatcher.close()
      state.dispatcherClosed = true
    }
    if (response?.body && !response.bodyUsed) await response.body.cancel()
    await Promise.all(lateDisposals)
  }
}

function requestObservation(servers, id, expectedRoute) {
  const observation = servers.requests.get(id)
  assert(observation, 'origin did not receive the registered request')
  assert.equal(observation.count, 1, 'request was replayed')
  assert.equal(
    observation.route,
    expectedRoute,
    'actual proxy route did not match the configured route'
  )
  return { ...observation }
}

async function routeRows({ electron, servers, sample, smallHash, emit }) {
  const transports = sample % 2 ? [...TRANSPORTS].reverse() : TRANSPORTS
  for (const mode of MODES) {
    await configure(electron, mode, servers)
    for (const transport of transports) {
      const ids = ['proxy', 'direct'].map(
        (route) => `route-${mode}-${transport}-${sample}-${route}`
      )
      const expectedRoutes =
        mode === 'direct'
          ? ['direct', 'direct']
          : mode === 'manual'
            ? ['proxy', 'proxy']
            : ['proxy', 'direct']
      const states = ids.map(() => ({}))
      let measured
      try {
        measured = await measure(async () => {
          const values = []
          for (let index = 0; index < ids.length; index++)
            values.push(
              await consumeRequest({
                url: `http://${servers.logicalOriginAddress}/probe/${index ? 'direct' : 'proxy'}?case=${ids[index]}`,
                transport,
                session: electron.session.defaultSession,
                state: states[index]
              })
            )
          return values
        })
      } catch (error) {
        throw new Error(
          `${mode}/${transport} request failed: ${error.name}:${error.message}; ${JSON.stringify({ states, proxyEvidence: servers.totals })}`,
          { cause: error }
        )
      }
      const observations = measured.value.map((result, index) => {
        return {
          ...servers.requests.get(ids[index]),
          expectedRoute: expectedRoutes[index],
          responseRoute: result.observedRoute,
          resolution: result.resolution,
          sha256: hash(result.buffer),
          bytes: result.bytes
        }
      })
      await servers.drain(electron.session.defaultSession)
      const checks = {
        completeBodies: observations.every((observation) => observation.bytes === SMALL_BODY_BYTES),
        correctHashes: observations.every((observation) => observation.sha256 === smallHash),
        actualRoutesVerified: observations.every(
          (observation) =>
            observation.route === observation.expectedRoute &&
            observation.responseRoute === observation.expectedRoute &&
            parseProxyResolution(observation.resolution).kind ===
              (observation.expectedRoute === 'proxy' ? 'proxy' : 'direct')
        ),
        noReplay: observations.every((observation) => observation.count === 1),
        scopedDispatcherReleasedAfterBody: true,
        socketsDrained: true
      }
      await emit({
        suite: 'network',
        scenario: mode,
        variant: transport,
        sample,
        workload: {
          requests: 2,
          bytesPerRequest: SMALL_BODY_BYTES,
          deadlineMs: 10_000,
          routeOrder: expectedRoutes,
          isolatedAppProxyAndDefaultSession: true
        },
        metrics: measured.metrics,
        checks,
        observations
      })
      assert(
        Object.values(checks).every((value) => value === true),
        `${mode}/${transport} route control failed: ${JSON.stringify(observations)}`
      )
    }
  }
}

async function downloadRows({ electron, servers, root, sample, largeBody, largeHash, emit }) {
  await configure(electron, 'manual', servers)
  const operations = ['buffered-download', 'file-stream-download'].flatMap((scenario) =>
    TRANSPORTS.map((transport) => ({ scenario, transport }))
  )
  if (sample % 2) operations.reverse()
  for (const { scenario, transport } of operations) {
    const id = `large-${scenario}-${transport}-${sample}`
    const file = join(root, id + '.bin')
    const measured = await measure(() =>
      consumeRequest({
        url: `http://${servers.logicalOriginAddress}/large?case=${id}`,
        transport,
        session: electron.session.defaultSession,
        mode: scenario === 'file-stream-download' ? 'file' : 'buffer',
        file
      })
    )
    const actual = measured.value.buffer ?? (await readFile(file))
    assert.equal(actual.length, largeBody.length)
    assert.equal(hash(actual), largeHash)
    const observation = requestObservation(servers, id, 'proxy')
    assert.equal(measured.value.observedRoute, 'proxy')
    await servers.drain(electron.session.defaultSession)
    await emit({
      suite: 'network',
      scenario,
      variant: transport,
      sample,
      workload: {
        requests: 1,
        bytesPerRequest: largeBody.length,
        route: 'manual proxy',
        deadlineMs: 10_000,
        consumption:
          scenario === 'file-stream-download' ? 'web-to-file pipeline' : 'Response.arrayBuffer'
      },
      metrics: measured.metrics,
      checks: {
        completeBody: true,
        correctHash: true,
        noReplay: true,
        actualRouteVerified: true,
        scopedDispatcherReleasedAfterBody: true,
        socketsDrained: true
      },
      observation: {
        ...observation,
        bytes: actual.length,
        sha256: largeHash,
        resolution: measured.value.resolution
      }
    })
    if (scenario === 'file-stream-download') await rm(file)
  }
}

async function failureRows({ electron, servers, emit }) {
  await configure(electron, 'manual', servers)
  for (const scenario of FAILURE_SCENARIOS)
    for (const transport of TRANSPORTS) {
      const id = `${scenario}-${transport}`
      const controller = new AbortController()
      const state = { failureCase: true, nativeBodySettled: false }
      const deadlineMs = scenario === 'body-stall-deadline' ? 700 : 3000
      let cancelTimer
      let rejected = false
      const startedAt = performance.now()
      try {
        await consumeRequest({
          url: `http://${servers.logicalOriginAddress}/failure/${scenario}?case=${id}`,
          transport,
          session: electron.session.defaultSession,
          deadlineMs,
          signal: controller.signal,
          state,
          onHeaders: () => {
            if (scenario === 'caller-abort')
              cancelTimer = setTimeout(
                () =>
                  controller.abort(new DOMException('Synthetic caller cancellation', 'AbortError')),
                100
              )
          }
        })
      } catch {
        rejected = true
      } finally {
        clearTimeout(cancelTimer)
      }
      const completionMs = round(performance.now() - startedAt)
      const observation = requestObservation(servers, id, 'proxy')
      await servers.drain(electron.session.defaultSession)
      await delay(20)
      const checks = {
        rejected,
        headersReceived: state.headersReceived === true,
        partialBodyNotDelivered: state.bodyFinished !== true,
        partialBodyActuallySent:
          observation.bytesSent > 0 && observation.bytesSent < SMALL_BODY_BYTES,
        noReplay: observation.count === 1,
        socketsDrained: true,
        dispatcherClosed: transport === 'electron-session' || state.dispatcherClosed === true,
        nativeBodySettled: state.nativeBodySettled === true
      }
      if (scenario === 'body-stall-deadline')
        checks.deadlineCoversBody =
          state.abortReason === 'TimeoutError' &&
          completionMs >= deadlineMs - 30 &&
          completionMs < deadlineMs + 1500
      if (scenario === 'caller-abort')
        checks.callerCancellationPreserved = state.abortReason === 'AbortError'
      await emit({
        suite: 'network',
        scenario,
        variant: transport,
        sample: 0,
        workload: {
          requests: 1,
          method: 'POST',
          expectedBytes: SMALL_BODY_BYTES,
          route: 'manual proxy',
          deadlineMs
        },
        metrics: null,
        checks,
        observation: { completionMs, ...observation, ...state }
      })
      assert(
        Object.values(checks).every((value) => value === true),
        `${scenario}/${transport} failed its control checks`
      )
    }
}

export async function runBench({ base, quick = false, sampleCount = 3, emit, electron }) {
  assert(Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 5)
  assert(typeof emit === 'function')
  assert(electron?.app?.isReady() && electron.session?.defaultSession)
  assert(typeof electron.app.setProxy === 'function')
  const root = await mkdtemp(join(base, 'network-owned-'))
  const smallBody = payload(SMALL_BODY_BYTES)
  const largeBody = payload(quick ? 1024 * 1024 : LARGE_BODY_BYTES)
  const smallHash = hash(smallBody)
  const largeHash = hash(largeBody)
  let servers
  try {
    servers = await createServers({ smallBody, largeBody })
    for (let sample = 0; sample < sampleCount; sample++) {
      await routeRows({ electron, servers, sample, smallHash, emit })
      await downloadRows({ electron, servers, root, sample, largeBody, largeHash, emit })
    }
    await failureRows({ electron, servers, emit })
    return {
      profiles: PROFILES.length,
      expectedRows: 10 * sampleCount + 6,
      checks: {
        allBodiesValidated: true,
        allFailureControlsRejected: true,
        noReplay: true,
        ownedServersClosed: true,
        ownedSocketsDrained: true,
        ownedRootCleaned: true
      },
      proxyEvidence: { ...servers.totals },
      syntheticOriginHost: ORIGIN_ALIAS,
      calibration:
        'Fresh Electron app/defaultSession; controlled PAC resolves Node Undici ProxyAgent; deadline begins before resolution and spans complete body. Scoped dispatchers released after body completion/cancellation.',
      limitations: [
        'Loopback HTTP only; simulated PAC configuration is not actual OS system proxy validation.',
        'No HTTPS/TLS, SOCKS, DNS rebinding, public target validation, real network, updater, Worker or paid API.',
        'Scoped dispatchers differ from the product shared agent cache; no claim about settings rollback or live cached agent retirement.',
        'Main metrics include generated origin/proxy work and exclude Chromium network process CPU/RSS.',
        'Explicit loopback bypass removal is a fixture requirement, not a proposed product proxy setting.'
      ]
    }
  } finally {
    try {
      if (servers) await configure(electron, 'direct', servers)
    } finally {
      try {
        if (servers) await servers.close(electron.session.defaultSession)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
}
