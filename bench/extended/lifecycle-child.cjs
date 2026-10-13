const { app } = require('electron')
const http = require('node:http')
const fs = require('node:fs/promises')
const args = process.argv.slice(2)
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
app.setPath('userData', option('user-data'))
app.commandLine.appendSwitch('disable-gpu')
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  let duplicateLaunches = 0
  app.on('second-instance', () => {
    duplicateLaunches++
  })
  app
    .whenReady()
    .then(async () => {
      const server = http.createServer((request, response) => {
        if (request.method !== 'GET' || request.url !== '/state') {
          response.writeHead(404)
          response.end()
          return
        }
        response.setHeader('Content-Type', 'application/json')
        const body = JSON.stringify({
          ready: true,
          pid: process.pid,
          duplicateLaunches,
          runtime: process.versions,
          platform: process.platform,
          arch: process.arch
        })
        response.setHeader('Content-Length', Buffer.byteLength(body))
        response.end(body)
      })
      server.listen(0, '127.0.0.1', async () => {
        try {
          const temporary = `${option('discovery')}.tmp`
          await fs.writeFile(
            temporary,
            JSON.stringify({ port: server.address().port, pid: process.pid })
          )
          await fs.rename(temporary, option('discovery'))
        } catch (error) {
          process.stderr.write(`${error.code ?? error.name}\n`)
          app.exit(1)
        }
      })
      server.on('error', (error) => {
        process.stderr.write(`${error.code ?? error.name}\n`)
        app.exit(1)
      })
      app.on('before-quit', () => {
        server.closeAllConnections()
        server.close()
      })
    })
    .catch((error) => {
      process.stderr.write(`${error.name}\n`)
      app.exit(1)
    })
}
