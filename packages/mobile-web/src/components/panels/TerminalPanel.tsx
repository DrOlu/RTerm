import React from 'react'
import { Plus, X } from 'lucide-react'
import type { GatewayTerminalSummary } from '../../types'

interface TerminalPanelProps {
  terminals: GatewayTerminalSummary[]
  onCreateTerminal: () => void
  onCloseTerminal: (terminalId: string) => void
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  terminals,
  onCreateTerminal,
  onCloseTerminal
}) => {
  return (
    <section className="panel-scroll terminal-panel">
      <div className="panel-toolbar">
        <p className="panel-toolbar-meta">Manage backend terminal tabs.</p>
        <button
          type="button"
          className="panel-icon-btn"
          aria-label="Create terminal tab"
          title="Create terminal tab"
          onClick={onCreateTerminal}
        >
          <Plus size={15} />
        </button>
      </div>

      {terminals.length === 0 ? (
        <p className="panel-empty">No terminal tab available.</p>
      ) : (
        <div className="terminal-list">
          {terminals.map((terminal) => {
            return (
              <article key={terminal.id} className="terminal-item">
                <div className="terminal-item-main">
                  <strong>{terminal.title}</strong>
                  <p>{terminal.type}</p>
                </div>
                <div className="terminal-item-flags actions">
                  <button
                    type="button"
                    className="terminal-mini-btn danger"
                    aria-label={`Close ${terminal.title}`}
                    title={`Close ${terminal.title}`}
                    onClick={() => onCloseTerminal(terminal.id)}
                    disabled={terminals.length <= 1}
                  >
                    <X size={14} />
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
