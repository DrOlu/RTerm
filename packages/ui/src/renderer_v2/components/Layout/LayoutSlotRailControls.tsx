import React from 'react'
import clsx from 'clsx'
import { observer } from 'mobx-react-lite'
import { Plus } from 'lucide-react'
import type { AppStore } from '../../stores/AppStore'
import { ConfirmDialog } from '../Common/ConfirmDialog'
import { resolveFloatingMenuPlacement } from '../../lib/menuPlacement'

interface LayoutSlotRailControlsProps {
  store: AppStore
}

interface SlotMenuState {
  slotId: string
  x: number
  y: number
}

type PendingLayoutSlotAction =
  | { type: 'save' }
  | { type: 'overwrite'; slotId: string }
  | { type: 'delete'; slotId: string }

export const LayoutSlotRailControls: React.FC<LayoutSlotRailControlsProps> = observer(({ store }) => {
  const t = store.i18n.t
  const menuRef = React.useRef<HTMLDivElement | null>(null)
  const [slotMenu, setSlotMenu] = React.useState<SlotMenuState | null>(null)
  const [slotMenuStyle, setSlotMenuStyle] = React.useState<React.CSSProperties | undefined>(undefined)
  const [pendingAction, setPendingAction] = React.useState<PendingLayoutSlotAction | null>(null)
  const [busy, setBusy] = React.useState(false)

  const recomputeMenuStyle = React.useCallback(() => {
    const menu = menuRef.current
    if (!slotMenu || !menu) return

    const measured = menu.getBoundingClientRect()
    const placement = resolveFloatingMenuPlacement({
      anchorRect: {
        left: slotMenu.x,
        top: slotMenu.y,
        width: 0,
        height: 0
      },
      menuWidth: Math.ceil(measured.width),
      menuHeight: Math.ceil(measured.height),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      margin: 8,
      gap: 2,
      preferredMaxHeight: 160
    })

    setSlotMenuStyle({
      left: placement.left,
      top: placement.top,
      maxHeight: placement.maxHeight,
      maxWidth: placement.maxWidth
    })
  }, [slotMenu])

  React.useEffect(() => {
    if (!slotMenu) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && menuRef.current?.contains(target)) return
      setSlotMenu(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSlotMenu(null)
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', recomputeMenuStyle)
    window.addEventListener('scroll', recomputeMenuStyle, true)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', recomputeMenuStyle)
      window.removeEventListener('scroll', recomputeMenuStyle, true)
    }
  }, [slotMenu, recomputeMenuStyle])

  React.useEffect(() => {
    if (!slotMenu) {
      setSlotMenuStyle(undefined)
    }
  }, [slotMenu])

  React.useLayoutEffect(() => {
    if (!slotMenu) return
    recomputeMenuStyle()
  }, [slotMenu, recomputeMenuStyle])

  const runBusyAction = React.useCallback(
    async (action: () => Promise<unknown>) => {
      if (busy) return
      setBusy(true)
      try {
        await action()
      } finally {
        setBusy(false)
      }
    },
    [busy]
  )

  const pendingActionSlot =
    pendingAction && pendingAction.type !== 'save'
      ? store.layout.savedLayoutSlots.find((slot) => slot.id === pendingAction.slotId) || null
      : null

  const pendingDialog = (() => {
    if (!pendingAction) {
      return null
    }

    if (pendingAction.type === 'save') {
      return {
        title: t.layout.saveCurrentLayoutTitle,
        message: t.layout.saveCurrentLayoutMessage,
        confirmText: t.common.save,
        danger: false,
        onConfirm: () => {
          void runBusyAction(async () => {
            await store.layout.saveCurrentLayoutSlot()
            setPendingAction(null)
          })
        }
      }
    }

    if (!pendingActionSlot) {
      return null
    }

    if (pendingAction.type === 'overwrite') {
      return {
        title: t.layout.overwriteSavedLayoutTitle,
        message: t.layout.overwriteSavedLayoutMessage(pendingActionSlot.slotNumber),
        confirmText: t.layout.overwriteSavedLayoutConfirm,
        danger: true,
        onConfirm: () => {
          void runBusyAction(async () => {
            await store.layout.overwriteSavedLayoutSlot(pendingActionSlot.id)
            setPendingAction(null)
          })
        }
      }
    }

    return {
      title: t.layout.deleteSavedLayoutTitle,
      message: t.layout.deleteSavedLayoutMessage(pendingActionSlot.slotNumber),
      confirmText: t.common.delete,
      danger: true,
      onConfirm: () => {
        void runBusyAction(async () => {
          await store.layout.deleteSavedLayoutSlot(pendingActionSlot.id)
          setPendingAction(null)
        })
      }
    }
  })()

  React.useEffect(() => {
    if (pendingAction && pendingAction.type !== 'save' && !pendingActionSlot) {
      setPendingAction(null)
    }
  }, [pendingAction, pendingActionSlot])

  const openPendingSaveDialog = React.useCallback(() => {
    if (busy || !store.layout.canSaveCurrentLayoutSlot) {
      return
    }
    setPendingAction({ type: 'save' })
  }, [busy, store.layout])

  const closePendingDialog = React.useCallback(() => {
    setPendingAction(null)
  }, [])

  if (!store.layout.canUseSavedLayoutSlots) {
    return null
  }

  return (
    <div className="gyshell-layout-slot-rail">
      {store.layout.savedLayoutSlots.map((slot) => (
        <button
          key={slot.id}
          className={clsx('gyshell-layout-slot-btn', {
            'is-active': store.layout.activeSavedLayoutId === slot.id
          })}
          type="button"
          title={t.layout.savedLayoutSlot(slot.slotNumber)}
          aria-label={t.layout.savedLayoutSlot(slot.slotNumber)}
          disabled={busy}
          onClick={() => {
            void runBusyAction(() => store.layout.applySavedLayoutSlot(slot.id))
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            if (busy) return
            setSlotMenu({
              slotId: slot.id,
              x: event.clientX,
              y: event.clientY
            })
          }}
        >
          <span className="gyshell-layout-slot-number">{slot.slotNumber}</span>
        </button>
      ))}

      {store.layout.canSaveCurrentLayoutSlot ? (
        <button
          className="gyshell-layout-slot-btn is-save"
          type="button"
          title={t.layout.saveCurrentLayout}
          aria-label={t.layout.saveCurrentLayout}
          disabled={busy}
          onClick={openPendingSaveDialog}
        >
          <Plus size={15} strokeWidth={2.4} />
        </button>
      ) : null}

      {slotMenu ? (
        <div
          ref={menuRef}
          className="gyshell-layout-menu gyshell-layout-slot-menu"
          style={
            slotMenuStyle || {
              left: slotMenu.x,
              top: slotMenu.y,
              visibility: 'hidden'
            }
          }
        >
          <button
            className="gyshell-layout-menu-item"
            type="button"
            onClick={() => {
              setPendingAction({ type: 'overwrite', slotId: slotMenu.slotId })
              setSlotMenu(null)
            }}
          >
            {t.layout.overwriteWithCurrentLayout}
          </button>
          <button
            className="gyshell-layout-menu-item is-danger"
            type="button"
            onClick={() => {
              setPendingAction({ type: 'delete', slotId: slotMenu.slotId })
              setSlotMenu(null)
            }}
          >
            {t.common.delete}
          </button>
        </div>
      ) : null}

      {pendingDialog ? (
        <ConfirmDialog
          open
          title={pendingDialog.title}
          message={pendingDialog.message}
          confirmText={pendingDialog.confirmText}
          cancelText={t.common.cancel}
          danger={pendingDialog.danger}
          loading={busy}
          onCancel={closePendingDialog}
          onConfirm={pendingDialog.onConfirm}
        />
      ) : null}
    </div>
  )
})
