import http from 'node:http'
import WebSocket from 'ws'

const baseUrl = new URL(process.env.BASE_URL || 'http://192.168.1.57:8890')
const robotId = process.env.ROBOT_ID || 'smoke-test-robot'

function requestJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const request = http.request({
      protocol: baseUrl.protocol,
      hostname: baseUrl.hostname,
      port: baseUrl.port,
      method,
      path,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': payload.length
      } : undefined
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const result = text ? JSON.parse(text) : null
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${method} ${path} returned ${response.statusCode}: ${text}`))
          return
        }
        resolve(result)
      })
    })
    request.on('error', reject)
    if (payload) {
      request.write(payload)
    }
    request.end()
  })
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function waitForCommand(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for command')), 5_000)
    socket.once('message', (data) => {
      clearTimeout(timeout)
      resolve(JSON.parse(data.toString('utf8')))
    })
  })
}

const websocketUrl = new URL(`/webserver/wework/${robotId}`, baseUrl)
websocketUrl.protocol = 'ws:'
const socket = new WebSocket(websocketUrl)

try {
  await waitForOpen(socket)
  socket.send(JSON.stringify({ td: Date.now() }))

  const health = await requestJson('GET', '/health')
  if (health.status !== 'ok') {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`)
  }

  const incomingCommand = waitForCommand(socket)
  const sent = await requestJson('POST', `/api/devices/${robotId}/commands`, {
    type: 203,
    titleList: ['联调联系人'],
    receivedContent: '本地 WSS 联调消息'
  })
  const command = await incomingCommand

  if (command.messageId !== sent.data.messageId || command.socketType !== 2) {
    throw new Error('WebSocket command did not match HTTP dispatch response')
  }

  socket.send(JSON.stringify({
    socketType: 1,
    messageId: command.messageId,
    list: [],
    encryptedList: '',
    encryptType: 0
  }))
  socket.send(JSON.stringify({
    socketType: 3,
    messageId: command.messageId,
    list: [{ type: 203, result: 0, message: '联调成功' }],
    encryptedList: '',
    encryptType: 0
  }))

  await new Promise((resolve) => setTimeout(resolve, 100))
  const completed = await requestJson('GET', `/api/commands/${command.messageId}`)
  if (completed.data.status !== 'completed') {
    throw new Error(`Command did not complete: ${JSON.stringify(completed)}`)
  }

  console.log(JSON.stringify({
    health: health.status,
    websocket: 'connected',
    robotId,
    messageId: command.messageId,
    commandStatus: completed.data.status
  }, null, 2))
} finally {
  socket.close(1000, 'Smoke test complete')
}
