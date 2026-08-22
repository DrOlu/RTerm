# rterm CLI

A `gyll`-style command CLI for the RTerm / neuralOS backend. Speaks the backend's
WebSocket JSON-RPC gateway (`ws://host:17888`) natively — no Node.js app install,
no dependencies.

## Install / run

```bash
# from a checkout
node apps/cli/rterm-cli.mjs ping

# link it
npm --workspace @rterm/cli run build 2>/dev/null || true
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
rterm chat <sessionId> <message>           # send a message to the agent (blocking)
rterm dashboard                            # live dashboard state
rterm metrics [--format prometheus]        # host metrics
```

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
