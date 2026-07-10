import React from 'react'
import clsx from 'clsx'
import { observer } from 'mobx-react-lite'
import type { AppStore } from '../../stores/AppStore'
import { getPanelKindUiItem, PANEL_KIND_UI_ORDER } from './panelKindUiRegistry'
import { LayoutSlotRailControls } from './LayoutSlotRailControls'
import './panelTypeRail.scss'

interface PanelTypeRailProps {
  store: AppStore
  onPrimaryPanelUnavailable?: (
    kind: (typeof PANEL_KIND_UI_ORDER)[number],
    intent: 'create-new-tab' | 'open-panel-only'
  ) => void
}

export const PanelTypeRail: React.FC<PanelTypeRailProps> = observer(({
  store,
  onPrimaryPanelUnavailable
}) => {
  const t = store.i18n.t
  const railTooltipByKind: Record<(typeof PANEL_KIND_UI_ORDER)[number], string> = {
    chat: t.layout.addChatSession,
    terminal: t.layout.addTerminalTab,
    filesystem: t.layout.openFilesystemPanel,
    monitor: t.layout.openMonitorPanel,
    listPanel: t.layout.openListPanel
  }

  const handleCreate = React.useCallback(
    (kind: (typeof PANEL_KIND_UI_ORDER)[number]) => {
      const item = getPanelKindUiItem(kind)
      const ownerTabCount = item.getOwnerTabCount(store)
      const panelCount = store.layout.getPanelIdsByKind(kind).length
      const intent = item.resolveRailClickIntent({ panelCount, ownerTabCount })
      const panelId = store.layout.ensurePrimaryPanelForKind(kind)
      if (!panelId) {
        onPrimaryPanelUnavailable?.(kind, intent)
        return
      }
      if (intent === 'create-new-tab') {
        item.createDefaultTab(store, panelId)
      } else {
        store.layout.focusPrimaryPanel(kind)
      }
    },
    [onPrimaryPanelUnavailable, store]
  )

  return (
    <div className="gyshell-panel-type-rail">
      <div className="gyshell-panel-type-rail-main">
        {PANEL_KIND_UI_ORDER.map((kind) => {
          const item = getPanelKindUiItem(kind)
          const Icon = item.icon
          const ownerTabCount = item.getOwnerTabCount(store)
          const railIndicator =
            item.formatRailIndicator?.(ownerTabCount) ?? String(ownerTabCount)
          const panelCount = store.layout.getPanelIdsByKind(kind).length
          const isDetached = panelCount === 0
          const tooltip = railTooltipByKind[kind]
          const label = `${t.layout[item.labelKey]} · ${tooltip}`
          return (
            <button
              key={kind}
              className={clsx('gyshell-panel-type-rail-btn', {
                'is-detached': isDetached
              })}
              title={label}
              aria-label={label}
              onClick={() => handleCreate(kind)}
            >
              <Icon size={14} strokeWidth={2.2} />
              <span className="gyshell-panel-type-rail-count">{railIndicator}</span>
            </button>
          )
        })}
      </div>
      <LayoutSlotRailControls store={store} />
    </div>
  )
})
