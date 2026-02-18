# TUI Usage Guide (`gyll`)

## English

### 1. Recommended Entry

For end users, use desktop-bundled `gyll` (installed after first desktop app launch).

### 2. Basic Commands

```bash
gyll --help
gyll
gyll "Hello"
gyll run "Run tests and summarize"
gyll hook "wake up and continue"
gyll --sessionid "<session-id>"
gyll --url 127.0.0.1:17888
```

Mode semantics:

- `gyll`: interactive TUI mode.
- `gyll "message"`: create session, send immediately, then enter TUI.
- `gyll run "message"`: stream output in terminal and exit (no TUI).
- `gyll hook "message"`: send asynchronously then exit immediately.

### 3. Connection Rules

If `--url` is not provided, TUI probes local endpoints first:

- `ws://127.0.0.1:17888`
- `ws://localhost:17888`

It also considers env ports (`GYSHELL_WS_PORT`, `GYBACKEND_WS_PORT`).
If probes fail and terminal is interactive, TUI prompts for manual websocket URL.

### 4. Safety Note for `run` Mode

In `run` mode, permission-ask messages are auto-denied by design (non-interactive headless flow).

If you need manual allow/deny decisions, use interactive `gyll` mode.

### 5. Session Recovery

- TUI loads existing sessions from backend (`session:list` / `session:get`).
- `--sessionid` prefers a specific session.
- Without `--sessionid`, it restores/chooses recent sessions automatically.

### 6. Repo Development Mode

From repo root:

```bash
npm run dev:tui
# or
npm run start:tui
```

Notes:

- These scripts use Bun runtime in `@gyshell/tui` workspace.
- They do not auto-start backend; start desktop app/backend first.

### 7. Troubleshooting

- `No terminal is available on backend...`
  - Backend has zero terminal tabs. Enable bootstrap terminal or create one first.
- `Unable to find platform binary package for gyll ...`
  - Reinstall desktop runtime / CLI package, or set `GYLL_BIN_PATH` to an existing binary.
- Connection timeout
  - Verify backend websocket access and port; try explicit `--url`.

---

## 中文

### 1. 推荐入口

对于终端用户，推荐使用桌面版内置 `gyll`（首次启动桌面 App 后自动安装）。

### 2. 基础命令

```bash
gyll --help
gyll
gyll "Hello"
gyll run "Run tests and summarize"
gyll hook "wake up and continue"
gyll --sessionid "<session-id>"
gyll --url 127.0.0.1:17888
```

模式语义：

- `gyll`：交互式 TUI。
- `gyll "消息"`：新建会话并发送首条消息，然后进入 TUI。
- `gyll run "消息"`：终端流式输出后退出（不进入 TUI）。
- `gyll hook "消息"`：异步发送后立即退出。

### 3. 连接规则

未提供 `--url` 时，TUI 会优先探测本地地址：

- `ws://127.0.0.1:17888`
- `ws://localhost:17888`

同时会读取环境变量端口（`GYSHELL_WS_PORT`、`GYBACKEND_WS_PORT`）。
如果探测失败且当前终端可交互，TUI 会提示手动输入 websocket 地址。

### 4. `run` 模式安全说明

`run` 模式下，权限询问会被自动拒绝（设计上用于非交互 headless 流程）。

如果你需要手动 allow/deny，请使用交互式 `gyll` 模式。

### 5. 会话恢复

- TUI 会从 backend 加载已有会话（`session:list` / `session:get`）。
- `--sessionid` 可指定优先恢复某个会话。
- 不指定时，默认自动恢复/选择最近会话。

### 6. 仓库开发模式

在仓库根目录执行：

```bash
npm run dev:tui
# 或
npm run start:tui
```

说明：

- 这两个脚本在 `@gyshell/tui` workspace 中使用 Bun 运行。
- 不会自动启动 backend，需要先启动桌面端或 backend。

### 7. 常见问题

- `No terminal is available on backend...`
  - backend 没有 terminal tab。请先启用 bootstrap terminal，或先创建 tab。
- `Unable to find platform binary package for gyll ...`
  - 重新安装桌面运行时/CLI 包，或设置 `GYLL_BIN_PATH` 指向有效二进制。
- Connection timeout
  - 检查 backend websocket 暴露设置和端口，建议显式传 `--url`。
