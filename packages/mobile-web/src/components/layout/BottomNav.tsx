import React from 'react'
import type { LucideIcon } from 'lucide-react'
import { MessageCircle, Settings, Sparkles, TerminalSquare, Wrench } from 'lucide-react'

export type MobileTabKey = 'chat' | 'terminal' | 'skills' | 'tools' | 'settings'

interface BottomNavProps {
  activeTab: MobileTabKey
  onChange: (tab: MobileTabKey) => void
}

const TABS: Array<{ key: MobileTabKey; label: string; icon: LucideIcon }> = [
  { key: 'chat', label: 'Chat', icon: MessageCircle },
  { key: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { key: 'skills', label: 'Skills', icon: Sparkles },
  { key: 'tools', label: 'Tools', icon: Wrench },
  { key: 'settings', label: 'Settings', icon: Settings }
]

export const BottomNav: React.FC<BottomNavProps> = ({ activeTab, onChange }) => {
  return (
    <nav className="bottom-nav" aria-label="Main tabs">
      {TABS.map((tab) => {
        const Icon = tab.icon
        return (
        <button
          key={tab.key}
          type="button"
          className={`bottom-nav-item ${activeTab === tab.key ? 'active' : ''}`}
          onClick={() => onChange(tab.key)}
          aria-label={tab.label}
          title={tab.label}
        >
          <Icon size={16} />
          <span className="sr-only">{tab.label}</span>
        </button>
        )
      })}
    </nav>
  )
}
