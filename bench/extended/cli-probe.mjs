import { readFile } from 'node:fs/promises'
import http from 'node:http'

const discovery = JSON.parse(await readFile(process.argv[2], 'utf8'))
if (!Number.isInteger(discovery.port) || discovery.port < 1 || discovery.port > 65535)
  throw new Error('Invalid fixture discovery')
await new Promise((done, reject) => {
  const request = http.get(
    { hostname: '127.0.0.1', port: discovery.port, path: '/state', timeout: 3000 },
    (response) => {
      let body = ''
      response.on('data', (chunk) => {
        body += chunk
        if (body.length > 16_384) request.destroy(new Error('Oversized fixture response'))
      })
      response.once('error', reject)
      response.once('end', () => {
        if (response.statusCode !== 200) reject(new Error('Fixture response status'))
        else {
          process.stdout.write(body)
          done()
        }
      })
    }
  )
  request.once('timeout', () => request.destroy(new Error('Fixture request timeout')))
  request.once('error', reject)
})
