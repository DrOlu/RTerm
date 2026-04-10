export type MonitorPresentationMode =
  | 'standard'
  | 'dense'
  | 'compact-horizontal'
  | 'compact-vertical'

export interface MonitorPresentationConfig {
  mode: MonitorPresentationMode
  historyBarCount: number
  cpuProcessRows: number
  memoryProcessRows: number
  coreRows: number
  interfaceRows: number
  socketRows: number
  diskRows: number
  gpuRows: number
  memoryTagCount: number
}

export interface MonitorVisibleCollection {
  visibleCount: number
  totalCount: number
  hiddenCount: number
  hasOverflow: boolean
  expanded: boolean
}

export interface MonitorVisibleRows<T> extends MonitorVisibleCollection {
  rows: T[]
}

const DEFAULT_CONFIG: Record<MonitorPresentationMode, Omit<MonitorPresentationConfig, 'mode'>> = {
  standard: {
    historyBarCount: 24,
    cpuProcessRows: 6,
    memoryProcessRows: 6,
    coreRows: 24,
    interfaceRows: 10,
    socketRows: 16,
    diskRows: 8,
    gpuRows: 4,
    memoryTagCount: 6,
  },
  dense: {
    historyBarCount: 18,
    cpuProcessRows: 4,
    memoryProcessRows: 4,
    coreRows: 12,
    interfaceRows: 6,
    socketRows: 8,
    diskRows: 5,
    gpuRows: 2,
    memoryTagCount: 4,
  },
  'compact-horizontal': {
    historyBarCount: 14,
    cpuProcessRows: 3,
    memoryProcessRows: 3,
    coreRows: 8,
    interfaceRows: 4,
    socketRows: 2,
    diskRows: 3,
    gpuRows: 1,
    memoryTagCount: 4,
  },
  'compact-vertical': {
    historyBarCount: 12,
    cpuProcessRows: 3,
    memoryProcessRows: 3,
    coreRows: 8,
    interfaceRows: 4,
    socketRows: 2,
    diskRows: 3,
    gpuRows: 1,
    memoryTagCount: 3,
  },
}

export const resolveMonitorPresentationMode = (
  width: number,
  height: number
): MonitorPresentationMode => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 'standard'
  }

  const horizontalAspect = width / Math.max(height, 1)
  const verticalAspect = height / Math.max(width, 1)

  if ((width <= 230 && verticalAspect >= 1.35) || width <= 140) {
    return 'compact-vertical'
  }

  if ((height <= 215 && horizontalAspect >= 1.85) || (height <= 150 && width >= 320)) {
    return 'compact-horizontal'
  }

  if (width <= 1180 || height <= 860) {
    return 'dense'
  }

  return 'standard'
}

export const getMonitorPresentationConfig = (
  width: number,
  height: number
): MonitorPresentationConfig => {
  const mode = resolveMonitorPresentationMode(width, height)
  return {
    mode,
    ...DEFAULT_CONFIG[mode],
  }
}

export const resolveMonitorVisibleRows = <T>(
  rows: readonly T[] | null | undefined,
  collapsedCount: number,
  expanded: boolean
): MonitorVisibleRows<T> => {
  const allRows = Array.isArray(rows) ? [...rows] : []
  const normalizedCollapsedCount = Number.isFinite(collapsedCount)
    ? Math.max(1, Math.floor(collapsedCount))
    : allRows.length || 1
  const hasOverflow = allRows.length > normalizedCollapsedCount
  const visibleRows =
    expanded || !hasOverflow ? allRows : allRows.slice(0, normalizedCollapsedCount)

  return {
    rows: visibleRows,
    visibleCount: visibleRows.length,
    totalCount: allRows.length,
    hiddenCount: Math.max(0, allRows.length - visibleRows.length),
    hasOverflow,
    expanded,
  }
}
