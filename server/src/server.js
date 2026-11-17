import { randomUUID } from 'node:crypto'
import http from 'node:http'
import Koa from 'koa'
import WebSocket, { WebSocketServer } from 'ws'

const host = process.env.HOST || '192.168.1.57'
const port = Number.parseInt(process.env.PORT || '8890', 10)
const controlToken = process.env.CONTROL_TOKEN || ''
const maxBodyBytes = 1024 * 1024
const maxStoredEvents = 500
const maxStoredCommands = 1000

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`)
}

const app = new Koa()
const devices = new Map()
const commands = new Map()
const events = []

function nowIso() {
  return new Date().toISOString()
}

function pushLimited(list, value, maxSize) {
  list.push(value)
  if (list.length > maxSize) {
    list.splice(0, list.length - maxSize)
  }
}

function serializeDevice(device) {
  return {
    robotId: device.robotId,
    online: device.socket.readyState === WebSocket.OPEN,
    connectedAt: device.connectedAt,
    lastSeenAt: device.lastSeenAt,
    remoteAddress: device.remoteAddress,
    userAgent: device.userAgent
  }
}

function sendJson(socket, value) {
  if (socket.readyState !== WebSocket.OPEN) {
    return false
  }
  socket.send(JSON.stringify(value))
  return true
}

function findOnlineDevice(robotId) {
  const device = devices.get(robotId)
  return device?.socket.readyState === WebSocket.OPEN ? device : null
}

function rememberCommand(command) {
  commands.set(command.messageId, command)
  while (commands.size > maxStoredCommands) {
    commands.delete(commands.keys().next().value)
  }
}

function normalizeCommand(payload) {
  const envelope = payload?.socketType === 2 && Array.isArray(payload.list)
    ? { ...payload }
    : { list: Array.isArray(payload) ? payload : [payload] }

  if (!envelope.list.length || envelope.list.some((item) => !item || typeof item !== 'object')) {
    const error = new Error('Command list must contain at least one object')
    error.status = 400
    throw error
  }

  envelope.socketType = 2
  envelope.messageId = envelope.messageId || randomUUID()
  envelope.apiSend = envelope.apiSend ?? 1
  envelope.encryptType = envelope.encryptType ?? 0
  envelope.encryptedList = envelope.encryptedList || ''
  return envelope
}

function dispatchCommand(robotId, payload) {
  const device = findOnlineDevice(robotId)
  if (!device) {
    const error = new Error(`Robot is offline: ${robotId}`)
    error.status = 409
    throw error
  }

  const envelope = normalizeCommand(payload)
  const command = {
    messageId: envelope.messageId,
    robotId,
    envelope,
    status: 'sent',
    sentAt: nowIso(),
    acknowledgedAt: null,
    completedAt: null,
    result: null
  }
  rememberCommand(command)

  if (!sendJson(device.socket, envelope)) {
    command.status = 'send_failed'
    const error = new Error(`Failed to send command to robot: ${robotId}`)
    error.status = 503
    throw error
  }

  return command
}

async function readJsonBody(ctx) {
  const contentType = ctx.get('content-type')
  if (!contentType.toLowerCase().includes('application/json')) {
    ctx.throw(415, 'Content-Type must be application/json')
  }

  const chunks = []
  let size = 0
  for await (const chunk of ctx.req) {
    size += chunk.length
    if (size > maxBodyBytes) {
      ctx.throw(413, 'Request body is too large')
    }
    chunks.push(chunk)
  }

  if (!chunks.length) {
    ctx.throw(400, 'JSON body is required')
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    ctx.throw(400, 'Invalid JSON body')
  }
}

function assertControlAccess(ctx) {
  if (!controlToken) {
    return
  }
  if (ctx.get('authorization') !== `Bearer ${controlToken}`) {
    ctx.throw(401, 'Unauthorized')
  }
}

app.use(async (ctx, next) => {
  try {
    await next()
  } catch (error) {
    ctx.status = error.status || 500
    ctx.body = {
      code: ctx.status,
      message: ctx.status >= 500 ? 'Internal server error' : error.message
    }
    if (ctx.status >= 500) {
      console.error(error)
    }
  }
})

app.use(async (ctx, next) => {
  const startedAt = Date.now()
  await next()
  console.log(`${ctx.method} ${ctx.url} ${ctx.status} ${Date.now() - startedAt}ms`)
})

app.use(async (ctx) => {
  ctx.set('Access-Control-Allow-Origin', '*')
  ctx.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  ctx.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

  if (ctx.method === 'OPTIONS') {
    ctx.status = 204
    return
  }

  if (ctx.method === 'GET' && ctx.path === '/') {
    ctx.body = {
      name: 'WorkTool local server',
      websocketPath: '/webserver/wework/{robotId}',
      health: '/health',
      devices: '/api/devices'
    }
    return
  }

  if (ctx.method === 'GET' && ctx.path === '/health') {
    ctx.body = {
      status: 'ok',
      time: nowIso(),
      onlineDevices: [...devices.values()].filter((device) => device.socket.readyState === WebSocket.OPEN).length
    }
    return
  }

  if (ctx.method === 'GET' && ctx.path === '/api/devices') {
    assertControlAccess(ctx)
    ctx.body = {
      code: 0,
      data: [...devices.values()].map(serializeDevice)
    }
    return
  }

  const deviceEventsMatch = /^\/api\/devices\/([^/]+)\/events$/.exec(ctx.path)
  if (ctx.method === 'GET' && deviceEventsMatch) {
    assertControlAccess(ctx)
    const robotId = decodeURIComponent(deviceEventsMatch[1])
    ctx.body = {
      code: 0,
      data: events.filter((event) => event.robotId === robotId).slice(-100)
    }
    return
  }

  const deviceCommandMatch = /^\/api\/devices\/([^/]+)\/commands$/.exec(ctx.path)
  if (ctx.method === 'POST' && deviceCommandMatch) {
    assertControlAccess(ctx)
    const robotId = decodeURIComponent(deviceCommandMatch[1])
    const payload = await readJsonBody(ctx)
    const command = dispatchCommand(robotId, payload)
    ctx.status = 202
    ctx.body = { code: 0, message: 'Command sent', data: command }
    return
  }

  const commandMatch = /^\/api\/commands\/([^/]+)$/.exec(ctx.path)
  if (ctx.method === 'GET' && commandMatch) {
    assertControlAccess(ctx)
    const command = commands.get(decodeURIComponent(commandMatch[1]))
    if (!command) {
      ctx.throw(404, 'Command not found')
    }
    ctx.body = { code: 0, data: command }
    return
  }

  if (ctx.method === 'POST' && ctx.path === '/wework/sendRawMessage') {
    assertControlAccess(ctx)
    const robotId = ctx.query.robotId
    if (!robotId) {
      ctx.throw(400, 'robotId is required')
    }
    const payload = await readJsonBody(ctx)
    const command = dispatchCommand(robotId, payload)
    ctx.status = 202
    ctx.body = { code: 0, message: 'Command sent', data: { messageId: command.messageId } }
    return
  }

  if (ctx.method === 'GET' && ctx.path === '/robot/robotInfo/online') {
    const robotId = ctx.query.robotId
    ctx.body = { code: 200, message: '操作成功', data: { robotId, online: Boolean(robotId && findOnlineDevice(robotId)) } }
    return
  }

  if (ctx.method === 'GET' && ctx.path === '/robot/robotInfo/get') {
    const robotId = ctx.query.robotId
    if (!robotId) {
      ctx.throw(400, 'robotId is required')
    }
    ctx.body = {
      code: 200,
      message: '操作成功',
      data: {
        robotId,
        openCallback: 0,
        encryptType: 0,
        createTime: devices.get(robotId)?.connectedAt || nowIso(),
        enableAdd: true,
        replyAll: 1,
        robotKeyCheck: 0,
        callBackRequestType: 2,
        robotType: 0
      }
    }
    return
  }

  if (ctx.method === 'POST' && ctx.path === '/robot/robotInfo/update') {
    await readJsonBody(ctx)
    ctx.body = { code: 200, message: '操作成功', data: null }
    return
  }

  ctx.status = 404
  ctx.body = { code: 404, message: 'Not found' }
})

const server = http.createServer(app.callback())
const webSocketServer = new WebSocketServer({ noServer: true })

server.on('upgrade', (request, socket, head) => {
  let pathname
  try {
    pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname
  } catch {
    socket.destroy()
    return
  }

  const match = /^\/webserver\/wework\/([^/]+)$/.exec(pathname)
  if (!match) {
    socket.destroy()
    return
  }

  const robotId = decodeURIComponent(match[1])
  if (!robotId || robotId.length > 128) {
    socket.destroy()
    return
  }

  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit('connection', webSocket, request, robotId)
  })
})

webSocketServer.on('connection', (socket, request, robotId) => {
  const previousDevice = findOnlineDevice(robotId)
  if (previousDevice) {
    previousDevice.socket.close(4001, 'Replaced by a newer connection')
  }

  const device = {
    robotId,
    socket,
    connectedAt: nowIso(),
    lastSeenAt: nowIso(),
    remoteAddress: request.socket.remoteAddress || '',
    userAgent: request.headers['user-agent'] || ''
  }
  devices.set(robotId, device)
  console.log(`Robot connected: ${robotId} from ${device.remoteAddress}`)

  socket.on('pong', () => {
    device.lastSeenAt = nowIso()
  })

  socket.on('message', (data, isBinary) => {
    device.lastSeenAt = nowIso()
    if (isBinary) {
      console.warn(`Ignoring binary message from ${robotId}`)
      return
    }

    let payload
    try {
      payload = JSON.parse(data.toString('utf8'))
    } catch {
      console.warn(`Invalid JSON from ${robotId}`)
      return
    }

    if (Object.hasOwn(payload, 'td') || payload.type === 11) {
      return
    }

    if (payload.socketType === 1 && payload.messageId) {
      const command = commands.get(payload.messageId)
      if (command) {
        command.status = 'acknowledged'
        command.acknowledgedAt = nowIso()
      }
      return
    }

    if (payload.socketType === 3 && payload.messageId) {
      const command = commands.get(payload.messageId)
      if (command) {
        command.status = 'completed'
        command.completedAt = nowIso()
        command.result = payload
      }
    }

    const event = {
      robotId,
      receivedAt: nowIso(),
      payload
    }
    pushLimited(events, event, maxStoredEvents)
    console.log(`Robot message: ${robotId} socketType=${payload.socketType ?? 'unknown'} messageId=${payload.messageId ?? ''}`)

    if (payload.socketType === 2 && payload.messageId) {
      sendJson(socket, {
        socketType: 1,
        messageId: payload.messageId,
        list: [],
        encryptedList: '',
        encryptType: 0
      })
    }
  })

  socket.on('close', (code, reason) => {
    if (devices.get(robotId)?.socket === socket) {
      devices.delete(robotId)
    }
    console.log(`Robot disconnected: ${robotId} code=${code} reason=${reason.toString()}`)
  })

  socket.on('error', (error) => {
    console.error(`WebSocket error for ${robotId}:`, error.message)
  })
})

const heartbeatTimer = setInterval(() => {
  for (const device of devices.values()) {
    if (device.socket.readyState === WebSocket.OPEN) {
      device.socket.ping()
    }
  }
}, 30_000)
heartbeatTimer.unref()

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down`)
  clearInterval(heartbeatTimer)
  for (const device of devices.values()) {
    device.socket.close(1001, 'Server shutting down')
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

server.listen(port, host, () => {
  console.log(`WorkTool local server listening on http://${host}:${port}`)
  console.log(`WebSocket endpoint: ws://${host}:${port}/webserver/wework/{robotId}`)
  if (!controlToken) {
    console.warn('CONTROL_TOKEN is not set; command endpoints are open on the local network')
  }
})
