import React from 'react'
import { RefreshCw } from 'lucide-react'
import type { SkillSummary } from '../../types'

interface SkillsPanelProps {
  skills: SkillSummary[]
  connectionStatus: 'connecting' | 'connected' | 'disconnected'
  onReload: () => void
  onSetSkillEnabled: (name: string, enabled: boolean) => Promise<void>
}

interface SkillGroup {
  key: string
  label: string
  order: number
  items: SkillSummary[]
}

function resolveSkillGroup(scanRoot: string | undefined): { key: string; label: string; order: number } {
  const root = String(scanRoot || '')
  const lower = root.toLowerCase()

  if (lower.includes('/.codex/') || lower.includes('\\.codex\\')) {
    return { key: 'codex', label: 'Codex Skills', order: 2 }
  }
  if (lower.includes('/.agents/') || lower.includes('\\.agents\\')) {
    return { key: 'agents', label: 'Agents Skills', order: 3 }
  }
  if (lower.includes('/.claude/') || lower.includes('\\.claude\\')) {
    return { key: 'claude', label: 'Claude Skills', order: 4 }
  }
  if (lower.includes('gyshell') || (lower.endsWith('/skills') && !lower.includes('/.')) || lower.endsWith('\\skills')) {
    return { key: 'custom', label: 'Custom Skills', order: 1 }
  }
  return {
    key: root || 'other',
    label: root || 'Other Skills',
    order: 5
  }
}

export const SkillsPanel: React.FC<SkillsPanelProps> = ({ skills, connectionStatus, onReload, onSetSkillEnabled }) => {
  const [reloading, setReloading] = React.useState(false)
  const [togglingNames, setTogglingNames] = React.useState<Set<string>>(new Set())
  const canMutate = connectionStatus === 'connected'

  const groupedSkills = React.useMemo<SkillGroup[]>(() => {
    const groups = new Map<string, SkillGroup>()
    for (const skill of skills) {
      const grouping = resolveSkillGroup(skill.scanRoot)
      const existing = groups.get(grouping.key)
      if (existing) {
        existing.items.push(skill)
      } else {
        groups.set(grouping.key, {
          key: grouping.key,
          label: grouping.label,
          order: grouping.order,
          items: [skill]
        })
      }
    }

    return [...groups.values()]
      .map((group) => ({
        ...group,
        items: [...group.items].sort((left, right) => left.name.localeCompare(right.name))
      }))
      .sort((left, right) => {
        if (left.order !== right.order) return left.order - right.order
        return left.label.localeCompare(right.label)
      })
  }, [skills])

  const enabledCount = skills.filter((skill) => skill.enabled !== false).length
  const allEnabled = skills.length > 0 && enabledCount === skills.length
  const someEnabled = enabledCount > 0 && !allEnabled

  const toggleOne = React.useCallback(
    async (name: string, enabled: boolean) => {
      setTogglingNames((previous) => new Set(previous).add(name))
      try {
        await onSetSkillEnabled(name, enabled)
      } finally {
        setTogglingNames((previous) => {
          const next = new Set(previous)
          next.delete(name)
          return next
        })
      }
    },
    [onSetSkillEnabled]
  )

  const toggleMany = React.useCallback(
    async (targets: SkillSummary[], enabled: boolean) => {
      for (const skill of targets) {
        if ((skill.enabled !== false) === enabled) continue
        await toggleOne(skill.name, enabled)
      }
    },
    [toggleOne]
  )

  const handleReload = React.useCallback(async () => {
    setReloading(true)
    try {
      await onReload()
    } finally {
      setReloading(false)
    }
  }, [onReload])

  return (
    <section className="panel-scroll skills-panel">
      <div className="panel-toolbar">
        <p className="panel-toolbar-meta">
          {enabledCount}/{skills.length} enabled
        </p>
        <div className="panel-toolbar-actions">
          <label className="skill-group-switch global">
            <input
              type="checkbox"
              checked={allEnabled}
              ref={(input) => {
                if (input) {
                  input.indeterminate = someEnabled
                }
              }}
              disabled={!canMutate || skills.length === 0}
              onChange={(event) => void toggleMany(skills, event.target.checked)}
            />
            <span>All</span>
          </label>
          <button
            type="button"
            className="panel-icon-btn"
            onClick={() => void handleReload()}
            disabled={reloading || !canMutate}
            aria-label="Refresh skills"
            title="Refresh skills"
          >
            <RefreshCw size={15} className={reloading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {skills.length === 0 ? (
        <p className="panel-empty">No skills available from gateway.</p>
      ) : (
        <div className="skill-sources">
          {groupedSkills.map((group) => {
            const groupAllEnabled = group.items.length > 0 && group.items.every((skill) => skill.enabled !== false)
            const groupSomeEnabled = group.items.some((skill) => skill.enabled !== false) && !groupAllEnabled

            return (
              <section key={group.key} className="skill-source-group">
                <header className="skill-source-head">
                  <h3>{group.label}</h3>
                  <label className="skill-group-switch">
                    <input
                      type="checkbox"
                      checked={groupAllEnabled}
                      ref={(input) => {
                        if (input) {
                          input.indeterminate = groupSomeEnabled
                        }
                      }}
                      disabled={!canMutate}
                      onChange={(event) => void toggleMany(group.items, event.target.checked)}
                    />
                    <span>All</span>
                  </label>
                </header>

                <div className="skill-list">
                  {group.items.map((skill) => {
                    const enabled = skill.enabled !== false
                    const busy = togglingNames.has(skill.name)
                    return (
                      <article key={skill.name} className="skill-item">
                        <div className="skill-item-body">
                          <h3>@{skill.name}</h3>
                          <p>{skill.description || 'No description'}</p>
                        </div>
                        <button
                          type="button"
                          className={`skill-toggle ${enabled ? 'enabled' : ''}`}
                          onClick={() => void toggleOne(skill.name, !enabled)}
                          disabled={!canMutate || busy}
                          aria-label={`${enabled ? 'Disable' : 'Enable'} ${skill.name}`}
                        >
                          {busy ? '...' : enabled ? 'On' : 'Off'}
                        </button>
                      </article>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}
