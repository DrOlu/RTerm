import type { PanelKind } from './types'

export type PanelKindCategory = 'normal' | 'special'
export type RailPanelKind = Extract<PanelKind, 'chat' | 'terminal' | 'filesystem'>
export type TabbedPanelKind = Extract<PanelKind, 'chat' | 'terminal' | 'filesystem'>

export interface PanelKindMeta {
  kind: PanelKind
  category: PanelKindCategory
  supportsTabs: boolean
  showInRail: boolean
  maxPanels?: number
}

const PANEL_KIND_META_REGISTRY: Record<PanelKind, PanelKindMeta> = {
  chat: {
    kind: 'chat',
    category: 'normal',
    supportsTabs: true,
    showInRail: true
  },
  terminal: {
    kind: 'terminal',
    category: 'normal',
    supportsTabs: true,
    showInRail: true
  },
  filesystem: {
    kind: 'filesystem',
    category: 'normal',
    supportsTabs: true,
    showInRail: true
  },
  fileEditor: {
    kind: 'fileEditor',
    category: 'special',
    supportsTabs: false,
    showInRail: false,
    maxPanels: 1
  }
}

const hasOwn = (value: unknown): value is keyof typeof PANEL_KIND_META_REGISTRY =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(PANEL_KIND_META_REGISTRY, value)

export const isPanelKind = (value: unknown): value is PanelKind => hasOwn(value)

export const PANEL_KIND_ORDER: readonly PanelKind[] = Object.freeze(
  Object.keys(PANEL_KIND_META_REGISTRY) as PanelKind[]
)

export const PANEL_KINDS_WITH_TABS: readonly TabbedPanelKind[] = Object.freeze(
  PANEL_KIND_ORDER.filter((kind) => PANEL_KIND_META_REGISTRY[kind].supportsTabs) as TabbedPanelKind[]
)

export const PANEL_KINDS_WITH_RAIL: readonly RailPanelKind[] = Object.freeze(
  PANEL_KIND_ORDER.filter((kind) => PANEL_KIND_META_REGISTRY[kind].showInRail) as RailPanelKind[]
)

export const getPanelKindMeta = (kind: PanelKind): PanelKindMeta => PANEL_KIND_META_REGISTRY[kind]

