import React from 'react'
import { observer } from 'mobx-react-lite'
import { toastStore } from './ToastStore'

/**
 * Mounted once at the app root. Renders the bottom-right toast stack. Pure
 * presentation; state lives in the singleton toastStore.
 */
export const ToastStack: React.FC = observer(() => {
  const [leaving, setLeaving] = React.useState<Set<string>>(new Set())
  const handleDismiss = (id: string) => {
    setLeaving((prev) => new Set(prev).add(id))
    setTimeout(() => {
      toastStore.dismiss(id)
      setLeaving((prev) => {
        const n = new Set(prev)
        n.delete(id)
        return n
      })
    }, 120)
  }
  if (!toastStore.items.length) return null
  return (
    <div className="rterm-toast-stack" role="status" aria-live="polite">
      {toastStore.items.map((t) => (
        <div
          key={t.id}
          className={`rterm-toast ${t.kind ?? ''} ${leaving.has(t.id) ? 'leaving' : ''}`}
          onClick={() => handleDismiss(t.id)}
        >
          <div className="rterm-toast-body">
            {t.title && <div className="rterm-toast-title">{t.title}</div>}
            {t.message && <div className="rterm-toast-msg">{t.message}</div>}
          </div>
          {t.actionLabel && t.onAction && (
            <button
              className="rterm-toast-action"
              onClick={(e) => {
                e.stopPropagation()
                t.onAction?.()
                handleDismiss(t.id)
              }}
            >
              {t.actionLabel}
            </button>
          )}
        </div>
      ))}
    </div>
  )
})
