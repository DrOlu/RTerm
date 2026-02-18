# Mobile-Web Usage Guide

## English

### 1. What It Is

- Mobile-first remote client for GyShell sessions.
- Supports session browse/search, prompt sending, permission replies, rollback, tool toggles, skill toggles, and terminal tab management.
- Does not render terminal screen output directly.

### 2. Prerequisites

- A reachable GyShell backend websocket endpoint.
- Backend must have at least one terminal tab.
- If phone and backend are on different devices, backend must be exposed to LAN/VPN and firewall must allow the selected port.

### 3. Start Mobile-Web

From repo root:

```bash
npm run dev:mobile-web
```

- Dev server: `http://<host-ip>:5174`

Production-like preview:

```bash
npm run build:mobile-web
npm run start:mobile-web
```

- Preview server: `http://<host-ip>:4174`

### 4. Connect to Backend

1. Open mobile-web in browser.
2. Go to `Settings` tab.
3. Set Gateway URL, for example:

```text
ws://192.168.1.8:17888
```

4. Tap `Connect`.

Notes:

- If mobile-web and backend are on the same machine, default URL usually works (`ws://<page-host>:17888`).
- `Connect` enables auto-reconnect; `Disconnect` disables it.

### 5. Core Workflows

- `Chat`
  - Session Browser (search + running indicator)
  - Open/create session
  - Send prompt, stop run
  - Reply permission asks
  - Rollback to a previous message
- `Terminal`
  - Create local terminal tab
  - Create SSH terminal tab from saved desktop SSH connections
  - Close terminal tab (cannot close the last tab)
- `Skills`
  - Toggle skill enablement and reload list
- `Tools`
  - Toggle MCP servers and built-in tools
- `Settings`
  - Update websocket endpoint and connect/disconnect

### 6. Connection Behavior

- Heartbeat checks websocket regularly.
- On disconnect/heartbeat loss, client retries with exponential backoff.
- Session list and active session state are reloaded after reconnect.

### 7. Troubleshooting

- `No terminal is available on backend.`
  - Backend has no terminal tab. Start backend with terminal bootstrap enabled, or create one in desktop first.
- `Gateway is disconnected` / timeout
  - Check desktop websocket access mode and port.
  - Verify firewall and network route.
- `SSH connection not found. Please configure it in desktop settings first.`
  - Mobile-web reads SSH definitions from backend settings; create SSH connection in desktop settings first.

---

## 中文

### 1. 它是什么

- 面向手机浏览器的 GyShell 远程会话控制端。
- 支持会话浏览/搜索、发送消息、权限回复、回滚、工具开关、技能开关、终端标签管理。
- 不直接渲染终端屏幕输出。

### 2. 前置条件

- 需要一个可访问的 GyShell backend websocket 地址。
- backend 需要至少有一个可用 terminal tab。
- 如果手机和 backend 不在同一设备，backend 需要开放到局域网/VPN，且系统防火墙允许对应端口。

### 3. 启动 Mobile-Web

在仓库根目录执行：

```bash
npm run dev:mobile-web
```

- 开发地址：`http://<host-ip>:5174`

接近生产的预览模式：

```bash
npm run build:mobile-web
npm run start:mobile-web
```

- 预览地址：`http://<host-ip>:4174`

### 4. 连接 Backend

1. 浏览器打开 mobile-web。
2. 进入 `Settings` 标签页。
3. 填写 Gateway URL，例如：

```text
ws://192.168.1.8:17888
```

4. 点击 `Connect`。

说明：

- 如果 mobile-web 与 backend 在同一台机器，默认 URL 通常可直接使用（`ws://<页面主机>:17888`）。
- `Connect` 会启用自动重连；`Disconnect` 会关闭自动重连。

### 5. 核心使用流程

- `Chat`
  - 会话浏览器（搜索 + 运行状态）
  - 打开/创建会话
  - 发送消息、停止运行
  - 回复权限询问
  - 回滚到历史消息
- `Terminal`
  - 新建本地 terminal tab
  - 基于桌面端已保存 SSH 连接新建 SSH tab
  - 关闭 tab（最后一个 tab 不能关闭）
- `Skills`
  - 切换技能启用状态并刷新列表
- `Tools`
  - 切换 MCP 服务器与内置工具启用状态
- `Settings`
  - 修改 websocket 地址并连接/断开

### 6. 连接行为

- 客户端会定期进行 websocket 心跳检查。
- 断连或心跳丢失时，会指数退避自动重连。
- 重连成功后会重新加载会话列表和当前会话状态。

### 7. 常见问题

- `No terminal is available on backend.`
  - backend 没有 terminal tab。请先启用 bootstrap terminal，或先在桌面端创建 tab。
- `Gateway is disconnected` / timeout
  - 检查桌面端 websocket 暴露模式与端口。
  - 检查防火墙和网络路径。
- `SSH connection not found. Please configure it in desktop settings first.`
  - mobile-web 的 SSH 配置来自 backend settings，需先在桌面端 Settings 中创建 SSH 连接。
