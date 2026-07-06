import {
  DEFAULT_PANEL_TAB_DISPLAY_MODE,
  type PanelTabDisplayModePreference,
} from '@gyshell/shared'
import type { PanelKind } from '../../layout'

export type PanelTabBarMode = 'strip' | 'select'
export type FileSystemToolbarMode = 'inline' | 'stacked'

interface PanelTabBarLayoutConfig {
  hardCompactWidth: number
}

const PANEL_TAB_BAR_LAYOUT: Record<PanelKind, PanelTabBarLayoutConfig> = {
  terminal: {
    hardCompactWidth: 260
  },
  chat: {
    hardCompactWidth: 360
  },
  filesystem: {
    hardCompactWidth: 260
  },
  fileEditor: {
    hardCompactWidth: 0
  },
  monitor: {
    hardCompactWidth: 260
  },
  listPanel: {
    hardCompactWidth: 260
  }
}

const FILESYSTEM_STACKED_TOOLBAR_WIDTH = 400

export const resolvePanelTabBarMode = (
  kind: PanelKind,
  width: number,
  tabCount: number,
  displayMode: PanelTabDisplayModePreference = DEFAULT_PANEL_TAB_DISPLAY_MODE,
): PanelTabBarMode => {
  if (tabCount <= 0) {
    return 'strip'
  }

  if (displayMode === 'expanded') {
    return 'strip'
  }

  if (displayMode === 'select') {
    return 'select'
  }

  if (!Number.isFinite(width) || width <= 0 || tabCount <= 1) {
    return 'strip'
  }

  const config = PANEL_TAB_BAR_LAYOUT[kind]
  return width <= config.hardCompactWidth ? 'select' : 'strip'
}

export const resolveFilesystemToolbarMode = (
  width: number
): FileSystemToolbarMode => {
  if (!Number.isFinite(width) || width <= 0) {
    return 'inline'
  }
  return width <= FILESYSTEM_STACKED_TOOLBAR_WIDTH ? 'stacked' : 'inline'
}
