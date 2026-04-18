import React from 'react'
import { observer } from 'mobx-react-lite'
import { Settings, SlidersHorizontal, Minus, Square, X } from 'lucide-react'
import type { AppStore } from '../../stores/AppStore'
import { isLinux } from '../../platform/platform'
import './topbar.scss'

const gyshell = () => (window as any)?.gyshell

export const TopBar: React.FC<{ store: AppStore }> = observer(({ store }) => {
  const showControls = !store.isDetachedWindow
  const linux = isLinux()

  const handleMinimize = () => gyshell()?.windowControls?.minimize?.()
  const handleMaximize = () => gyshell()?.windowControls?.maximize?.()
  const handleClose = () => gyshell()?.windowControls?.close?.()

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="topbar-title">RTerm</div>
      </div>
      {showControls ? (
        <div className="topbar-right">
          {/* Connection manager entry: adding new remote connections should be in Connections SSH panel */}
          <button className="icon-btn" title={store.i18n.t.connections.title} onClick={() => store.openConnections()}>
            <SlidersHorizontal size={16} strokeWidth={2} />
          </button>

          <button className="icon-btn" onClick={() => store.toggleSettings()} title={store.i18n.t.settings.title}>
            <Settings size={16} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      {linux ? (
        <div className="linux-wc">
          <button className="linux-wc-btn" title="Minimize" onClick={handleMinimize}>
            <Minus size={12} strokeWidth={2} />
          </button>
          <button className="linux-wc-btn" title="Maximize" onClick={handleMaximize}>
            <Square size={11} strokeWidth={2} />
          </button>
          <button className="linux-wc-btn linux-wc-close" title="Close" onClick={handleClose}>
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : null}
    </div>
  )
})
