import { makeObservable, observable, action } from 'mobx'

/**
 * Global toast store — a consistent bottom-right notification system for
 * "Saved", "Imported 3 connections", "Build started", etc., with optional
 * undo. Mounted once at the app root by <ToastStack />.
 *
 * Usage from any component:
 *   toastStore.push({ title: 'Saved', message: 'Connection updated', kind: 'success' })
 *   const undo = () => toastStore.push({ title: 'Deleted', message: 'web-1', actionLabel: 'Undo', onAction: restore })
 */
export interface ToastItem {
  id: string
  title?: string
  message?: string
  kind?: 'default' | 'success' | 'danger'
  actionLabel?: string
  onAction?: () => void
  /** Auto-dismiss ms (default 4500). 0 = sticky. */
  duration?: number
}

class ToastStore {
  items: ToastItem[] = []
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor() {
    makeObservable(this, { items: observable, push: action, dismiss: action })
  }

  push = (toast: Omit<ToastItem, 'id'>): string => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const item: ToastItem = { id, duration: 4500, ...toast }
    this.items.push(item)
    if (item.duration && item.duration > 0) {
      this.timers.set(id, setTimeout(() => this.dismiss(id), item.duration))
    }
    return id
  }

  dismiss = (id: string): void => {
    const idx = this.items.findIndex((t) => t.id === id)
    if (idx === -1) return
    this.items.splice(idx, 1)
    const t = this.timers.get(id)
    if (t) { clearTimeout(t); this.timers.delete(id) }
  }
}

export const toastStore = new ToastStore()
