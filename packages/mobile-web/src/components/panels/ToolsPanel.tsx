import React from 'react'
import { RefreshCw } from 'lucide-react'
import type { BuiltInToolSummary, McpServerSummary } from '../../types'

interface ToolsPanelProps {
  mcpTools: McpServerSummary[]
  builtInTools: BuiltInToolSummary[]
  connectionStatus: 'connecting' | 'connected' | 'disconnected'
  onReload: () => Promise<void>
  onSetMcpEnabled: (name: string, enabled: boolean) => Promise<void>
  onSetBuiltInEnabled: (name: string, enabled: boolean) => Promise<void>
}

function formatMcpStatus(status: McpServerSummary['status']): string {
  if (status === 'connected') return 'Connected'
  if (status === 'connecting') return 'Connecting'
  if (status === 'error') return 'Error'
  return 'Disabled'
}

export const ToolsPanel: React.FC<ToolsPanelProps> = ({
  mcpTools,
  builtInTools,
  connectionStatus,
  onReload,
  onSetMcpEnabled,
  onSetBuiltInEnabled
}) => {
  const [reloading, setReloading] = React.useState(false)
  const canMutate = connectionStatus === 'connected'
  const enabledMcpCount = mcpTools.filter((item) => item.enabled).length
  const enabledBuiltInCount = builtInTools.filter((item) => item.enabled).length

  const handleReload = React.useCallback(async () => {
    setReloading(true)
    try {
      await onReload()
    } finally {
      setReloading(false)
    }
  }, [onReload])

  return (
    <section className="panel-scroll tools-panel">
      <div className="panel-toolbar">
        <p className="panel-toolbar-meta">
          MCP {enabledMcpCount}/{mcpTools.length} enabled, built-in {enabledBuiltInCount}/{builtInTools.length} enabled
        </p>
        <div className="panel-toolbar-actions">
          <button
            type="button"
            className="panel-icon-btn"
            disabled={!canMutate || reloading}
            onClick={() => void handleReload()}
            aria-label="Reload tools"
            title="Reload tools"
          >
            <RefreshCw size={16} className={reloading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      <div className="skill-source-group">
        <header className="skill-source-head">
          <h3>MCP Servers</h3>
        </header>
        {mcpTools.length === 0 ? (
          <p className="panel-empty">No MCP servers found.</p>
        ) : (
          <div className="skill-list">
            {mcpTools.map((tool) => {
              const isEnabled = tool.enabled
              return (
                <article key={tool.name} className="skill-item">
                  <div className="skill-item-body tools-item-body">
                    <h3>{tool.name}</h3>
                    <p>
                      {formatMcpStatus(tool.status)}
                      {typeof tool.toolCount === 'number' ? ` • ${tool.toolCount} tools` : ''}
                    </p>
                    {tool.error ? <p className="tool-error-text">{tool.error}</p> : null}
                  </div>
                  <button
                    type="button"
                    className={`skill-toggle ${isEnabled ? 'enabled' : ''}`}
                    disabled={!canMutate}
                    onClick={() => void onSetMcpEnabled(tool.name, !isEnabled)}
                  >
                    {isEnabled ? 'ON' : 'OFF'}
                  </button>
                </article>
              )
            })}
          </div>
        )}
      </div>

      <div className="skill-source-group">
        <header className="skill-source-head">
          <h3>Built-in Tools</h3>
        </header>
        {builtInTools.length === 0 ? (
          <p className="panel-empty">No built-in tools found.</p>
        ) : (
          <div className="skill-list">
            {builtInTools.map((tool) => {
              const isEnabled = tool.enabled
              return (
                <article key={tool.name} className="skill-item">
                  <div className="skill-item-body tools-item-body">
                    <h3>{tool.name}</h3>
                    <p>{tool.description || 'No description provided.'}</p>
                  </div>
                  <button
                    type="button"
                    className={`skill-toggle ${isEnabled ? 'enabled' : ''}`}
                    disabled={!canMutate}
                    onClick={() => void onSetBuiltInEnabled(tool.name, !isEnabled)}
                  >
                    {isEnabled ? 'ON' : 'OFF'}
                  </button>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
