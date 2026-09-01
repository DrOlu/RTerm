import type { TerminalColorScheme } from './terminalColorSchemes'

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.replace('#', '').trim()
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  if (full.length !== 6) return null
  const n = Number.parseInt(full, 16)
  if (Number.isNaN(n)) return null
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (x: number) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

function rgbToCssValue(rgb: { r: number; g: number; b: number }): string {
  return `${rgb.r}, ${rgb.g}, ${rgb.b}`
}

function luminance(hex: string): number {
  const rgb = hexToRgb(hex)
  if (!rgb) return 0.5
  const srgb = [rgb.r, rgb.g, rgb.b].map((v) => v / 255)
  const lin = srgb.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

// amount: -1..1 (negative = darker, positive = lighter)
function shade(hex: string, amount: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const t = amount < 0 ? 0 : 255
  const p = Math.abs(amount)
  return rgbToHex(
    rgb.r + (t - rgb.r) * p,
    rgb.g + (t - rgb.g) * p,
    rgb.b + (t - rgb.b) * p
  )
}

/**
 * v3.7.1 — apply a theme to the UI.
 *
 * THE REGRESSION THIS FIXES: since the Phase 3 token migration the SCSS
 * reads the SEMANTIC tokens (--color-bg, --color-fg, ...), but this
 * function only set the LEGACY names (--app-bg, --fg, ...) — so theme
 * switching silently stopped reaching the UI. The semantic tokens alias
 * static primitives in tokens.scss, which is right for the DEFAULT look
 * but meant runtime theme values were never consumed.
 *
 * Now we set the SEMANTIC layer directly (plus the legacy names for any
 * straggler). The two builtin modes are hand-tuned palettes; a custom
 * scheme is derived by luminance into the nearest mode's structure, with
 * its own accent/status colors.
 */
export function applyAppThemeFromTerminalScheme(scheme: TerminalColorScheme): void {
  const root = document.documentElement.style
  root.setProperty('data-theme-applied', scheme.name)

  const bg = scheme.background
  const fg = scheme.foreground
  const accent = scheme.colors[4]
  const accent2 = scheme.colors[5]
  const isDark = luminance(bg) < 0.5

  // ---- the two hand-tuned modes --------------------------------
  // These are the DESIGNED palettes: a true neutral graphite dark (not the
  // old deep-blue Aurora) with strong contrast, and a clean paper light.
  const DARK = {
    bg: '#0d0d0f', surface: '#141417', surface2: '#101013', raised: '#1b1b20',
    fg: '#f2f2f4', fgMuted: '#b6b6bd', fgFaint: '#8a8a93',
    border: 'rgba(255, 255, 255, 0.09)', borderStrong: 'rgba(255, 255, 255, 0.16)',
    fill: 'rgba(255, 255, 255, 0.055)', fillHover: 'rgba(255, 255, 255, 0.09)',
    fillActive: 'rgba(255, 255, 255, 0.13)',
    shadow: '0 10px 30px rgba(0, 0, 0, 0.55)',
    ringOffset: '#0d0d0f',
  }
  const LIGHT = {
    bg: '#ffffff', surface: '#ffffff', surface2: '#f6f6f7', raised: '#ffffff',
    fg: '#1a1a1e', fgMuted: '#55555e', fgFaint: '#8a8a93',
    border: 'rgba(0, 0, 0, 0.10)', borderStrong: 'rgba(0, 0, 0, 0.18)',
    fill: 'rgba(0, 0, 0, 0.04)', fillHover: 'rgba(0, 0, 0, 0.07)',
    fillActive: 'rgba(0, 0, 0, 0.10)',
    shadow: '0 10px 30px rgba(0, 0, 0, 0.12)',
    ringOffset: '#ffffff',
  }

  const m = isDark ? DARK : LIGHT

  // Is this one of the two designed modes, or a custom scheme to derive?
  const isBuiltinDark = bg.toLowerCase() === '#0d0d0f'
  const isBuiltinLight = bg.toLowerCase() === '#ffffff'

  const set = (name: string, value: string) => root.setProperty(name, value)

  // ---- semantic: surfaces ----
  set('--color-bg', isBuiltinDark || isBuiltinLight ? m.bg : bg)
  set('--color-surface', isBuiltinDark || isBuiltinLight ? m.surface : shade(bg, isDark ? 0.05 : -0.02))
  set('--color-surface-2', isBuiltinDark || isBuiltinLight ? m.surface2 : shade(bg, isDark ? 0.02 : -0.035))
  set('--color-surface-raised', isBuiltinDark || isBuiltinLight ? m.raised : shade(bg, isDark ? 0.08 : -0.055))

  // ---- semantic: text ----
  set('--color-fg', fg)
  set('--color-fg-muted', isBuiltinDark || isBuiltinLight ? m.fgMuted : shade(fg, isDark ? 0.22 : -0.35))
  set('--color-fg-faint', isBuiltinDark || isBuiltinLight ? m.fgFaint : shade(fg, isDark ? 0.42 : -0.5))

  // ---- semantic: lines + fills ----
  set('--color-border', m.border)
  set('--color-border-strong', m.borderStrong)
  set('--color-fill', m.fill)
  set('--color-fill-hover', m.fillHover)
  set('--color-fill-active', m.fillActive)

  // ---- semantic: brand + status ----
  set('--color-primary', accent)
  const accentRgb = hexToRgb(accent)
  if (accentRgb) set('--color-primary-rgb', rgbToCssValue(accentRgb))
  else root.removeProperty('--color-primary-rgb')
  set('--color-secondary', accent2)
  const accent2Rgb = hexToRgb(accent2)
  if (accent2Rgb) set('--color-secondary-rgb', rgbToCssValue(accent2Rgb))
  set('--color-danger', scheme.colors[1])
  set('--color-success', scheme.colors[2])
  set('--color-warning', scheme.colors[3])

  // on-color pairs: dark ink on bright fills, light on dark fills
  set('--color-on-primary', isDark ? '#0b0b0d' : '#ffffff')
  set('--color-on-danger', isDark ? '#1a0508' : '#ffffff')
  set('--color-on-success', isDark ? '#04220f' : '#ffffff')

  // ---- semantic: focus + elevation ----
  set('--color-ring', accentRgb
    ? `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.55)`
    : 'rgba(96, 165, 250, 0.55)')
  set('--color-ring-offset', m.ringOffset)
  set('--shadow-md', m.shadow)

  // ---- legacy names (stragglers + the tokens.scss aliases resolve these
  //      at load; setting them keeps any unmigrated reference correct) ----
  set('--app-bg', isBuiltinDark || isBuiltinLight ? m.bg : bg)
  set('--panel-bg', isBuiltinDark || isBuiltinLight ? m.surface : shade(bg, isDark ? 0.05 : -0.02))
  set('--panel-bg-2', isBuiltinDark || isBuiltinLight ? m.surface2 : shade(bg, isDark ? 0.02 : -0.035))
  set('--fg', fg)
  set('--fg-muted', isBuiltinDark || isBuiltinLight ? m.fgMuted : shade(fg, isDark ? 0.22 : -0.35))
  set('--fg-faint', isBuiltinDark || isBuiltinLight ? m.fgFaint : shade(fg, isDark ? 0.42 : -0.5))
  set('--border', m.border)
  set('--border-strong', m.borderStrong)
  set('--control-bg', m.fill)
  set('--control-bg-hover', m.fillHover)
  set('--control-bg-active', m.fillActive)
  set('--accent', accent)
  if (accentRgb) set('--accent-rgb', rgbToCssValue(accentRgb))
  set('--accent-2', accent2)
  set('--danger', scheme.colors[1])
  set('--success', scheme.colors[2])
  set('--warning', scheme.colors[3])
  set('--shadow', m.shadow)
}