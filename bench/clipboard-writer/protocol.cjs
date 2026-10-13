const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { once } = require('node:events')
const net = require('node:net')

const MAX_FRAME_BYTES = 32768
const MAX_BUFFERED_FRAMES = 8

function protocolError(phase, detail, line = '') {
  const error = new Error(
    `Native control ${detail} before ${phase} (line kind: ${line.trim() ? 'nonblank' : 'blank'}; bytes: ${Buffer.byteLength(line)})`
  )
  error.name = 'NativeProtocolError'
  return error
}

function createPeer(socket) {
  socket.setEncoding('utf8')
  socket.setNoDelay(true)
  let buffer = ''
  const frames = []
  let failure
  let ended = false
  let pending
  const settle = () => {
    if (!pending) return
    const request = pending
    if (failure) {
      pending = null
      request.reject(protocolError(request.phase, failure))
      return
    }
    if (frames.length) {
      pending = null
      const line = frames.shift()
      try {
        const message = JSON.parse(line)
        assert(
          message && typeof message === 'object' && message.type === request.phase,
          'Unexpected control phase'
        )
        request.resolve(message)
      } catch {
        request.reject(protocolError(request.phase, 'received invalid JSON/phase', line))
      }
      return
    }
    if (ended) {
      pending = null
      request.reject(
        protocolError(
          request.phase,
          buffer ? 'ended with a truncated frame' : 'ended without a frame',
          buffer
        )
      )
    }
  }
  socket.on('data', (chunk) => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES * MAX_BUFFERED_FRAMES) {
      failure = 'exceeded its buffer bound'
      socket.destroy()
    } else {
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (Buffer.byteLength(line) >= MAX_FRAME_BYTES || frames.length >= MAX_BUFFERED_FRAMES) {
          failure = 'exceeded its frame bound'
          socket.destroy()
          break
        }
        frames.push(line)
      }
      if (Buffer.byteLength(buffer) >= MAX_FRAME_BYTES) {
        failure = 'exceeded its frame bound'
        socket.destroy()
      }
    }
    settle()
  })
  socket.on('error', (error) => {
    failure = `failed (${error.code ?? error.name})`
    settle()
  })
  socket.on('close', () => {
    ended = true
    settle()
  })
  socket.on('end', () => {
    ended = true
    settle()
  })
  return {
    next(phase) {
      assert(!pending, 'Only one native control read may be pending')
      return new Promise((resolve, reject) => {
        pending = { phase, resolve, reject }
        settle()
      })
    },
    send(message) {
      const line = `${JSON.stringify(message)}\n`
      assert(Buffer.byteLength(line) < MAX_FRAME_BYTES, 'Native control message exceeded its bound')
      return new Promise((resolve, reject) =>
        socket.write(line, (error) => (error ? reject(error) : resolve()))
      )
    },
    fail(error) {
      failure = `write failed (${error.code ?? error.name})`
      settle()
    },
    close() {
      socket.destroy()
    }
  }
}

async function createCoordinatorControl() {
  const nonce = randomUUID()
  const server = net.createServer()
  let peer
  let serverFailure
  let connectionResolve
  const connection = new Promise((resolve) => {
    connectionResolve = resolve
  })
  server.on('error', (error) => {
    serverFailure = error
    if (peer) peer.fail(error)
    else connectionResolve(null)
  })
  server.on('connection', (socket) => {
    if (peer) {
      socket.destroy()
      return
    }
    peer = createPeer(socket)
    connectionResolve(peer)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  let authenticated
  const establish = () =>
    (authenticated ??= connection.then(async (connected) => {
      assert(connected, `Native control listener failed (${serverFailure?.code ?? 'closed'})`)
      const hello = await connected.next('hello')
      assert(hello.nonce === nonce, 'Native control peer identity differs')
      return connected
    }))
  return {
    endpoint: { port: address.port, nonce },
    async next(phase) {
      return (await establish()).next(phase)
    },
    send(command) {
      assert(peer, 'Native control peer is not connected')
      peer.send({ type: 'command', command }).catch(peer.fail)
    },
    async close() {
      peer?.close()
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}

async function connectNativeControl(endpoint) {
  assert(endpoint && Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65535)
  assert(typeof endpoint.nonce === 'string' && /^[0-9a-f-]{36}$/.test(endpoint.nonce))
  const socket = net.connect(endpoint.port, '127.0.0.1')
  const peer = createPeer(socket)
  try {
    await once(socket, 'connect')
    await peer.send({ type: 'hello', nonce: endpoint.nonce })
    return peer
  } catch (error) {
    peer.close()
    throw error
  }
}

module.exports = { createCoordinatorControl, connectNativeControl }
