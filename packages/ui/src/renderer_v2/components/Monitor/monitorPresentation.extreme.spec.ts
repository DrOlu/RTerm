import {
  getMonitorPresentationConfig,
  resolveMonitorVisibleRows,
  resolveMonitorPresentationMode,
} from './monitorPresentation'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

runCase('resolveMonitorPresentationMode keeps large panels in standard mode', () => {
  assertEqual(resolveMonitorPresentationMode(1400, 980), 'standard', 'large balanced monitor panels should stay standard')
})

runCase('resolveMonitorPresentationMode uses dense mode for medium panels', () => {
  assertEqual(resolveMonitorPresentationMode(1024, 1200), 'dense', 'medium panels should collapse into dense mode')
})

runCase('resolveMonitorPresentationMode keeps previously-medium tall panels out of compact vertical mode after the threshold reduction', () => {
  assertEqual(
    resolveMonitorPresentationMode(360, 920),
    'dense',
    'tall panels above the reduced compact threshold should stay dense'
  )
})

runCase('resolveMonitorPresentationMode uses compact vertical mode for screenshot-like narrow panels', () => {
  assertEqual(
    resolveMonitorPresentationMode(188, 706),
    'compact-vertical',
    'very narrow panels should still use compact vertical mode after the threshold reduction'
  )
})

runCase('resolveMonitorPresentationMode keeps previously-short wide panels out of compact horizontal mode after the threshold reduction', () => {
  assertEqual(
    resolveMonitorPresentationMode(1180, 420),
    'dense',
    'wide panels above the reduced compact threshold should stay dense'
  )
})

runCase('resolveMonitorPresentationMode uses compact horizontal mode for tighter short bands', () => {
  assertEqual(
    resolveMonitorPresentationMode(980, 210),
    'compact-horizontal',
    'short horizontal bands below the reduced threshold should use compact horizontal mode'
  )
})

runCase('getMonitorPresentationConfig reduces history and rows in dense modes', () => {
  const standard = getMonitorPresentationConfig(1400, 980)
  const dense = getMonitorPresentationConfig(1024, 1200)
  assertEqual(standard.mode, 'standard', 'standard config mode mismatch')
  assertEqual(dense.mode, 'dense', 'dense config mode mismatch')
  if (dense.historyBarCount >= standard.historyBarCount) {
    throw new Error('dense mode should reduce history bar count')
  }
  if (dense.cpuProcessRows >= standard.cpuProcessRows) {
    throw new Error('dense mode should reduce cpu process rows')
  }
})

runCase('compact modes tighten visible row budgets for ultra-thin layouts', () => {
  const compactVertical = getMonitorPresentationConfig(188, 706)
  const compactHorizontal = getMonitorPresentationConfig(980, 210)
  assertEqual(compactVertical.mode, 'compact-vertical', 'compact vertical config mode mismatch')
  assertEqual(compactHorizontal.mode, 'compact-horizontal', 'compact horizontal config mode mismatch')
  if (compactVertical.socketRows > 2 || compactHorizontal.socketRows > 2) {
    throw new Error('compact modes should cap socket rows for ultra-thin layouts')
  }
  if (compactVertical.diskRows > 3 || compactHorizontal.diskRows > 3) {
    throw new Error('compact modes should cap disk rows for ultra-thin layouts')
  }
})

runCase('resolveMonitorVisibleRows keeps collapsed sections within the row budget while reporting overflow', () => {
  const rows = resolveMonitorVisibleRows([1, 2, 3, 4], 2, false)
  assertEqual(rows.visibleCount, 2, 'collapsed rows should respect the presentation row budget')
  assertEqual(rows.totalCount, 4, 'collapsed rows should preserve the full total count')
  assertEqual(rows.hiddenCount, 2, 'collapsed rows should report the hidden count')
  assertEqual(rows.hasOverflow, true, 'collapsed rows should report when overflow exists')
})

runCase('resolveMonitorVisibleRows returns the full dataset when the section is expanded', () => {
  const rows = resolveMonitorVisibleRows([1, 2, 3, 4], 2, true)
  assertEqual(rows.visibleCount, 4, 'expanded rows should reveal the full dataset')
  assertEqual(rows.hiddenCount, 0, 'expanded rows should not report hidden items')
  assertEqual(rows.expanded, true, 'expanded rows should preserve the expanded flag')
})

runCase('resolveMonitorVisibleRows avoids false overflow when the dataset already fits', () => {
  const rows = resolveMonitorVisibleRows([1, 2], 4, false)
  assertEqual(rows.visibleCount, 2, 'fitting rows should keep the full dataset visible')
  assertEqual(rows.hiddenCount, 0, 'fitting rows should not report hidden items')
  assertEqual(rows.hasOverflow, false, 'fitting rows should not report overflow')
})
