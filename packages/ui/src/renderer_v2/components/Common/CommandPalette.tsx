import React from 'react'
import { observer } from 'mobx-react-lite'
import { Server, MonitorCog, Cable, Settings, FolderTree, Clock, FileCode, Activity, Upload, Radio } from 'lucide-react'
import { broadcastStore } from '../../stores/BroadcastStore'
import type { AppStore } from '../../stores/AppStore'

/**
 * Cmd/Ctrl+K command palette — fuzzy "do anything" launcher. Mounted at the
 * app root; toggled by the global keybinding wired in App.tsx. Lists
 * connections to open, panels to open, and toggles. Keyboard-first.
 */
interface PaletteItem {
  id: string
  label: string
  hint?: string
  icon: React.ReactNode
  run: () => void
}

function fuzzyMatch(query: string, label: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  const l = label.toLowerCase()
  if (l.includes(q)) return true
  // simple subsequence match
  let qi = 0
  for (let li = 0; li < l.length && qi < q.length; li++) {
    if (l[li] === q[qi]) qi++
  }
  return qi === q.length
}

export const CommandPalette: React.FC<{ store: AppStore }> = observer(({ store }) => {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)

  // expose a global toggler so App.tsx can call without prop-drilling
  React.useEffect(() => {
    ;(window as any).__rtermTogglePalette = () => {
      setOpen((o) => !o)
      setQuery('')
      setActive(0)
    }
    return () => { delete (window as any).__rtermTogglePalette }
  }, [])

  React.useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30)
  }, [open])

  if (!open) return null

  const items: PaletteItem[] = []
  // Open connections
  const ssh = store.settings?.connections?.ssh ?? []
  const winrm = store.settings?.connections?.winrm ?? []
  const serial = store.settings?.connections?.serial ?? []
  for (const e of ssh) items.push({ id: `ssh-${e.id}`, label: `Open SSH: ${e.name}`, hint: e.host, icon: <Server size={16} />, run: () => { store.createSshTab(e.id); setOpen(false) } })
  for (const e of winrm) items.push({ id: `winrm-${e.id}`, label: `Open WinRM: ${e.name}`, hint: e.host, icon: <MonitorCog size={16} />, run: () => { store.createWinrmTab(e.id); setOpen(false) } })
  for (const e of serial) items.push({ id: `serial-${e.id}`, label: `Open Serial: ${e.name}`, hint: e.path, icon: <Cable size={16} />, run: () => { store.createSerialTab(e.id); setOpen(false) } })
  // Panels / views
  items.push({ id: 'connections', label: 'Open Connections', icon: <FolderTree size={16} />, run: () => { store.openConnections(); setOpen(false) } })
  items.push({ id: 'settings', label: 'Open Settings', icon: <Settings size={16} />, run: () => { store.openSettings(); setOpen(false) } })
  // Toggles
  const loggingOn = store.settings?.sessionLogging?.enabled === true
  items.push({ id: 'toggle-logging', label: loggingOn ? 'Session logging: On (turn off)' : 'Session logging: Off (turn on)', icon: <Activity size={16} />, run: () => { store.setSessionLoggingEnabled(!loggingOn); setOpen(false) } })
  // Broadcast input (Terminator-style): toggle mode + manage membership of open terminals
  const bcOn = broadcastStore.enabled
  items.push({ id: 'broadcast-toggle', label: bcOn ? `Broadcast input: On (${broadcastStore.activeMemberIds.length} targets) — turn off` : 'Broadcast input: Off (turn on)', hint: 'send keystrokes to multiple terminals', icon: <Radio size={16} />, run: () => { broadcastStore.toggle(); setOpen(false) } })
  for (const tab of store.terminalTabs) {
    const inGroup = broadcastStore.isMember(tab.id)
    items.push({
      id: `broadcast-member-${tab.id}`,
      label: `${inGroup ? '✓ ' : ''}Broadcast group: ${tab.title || tab.id}`,
      hint: inGroup ? 'in group — remove' : 'add to group',
      icon: <Radio size={16} />,
      run: () => { broadcastStore.toggleMember(tab.id); setOpen(false) },
    })
  }
  // Script / task / template quick-open hint (deep-link into Connections sections)
  items.push({ id: 'goto-scripts', label: 'Go to Scripts', hint: 'Connections panel', icon: <FileCode size={16} />, run: () => { store.openConnections(); setOpen(false) } })
  items.push({ id: 'goto-tasks', label: 'Go to Scheduled Tasks', hint: 'Connections panel', icon: <Clock size={16} />, run: () => { store.openConnections(); setOpen(false) } })
  // PuTTY import (opens file picker via store helper)
  items.push({ id: 'putty-import', label: 'Import PuTTY sessions…', hint: '.reg file', icon: <Upload size={16} />, run: () => { document.dispatchEvent(new CustomEvent('rterm:putty-import')); setOpen(false) } })

  const filtered = items.filter((it) => fuzzyMatch(query, it.label))
  const clampedActive = Math.min(active, filtered.length - 1)

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const it = filtered[clampedActive]; if (it) it.run() }
  }

  return (
    <>
      <div className="rterm-palette-backdrop" onClick={() => setOpen(false)} />
      <div className="rterm-palette" role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="rterm-palette-input"
          placeholder="Search commands, connections, actions…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0) }}
          onKeyDown={onKeyDown}
        />
        <div className="rterm-palette-list">
          {filtered.length === 0 && <div className="rterm-palette-empty">No matches</div>}
          {filtered.map((it, i) => (
            <div
              key={it.id}
              className={`rterm-palette-item ${i === clampedActive ? 'is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => it.run()}
            >
              <span className="pi-ic">{it.icon}</span>
              <span className="pi-t">{it.label}</span>
              {it.hint && <span className="pi-h">{it.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </>
  )
})
