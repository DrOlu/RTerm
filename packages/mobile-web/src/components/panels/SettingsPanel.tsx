import React from 'react'

interface SettingsPanelProps {
  gatewayInput: string
  connectionStatus: 'connecting' | 'connected' | 'disconnected'
  actionPending: boolean
  connectionError: string
  onGatewayInputChange: (value: string) => void
  onConnect: () => void
  onDisconnect: () => void
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  gatewayInput,
  connectionStatus,
  actionPending,
  connectionError,
  onGatewayInputChange,
  onConnect,
  onDisconnect
}) => {
  const connected = connectionStatus === 'connected'

  return (
    <section className="panel-scroll settings-panel">
      <section className="settings-section">
        <h3>Gateway</h3>
        <p className="section-hint">WebSocket endpoint for this mobile client.</p>
        <input
          value={gatewayInput}
          onChange={(event) => onGatewayInputChange(event.target.value)}
          placeholder="ws://192.168.1.8:17888"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <div className="settings-row-actions">
          {connected ? (
            <button type="button" className="danger-btn" onClick={onDisconnect}>
              Disconnect
            </button>
          ) : (
            <button type="button" className="accent-btn" onClick={onConnect} disabled={actionPending}>
              {actionPending ? 'Connecting...' : 'Connect'}
            </button>
          )}
          <span className={`conn-label ${connectionStatus}`}>{connectionStatus}</span>
        </div>
        {connectionError ? <p className="settings-error">{connectionError}</p> : null}
      </section>
    </section>
  )
}
