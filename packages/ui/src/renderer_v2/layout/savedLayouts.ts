import { buildLayoutTree, deriveLegacyLayoutSnapshot, parsePersistedLayoutV2 } from './tree'
import type { LayoutTree } from './types'

export const MAX_SAVED_LAYOUT_SLOTS = 3
export const SAVED_LAYOUT_SLOT_NUMBERS = [1, 2, 3] as const

export type SavedLayoutSlotNumber = (typeof SAVED_LAYOUT_SLOT_NUMBERS)[number]

export interface SavedLayoutSnapshot {
  panelOrder: string[]
  panelSizes: number[]
  v2: LayoutTree
}

export interface SavedLayoutSlot {
  id: string
  slotNumber: SavedLayoutSlotNumber
  createdAt: number
  updatedAt: number
  snapshot: SavedLayoutSnapshot
}

export interface SavedLayoutState {
  slots: SavedLayoutSlot[]
  activeSavedLayoutId: string | null
}

export interface SavedLayoutUpsertResult {
  slots: SavedLayoutSlot[]
  slot: SavedLayoutSlot | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cloneValue = <T>(value: T): T => {
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(value)
    } catch {
      // Fall through to JSON cloning for MobX/plain layout snapshots.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T
}

export const getSavedLayoutSlotId = (slotNumber: SavedLayoutSlotNumber): string => `layout-slot-${slotNumber}`

const normalizeSlotNumber = (value: unknown): SavedLayoutSlotNumber | null => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null
  }
  return SAVED_LAYOUT_SLOT_NUMBERS.includes(value as SavedLayoutSlotNumber) ? (value as SavedLayoutSlotNumber) : null
}

const normalizeTimestamp = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value
  }
  return fallback
}

export const sortSavedLayoutSlots = (slots: SavedLayoutSlot[]): SavedLayoutSlot[] =>
  [...slots].sort((left, right) => left.slotNumber - right.slotNumber)

const normalizeSnapshot = (value: unknown): SavedLayoutSnapshot | null => {
  if (!isRecord(value)) {
    return null
  }

  const parsedV2 = parsePersistedLayoutV2(value.v2)
  const tree =
    parsedV2 ||
    (() => {
      const panelOrder = Array.isArray(value.panelOrder)
        ? value.panelOrder.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : undefined
      if (!panelOrder || panelOrder.length === 0) {
        return null
      }
      const panelSizes = Array.isArray(value.panelSizes)
        ? value.panelSizes.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
        : undefined
      return buildLayoutTree({ panelOrder, panelSizes })
    })()
  if (!tree) {
    return null
  }

  const legacy = deriveLegacyLayoutSnapshot(tree)
  return {
    panelOrder: legacy.panelOrder,
    panelSizes: legacy.panelSizes,
    v2: cloneValue(tree)
  }
}

const normalizeSlot = (value: unknown): SavedLayoutSlot | null => {
  if (!isRecord(value)) {
    return null
  }

  const slotNumber = normalizeSlotNumber(value.slotNumber)
  if (!slotNumber) {
    return null
  }

  const snapshot = normalizeSnapshot(value.snapshot)
  if (!snapshot) {
    return null
  }

  const updatedAt = normalizeTimestamp(value.updatedAt, 0)
  const createdAt = normalizeTimestamp(value.createdAt, updatedAt)

  return {
    id: getSavedLayoutSlotId(slotNumber),
    slotNumber,
    createdAt,
    updatedAt,
    snapshot
  }
}

export const normalizeSavedLayoutState = (layout: unknown): SavedLayoutState => {
  const rawLayout = isRecord(layout) ? layout : {}
  const rawSlots = Array.isArray(rawLayout.savedLayouts) ? rawLayout.savedLayouts : []
  const seenSlotNumbers = new Set<SavedLayoutSlotNumber>()
  const slots: SavedLayoutSlot[] = []

  rawSlots.forEach((rawSlot) => {
    const slot = normalizeSlot(rawSlot)
    if (!slot || seenSlotNumbers.has(slot.slotNumber)) {
      return
    }
    seenSlotNumbers.add(slot.slotNumber)
    slots.push(slot)
  })

  const sortedSlots = sortSavedLayoutSlots(slots).slice(0, MAX_SAVED_LAYOUT_SLOTS)
  const activeId =
    typeof rawLayout.activeSavedLayoutId === 'string' &&
    sortedSlots.some((slot) => slot.id === rawLayout.activeSavedLayoutId)
      ? rawLayout.activeSavedLayoutId
      : null

  return {
    slots: sortedSlots,
    activeSavedLayoutId: activeId
  }
}

export const createSavedLayoutSnapshot = (tree: LayoutTree): SavedLayoutSnapshot => {
  const treeSnapshot = cloneValue(tree)
  const legacy = deriveLegacyLayoutSnapshot(treeSnapshot)
  return {
    panelOrder: legacy.panelOrder,
    panelSizes: legacy.panelSizes,
    v2: treeSnapshot
  }
}

export const getFirstAvailableSavedLayoutSlotNumber = (slots: SavedLayoutSlot[]): SavedLayoutSlotNumber | null => {
  const used = new Set(slots.map((slot) => slot.slotNumber))
  return SAVED_LAYOUT_SLOT_NUMBERS.find((slotNumber) => !used.has(slotNumber)) || null
}

export const addSavedLayoutSlot = (
  slots: SavedLayoutSlot[],
  tree: LayoutTree,
  now = Date.now()
): SavedLayoutUpsertResult => {
  const normalized = normalizeSavedLayoutState({ savedLayouts: slots }).slots
  const slotNumber = getFirstAvailableSavedLayoutSlotNumber(normalized)
  if (!slotNumber) {
    return {
      slots: normalized,
      slot: null
    }
  }

  const slot: SavedLayoutSlot = {
    id: getSavedLayoutSlotId(slotNumber),
    slotNumber,
    createdAt: now,
    updatedAt: now,
    snapshot: createSavedLayoutSnapshot(tree)
  }

  return {
    slots: sortSavedLayoutSlots([...normalized, slot]),
    slot
  }
}

export const deleteSavedLayoutSlot = (slots: SavedLayoutSlot[], slotId: string): SavedLayoutSlot[] => {
  const normalized = normalizeSavedLayoutState({ savedLayouts: slots }).slots
  return normalized.filter((slot) => slot.id !== slotId)
}

export const overwriteSavedLayoutSlot = (
  slots: SavedLayoutSlot[],
  slotId: string,
  tree: LayoutTree,
  now = Date.now()
): SavedLayoutUpsertResult => {
  const normalized = normalizeSavedLayoutState({ savedLayouts: slots }).slots
  let overwrittenSlot: SavedLayoutSlot | null = null
  const nextSlots = normalized.map((slot) => {
    if (slot.id !== slotId) {
      return slot
    }
    overwrittenSlot = {
      ...slot,
      updatedAt: now,
      snapshot: createSavedLayoutSnapshot(tree)
    }
    return overwrittenSlot
  })

  return {
    slots: overwrittenSlot ? sortSavedLayoutSlots(nextSlots) : normalized,
    slot: overwrittenSlot
  }
}

export const findSavedLayoutSlot = (slots: SavedLayoutSlot[], slotId: string): SavedLayoutSlot | null =>
  normalizeSavedLayoutState({ savedLayouts: slots }).slots.find((slot) => slot.id === slotId) || null
