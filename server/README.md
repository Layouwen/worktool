# WorkTool 本地调度服务

本服务使用 Koa 提供 HTTP API，并通过同一个 Node HTTP Server 承载 WorkTool WebSocket 长连接。它直接监听 `192.168.1.57:8890`，不依赖证书、Caddy、Nginx 或其它反向代理。

当前本机链路：

```text
Android App
  -> ws://192.168.1.57:8890/webserver/wework/{robotId}
  -> Koa + ws
```

## 启动

```bash
cd server
npm install
npm start
```

可选安全令牌：

```bash
CONTROL_TOKEN='请换成随机值' npm start
```

设置令牌后，设备列表与指令接口需要请求头：

```text
Authorization: Bearer 请换成随机值
```

## 验证

```bash
curl http://192.168.1.57:8890/health

curl http://192.168.1.57:8890/api/devices
```

App 开启主功能并建立连接后，`/api/devices` 会返回自动生成的 `robotId`。

## 下发消息

将下面的 `{robotId}` 和联系人或群名替换成实际值：

```bash
curl -X POST 'http://192.168.1.57:8890/wework/sendRawMessage?robotId={robotId}' \
  -H 'Content-Type: application/json' \
  -d '{
    "socketType": 2,
    "list": [
      {
        "type": 203,
        "titleList": ["联系人或群名"],
        "receivedContent": "你好"
      }
    ]
  }'
```

返回的 `messageId` 可用于查询执行状态：

```bash
curl 'http://192.168.1.57:8890/api/commands/{messageId}'
```

## 主要接口

- `GET /health`：服务健康状态。
- `GET /api/devices`：当前在线机器人。
- `GET /api/devices/{robotId}/events`：最近上行消息与执行结果。
- `POST /api/devices/{robotId}/commands`：下发单条或完整协议指令。
- `GET /api/commands/{messageId}`：查询确认和执行结果。
- `POST /wework/sendRawMessage?robotId=...`：兼容 WorkTool 原发送接口。
- `GET /robot/robotInfo/online?robotId=...`：查询在线状态。
- `GET /robot/robotInfo/get?robotId=...`：获取本地机器人配置。
- `POST /robot/robotInfo/update?robotId=...`：兼容客户端配置保存。

数据当前保存在内存中，重启服务后会清空，适合局域网联调。

默认使用未被占用的 `8890`。也可以通过 `PORT` 环境变量换成其它空闲端口，并同步修改 App 的连接地址。

本次配套 APK 会把已经保存的本地 `wss` 地址自动迁移到 `ws://192.168.1.57:8890`，其它自定义地址保持不变。
