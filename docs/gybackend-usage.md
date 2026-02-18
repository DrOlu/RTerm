# GyBackend Usage Guide

## English

### Important First

**Current status:** GyBackend is not provided as an independently installable end-user product.
It is currently supported as:

1. Desktop app built-in backend (recommended for users)
2. Repository development runtime (`apps/gybackend`) for contributors

> [!WARNING]
> GyBackend is still in experimental development. Client authentication based on authorization/encryption is **not implemented yet**.
> Runtime behavior is already validated as usable, but do **not** expose it directly to the public internet.
> Recommended deployment right now: `localhost only` or private network access via VPN.

### 1. Recommended User Path (Desktop Built-In Backend)

Open desktop app settings:

- `Settings` -> `General` -> `WebSocket Gateway Access`
- `Settings` -> `General` -> `WebSocket Gateway Port`

Access mode mapping:

- `localhost`: bind `127.0.0.1` (local machine only)
- `internet`: bind `0.0.0.0` (LAN/public interfaces, still subject to firewall)
- `disabled`: do not start websocket listener

Default port is `17888`.

### 2. Connect Clients

- TUI `gyll`: auto-probes local websocket if `--url` is omitted.
- mobile-web: configure websocket URL in mobile settings panel.

### 3. Repository Development Runtime

From repository root:

```bash
npm run build:backend
npm run start:backend
```

Equivalent workspace commands:

```bash
npm --workspace @gyshell/gybackend run build
npm --workspace @gyshell/gybackend run start
```

### 4. Standalone Runtime Environment Variables

Common variables:

- `GYBACKEND_WS_ENABLE`: enable/disable websocket endpoint
- `GYBACKEND_WS_HOST`: host (default `0.0.0.0` in standalone runtime)
- `GYBACKEND_WS_PORT`: websocket port (default `17888`)
- `GYBACKEND_DATA_DIR`: data dir (default `<cwd>/.gybackend-data`)
- `GYBACKEND_BOOTSTRAP_LOCAL_TERMINAL`: auto-create local terminal (`true` by default)
- `GYBACKEND_TERMINAL_ID`, `GYBACKEND_TERMINAL_TITLE`, `GYBACKEND_TERMINAL_CWD`, `GYBACKEND_TERMINAL_SHELL`
- `GYBACKEND_MODEL`, `GYBACKEND_API_KEY`, `GYBACKEND_BASE_URL`: optional bootstrap model profile

Start logs print websocket endpoint state and settings path.

### 5. Config Mutation Boundary

`settings:set` over websocket RPC does **not** allow changing `settings.gateway.ws`.
Gateway exposure policy changes should be done through desktop settings (or runtime env before startup).

### 6. Security Checklist

- Prefer `localhost` unless remote access is truly required.
- If remote access is needed, prefer VPN/private network.
- Avoid direct public internet exposure.
- Restrict host firewall inbound rules to trusted sources.

---

## 中文

### 先看重点

**当前状态：** 目前不支持“独立安装 gybackend 作为终端用户产品”。
当前支持方式：

1. 桌面 App 内置 backend（推荐用户使用）
2. 仓库内开发运行时（`apps/gybackend`，面向贡献者）

> [!WARNING]
> GyBackend 仍处于实验开发阶段，目前**尚未实现**基于授权加密的客户端认证。
> 已确认当前版本可用，但**不建议**直接暴露到公网。
> 当前建议：仅本机开放，或通过 VPN 私网接入。

### 1. 推荐用户路径（桌面内置 Backend）

桌面端设置入口：

- `Settings` -> `General` -> `WebSocket Gateway Access`
- `Settings` -> `General` -> `WebSocket Gateway Port`

模式映射：

- `localhost`：绑定 `127.0.0.1`（仅本机）
- `internet`：绑定 `0.0.0.0`（局域网/公网网卡，仍受防火墙限制）
- `disabled`：不启动 websocket 监听

默认端口是 `17888`。

### 2. 客户端连接

- TUI `gyll`：未传 `--url` 时会自动探测本地 websocket。
- mobile-web：在移动端 Settings 面板中填写 websocket 地址。

### 3. 仓库开发运行时

在仓库根目录执行：

```bash
npm run build:backend
npm run start:backend
```

等价 workspace 命令：

```bash
npm --workspace @gyshell/gybackend run build
npm --workspace @gyshell/gybackend run start
```

### 4. 独立运行时环境变量

常用变量：

- `GYBACKEND_WS_ENABLE`：启用/禁用 websocket 端点
- `GYBACKEND_WS_HOST`：主机地址（独立运行时默认 `0.0.0.0`）
- `GYBACKEND_WS_PORT`：websocket 端口（默认 `17888`）
- `GYBACKEND_DATA_DIR`：数据目录（默认 `<cwd>/.gybackend-data`）
- `GYBACKEND_BOOTSTRAP_LOCAL_TERMINAL`：是否自动创建本地 terminal（默认 `true`）
- `GYBACKEND_TERMINAL_ID`、`GYBACKEND_TERMINAL_TITLE`、`GYBACKEND_TERMINAL_CWD`、`GYBACKEND_TERMINAL_SHELL`
- `GYBACKEND_MODEL`、`GYBACKEND_API_KEY`、`GYBACKEND_BASE_URL`：可选的模型引导配置

启动日志会输出 websocket 端点状态和 settings 路径。

### 5. 配置修改边界

通过 websocket RPC 调用 `settings:set` 时，**不允许**修改 `settings.gateway.ws`。
网关暴露策略应通过桌面设置（或启动前环境变量）控制。

### 6. 安全建议清单

- 除非确有需要，优先使用 `localhost`。
- 需要远程访问时，优先走 VPN/私网。
- 避免直接公网暴露。
- 通过主机防火墙限制可访问来源。
