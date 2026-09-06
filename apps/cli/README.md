# rterm CLI

A `gyll`-style command CLI for the RTerm / neuralOS backend. Speaks the backend's
WebSocket JSON-RPC gateway (`ws://host:17888`) natively — no Node.js app install,
no dependencies.

## Install / run

```bash
# run directly (nothing to install)
npx rterm-cli ping

# or from a checkout
node apps/cli/rterm-cli.mjs ping

# link it
ln -s "$(pwd)/apps/cli/rterm-cli.mjs" /usr/local/bin/rterm
```

## Commands

```bash
rterm ping                                 # liveness check
rterm version                              # backend version + method count
rterm methods [--category terminal]        # self-describing RPC surface
rterm call <method> [json-params]          # raw JSON-RPC call
rterm terminals                            # list terminal tabs
rterm open <saved-connection-name>         # open a tab for a saved connection
rterm close <tabIdOrName>                  # close a terminal tab
rterm run <tabIdOrName> <command>          # run a command in a tab (waits)
rterm fleet <tab1,tab2,...> <command>      # run on many tabs at once
rterm sessions                             # list chat sessions
rterm chat                                 # INTERACTIVE persistent chat (see below)
rterm chat <sessionId> <message>           # send a message to the agent (blocking)
rterm dashboard                            # live dashboard state
rterm metrics [--format prometheus]        # host metrics
```

## Interactive chat — the desktop experience, in your terminal

`rterm chat` (with no arguments) opens a persistent, streaming conversation with
the RTerm agent — the same session, events, and history the desktop app uses:

```text
$ rterm chat
Connected to ws://127.0.0.1:17888 — session 96c153ac…
── resuming (4 messages) ──
you> Reply with exactly one word: PONG
· Reasoning... The user wants me to reply with exactly one word: PONG
assistant> PONG
you> /exit
session 96c153ac… kept server-side — rerun "rterm chat" to resume.
```

What you get:

- **Streaming replies** — text, reasoning, and tool output render live as the
  agent works (`say` / `sub_tool_*` / `command_*` gateway events).
- **Persistent sessions** — the conversation lives on the backend (SQLite), not
  in the terminal. Exit, kill the process, reboot the machine — the next
  `rterm chat` resumes where you left off (last session id saved in
  `~/.rterm-cli/chat-state.json`; override with `--session <id>`).
- **History replay** — resuming a session prints the past transcript first.
- **Command approvals** — when the agent asks to run a command, the CLI pauses
  and prompts `allow? [y/N]`, replying via the same approval RPC the desktop
  uses. Any non-`y` answer denies.
- **Slash commands**:

| Command | Action |
|---|---|
| `/new` | Start a fresh session |
| `/sessions` | List sessions; type a number to resume one |
| `/rename <title>` | Rename the current session |
| `/branch` | Branch a new session from the last assistant message |
| `/export [--simple]` | Export this session as markdown |
| `/search <query>` | Full-text search across ALL sessions (needs a history bridge) |
| `/stop` | Stop the running agent task |
| `/verbose` | Toggle raw gateway-event display |
| `/exit` (or Ctrl-D) | Leave — the session stays on the server |

Flags: `--session <id>` (resume a specific session), `--verbose` (start with
raw events on).

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `RTERM_URL` | `ws://127.0.0.1:17888` | Gateway URL |
| `RTERM_HOST` / `RTERM_PORT` | `127.0.0.1` / `17888` | Build the URL if `RTERM_URL` is unset |
| `RTERM_TOKEN` | — | Access token (required for non-localhost gateways) |

The CLI also auto-loads the first token from
`~/.gybackend-data/access-tokens.json` when present.

## Node version

Uses the native `WebSocket` client (Node ≥ 21). On older Node it falls back to
the `ws` package when resolvable.
