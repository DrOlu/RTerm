import React from 'react'
import clsx from 'clsx'
import { observer } from 'mobx-react-lite'
import type { AppStore } from '../../stores/AppStore'
import { getPanelKindUiItem, PANEL_KIND_UI_ORDER } from './panelKindUiRegistry'
import './panelTypeRail.scss'

export const PanelTypeRail: React.FC<{ store: AppStore }> = observer(({ store }) => {
  const t = store.i18n.t
  const railTooltipByKind: Record<(typeof PANEL_KIND_UI_ORDER)[number], string> = {
    chat: t.layout.addChatSession,
    terminal: t.layout.addTerminalTab,
    filesystem: t.layout.openFilesystemPanel
  }

  const handleCreate = React.useCallback(
    (kind: (typeof PANEL_KIND_UI_ORDER)[number]) => {
      const item = getPanelKindUiItem(kind)
      const ownerTabCount = item.getOwnerTabCount(store)
      const panelCount = store.layout.getPanelIdsByKind(kind).length
      const intent = item.resolveRailClickIntent({ panelCount, ownerTabCount })
      const panelId = store.layout.ensurePrimaryPanelForKind(kind)
      if (!panelId) return
      if (intent === 'create-new-tab') {
        item.createDefaultTab(store, panelId)
      } else {
        store.layout.focusPrimaryPanel(kind)
      }
    },
    [store]
  )

  return (
    <div className="gyshell-panel-type-rail">
      {PANEL_KIND_UI_ORDER.map((kind) => {
        const item = getPanelKindUiItem(kind)
        const Icon = item.icon
        const ownerTabCount = item.getOwnerTabCount(store)
        const panelCount = store.layout.getPanelIdsByKind(kind).length
        const isDetached = panelCount === 0
        const tooltip = railTooltipByKind[kind]
        return (
          <button
            key={kind}
            className={clsx('gyshell-panel-type-rail-btn', {
              'is-detached': isDetached
            })}
            title={`${t.layout[item.labelKey]} · ${tooltip}`}
            onClick={() => handleCreate(kind)}
          >
            <Icon size={14} strokeWidth={2.2} />
            <span className="gyshell-panel-type-rail-count">{ownerTabCount}</span>
          </button>
        )
      })}
    </div>
  )
})
