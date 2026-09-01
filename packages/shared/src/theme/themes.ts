import type { TerminalColorScheme } from './terminalColorSchemes'
import { RTerm_DARK, RTerm_LIGHT } from './rtermSchemes'

export type ThemeId = string

export interface AppTheme {
  id: ThemeId
  name: string
  terminal: TerminalColorScheme
}

/**
 * v3.7.1 — the theme system is TWO MODES: light and dark.
 *
 * The 190 Tabby-imported schemes were removed. What shipped instead is one
 * hand-tuned pair: a true neutral dark (not the old deep-blue Aurora) with
 * strong contrast, and a clean light. The terminal colors follow the mode.
 *
 * Custom themes (the user's own schemes file) still work — they are offered
 * alongside the two modes and are mapped by luminance into the nearest
 * mode's UI tokens.
 */
export const BUILTIN_THEMES: AppTheme[] = [
  { id: 'rterm-dark', name: 'Dark', terminal: RTerm_DARK },
  { id: 'rterm-light', name: 'Light', terminal: RTerm_LIGHT },
]

export function getAllThemes(customThemes: TerminalColorScheme[] = []): AppTheme[] {
  const custom = customThemes.map((theme) => ({
    id: theme.name,
    name: theme.name,
    terminal: theme
  }))
  return [...BUILTIN_THEMES, ...custom]
}

export function resolveTheme(themeId: string | undefined, customThemes: TerminalColorScheme[] = []): AppTheme {
  const custom = customThemes.find((t) => t.name === themeId)
  if (custom) {
    return { id: custom.name, name: custom.name, terminal: custom }
  }
  const builtin = BUILTIN_THEMES.find((t) => t.id === themeId)
  if (builtin) return builtin
  // Legacy ids from the old 190-theme system map to the nearest mode so a
  // stored settings.themeId never breaks.
  const legacyLight = ['gyshell-light', 'Tabby Default Light']
  if (themeId && legacyLight.some((id) => themeId.toLowerCase().includes(id.toLowerCase().replace('Tabby ', '')))) {
    return BUILTIN_THEMES[1]
  }
  return BUILTIN_THEMES[0]
}