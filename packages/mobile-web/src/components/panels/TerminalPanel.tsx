import React from 'react'
import { Plus, X } from 'lucide-react'
import type { CreateTerminalTarget, GatewaySshConnectionSummary, GatewayTerminalSummary } from '../../types'

interface TerminalPanelProps {
  terminals: GatewayTerminalSummary[]
  sshConnections: GatewaySshConnectionSummary[]
  onCreateTerminal: (target: CreateTerminalTarget) => void
  onCloseTerminal: (terminalId: string) => void
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  terminals,
  sshConnections,
  onCreateTerminal,
  onCloseTerminal
}) => {
  const [createTarget, setCreateTarget] = React.useState<string>('local')

  const options = React.useMemo(() => {
    return [
      { value: 'local', label: 'Local terminal' },
      ...sshConnections.map((item) => ({
        value: `ssh:${item.id}`,
        label: item.name || `${item.username}@${item.host}:${item.port}`
      }))
    ]
  }, [sshConnections])

  React.useEffect(() => {
    if (createTarget === 'local') return
    const id = createTarget.startsWith('ssh:') ? createTarget.slice(4) : ''
    if (!id) {
      setCreateTarget('local')
      return
    }
    const exists = sshConnections.some((item) => item.id === id)
    if (!exists) {
      setCreateTarget('local')
    }
  }, [createTarget, sshConnections])

  const handleCreate = React.useCallback(() => {
    if (createTarget === 'local') {
      onCreateTerminal({ type: 'local' })
      return
    }
    const id = createTarget.startsWith('ssh:') ? createTarget.slice(4) : ''
    if (!id) return
    onCreateTerminal({ type: 'ssh', connectionId: id })
  }, [createTarget, onCreateTerminal])

  return (
    <section className="panel-scroll terminal-panel">
      <div className="panel-toolbar">
        <div className="panel-title-spacer terminal-create-field">
          <select
            className="terminal-create-select"
            value={createTarget}
            onChange={(event) => setCreateTarget(event.target.value)}
            aria-label="Select terminal type"
          >
            {options.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {sshConnections.length === 0 ? <p className="terminal-sub-hint">No saved SSH connection found.</p> : null}

      {terminals.length === 0 ? (
        <p className="panel-empty">No active terminals.</p>
      ) : (
        <div className="terminal-list">
          {terminals.map((terminal) => {
            const runtimeState = terminal.runtimeState || 'initializing'
            const activityClass = runtimeState === 'ready' ? 'active' : 'inactive'
            return (
              <article key={terminal.id} className="terminal-item-flat">
                <div className="terminal-item-main">
                  <strong>
                    <span
                      className={`terminal-state-dot ${activityClass}`}
                      title={runtimeState}
                      aria-label={`Terminal state: ${runtimeState}`}
                    />
                    {terminal.title}
                  </strong>
                  <p>{terminal.type}</p>
                </div>
                <button
                  type="button"
                  className="terminal-close-btn"
                  aria-label={`Close ${terminal.title}`}
                  title={`Close ${terminal.title}`}
                  onClick={() => onCloseTerminal(terminal.id)}
                  disabled={terminals.length <= 1}
                >
                  <X size={14} />
                </button>
              </article>
            )
          })}
        </div>
      )}

      <div className="panel-action-dock">
        <button
          type="button"
          className="panel-icon-btn panel-action-btn"
          aria-label="New terminal"
          title="New terminal"
          onClick={handleCreate}
        >
          <Plus size={18} />
        </button>
      </div>
    </section>
  )
}
