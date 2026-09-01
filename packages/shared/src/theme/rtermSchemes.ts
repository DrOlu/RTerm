import type { TerminalColorScheme } from './terminalColorSchemes'

/**
 * The RTerm mode pair (v3.7.1) — hand-tuned, not imported.
 *
 * DARK: a true neutral graphite (#0d0d0f base, near-black), NOT the old
 * deep-blue Aurora. Terminal foreground at 88% white for strong contrast;
 * the 16 ANSI colors tuned for legibility on graphite.
 *
 * LIGHT: clean paper white (#ffffff), ink foreground, ANSI colors at
 * print-grade saturation.
 */

export const RTerm_DARK: TerminalColorScheme = {
  name: 'RTerm Dark',
  foreground: '#e6e6e9',
  background: '#0d0d0f',
  cursor: '#e6e6e9',
  colors: [
    '#1a1a1e', // black
    '#f87171', // red
    '#4ade80', // green
    '#facc15', // yellow
    '#60a5fa', // blue
    '#c084fc', // magenta
    '#22d3ee', // cyan
    '#a1a1aa', // white
    '#3f3f46', // bright black
    '#fca5a5', // bright red
    '#86efac', // bright green
    '#fde047', // bright yellow
    '#93c5fd', // bright blue
    '#d8b4fe', // bright magenta
    '#67e8f9', // bright cyan
    '#f4f4f5', // bright white
  ],
}

export const RTerm_LIGHT: TerminalColorScheme = {
  name: 'RTerm Light',
  foreground: '#1a1a1e',
  background: '#ffffff',
  cursor: '#1a1a1e',
  colors: [
    '#1a1a1e', // black
    '#dc2626', // red
    '#16a34a', // green
    '#ca8a04', // yellow
    '#2563eb', // blue
    '#9333ea', // magenta
    '#0891b2', // cyan
    '#71717a', // white
    '#52525b', // bright black
    '#ef4444', // bright red
    '#22c55e', // bright green
    '#eab308', // bright yellow
    '#3b82f6', // bright blue
    '#a855f7', // bright magenta
    '#06b6d4', // bright cyan
    '#18181b', // bright white
  ],
}