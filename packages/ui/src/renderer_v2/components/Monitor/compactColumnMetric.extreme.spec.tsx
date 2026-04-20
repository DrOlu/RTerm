import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const clampPercent = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

type MeterTone = 'default' | 'warn' | 'danger' | 'rx' | 'tx'

const CompactColumnMetric: React.FC<{
  label: string
  value: string
  detail?: string
  percent: number
  tone?: MeterTone
}> = ({ label, value, detail, percent, tone = 'default' }) => {
  const fillPercent = clampPercent(percent)
  return (
    <div className="monitor-compact-column">
      <div className="monitor-compact-column-head">
        <span className="monitor-compact-column-label">{label}</span>
        <span className="monitor-compact-column-value">{value}</span>
      </div>
      {detail && (
        <div className="monitor-compact-column-detail" title={detail}>
          {detail}
        </div>
      )}
      <div className={`monitor-compact-column-track tone-${tone}`}>
        {fillPercent > 0 && (
          <div
            className="monitor-compact-column-fill"
            style={{ height: `${fillPercent}%` }}
          />
        )}
      </div>
    </div>
  )
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(`ASSERT FAILED: ${message}`)
  }
}

const assertContains = (haystack: string, needle: string, message: string): void => {
  assert(haystack.includes(needle), `${message}. needle=${JSON.stringify(needle)} haystack=${haystack}`)
}

const assertNotContains = (haystack: string, needle: string, message: string): void => {
  assert(!haystack.includes(needle), `${message}. needle=${JSON.stringify(needle)} haystack=${haystack}`)
}

runCase('fill div renders with inline height when percent is positive', () => {
  const html = renderToStaticMarkup(
    <CompactColumnMetric label="DISK" value="57.8%" percent={57.8} tone="default" />
  )
  assertContains(html, 'monitor-compact-column-fill', 'fill element should be present for percent > 0')
  assertContains(html, 'height:57.8%', 'fill inline style should reflect the clamped percent')
})

runCase('fill div renders for all typical metric values (CPU/DISK/LOAD/RX/TX/SWAP/RAM)', () => {
  const cases: Array<{ percent: number; expected: string }> = [
    { percent: 12.5, expected: 'height:12.5%' },
    { percent: 25.5, expected: 'height:25.5%' },
    { percent: 28, expected: 'height:28%' },
    { percent: 57.8, expected: 'height:57.8%' },
    { percent: 78.8, expected: 'height:78.8%' },
    { percent: 93, expected: 'height:93%' },
    { percent: 100, expected: 'height:100%' },
  ]
  for (const { percent, expected } of cases) {
    const html = renderToStaticMarkup(
      <CompactColumnMetric label="M" value="x" percent={percent} tone="default" />
    )
    assertContains(html, 'monitor-compact-column-fill', `fill should exist for percent=${percent}`)
    assertContains(html, expected, `inline style should be ${expected} for percent=${percent}`)
  }
})

runCase('fill div is omitted when percent is exactly 0', () => {
  const html = renderToStaticMarkup(
    <CompactColumnMetric label="RX" value="0 B/s" percent={0} tone="rx" />
  )
  assertContains(html, 'monitor-compact-column-track', 'track must still render')
  assertNotContains(html, 'monitor-compact-column-fill', 'fill should be omitted when percent is 0')
})

runCase('fill div is omitted for undefined / non-finite / negative percent (treated as 0)', () => {
  const inputs: Array<number | undefined> = [undefined as unknown as number, Number.NaN, -5, Number.POSITIVE_INFINITY * 0]
  for (const percent of inputs) {
    const html = renderToStaticMarkup(
      <CompactColumnMetric label="M" value="x" percent={percent as number} tone="default" />
    )
    assertNotContains(html, 'monitor-compact-column-fill', `fill should be omitted for degenerate percent=${String(percent)}`)
  }
})

runCase('fill div clamps to 100% when percent > 100', () => {
  const html = renderToStaticMarkup(
    <CompactColumnMetric label="OVR" value="999%" percent={999} tone="warn" />
  )
  assertContains(html, 'height:100%', 'values above 100 should be clamped to 100%')
})

runCase('tone class is applied to the track element', () => {
  const tones: MeterTone[] = ['default', 'warn', 'danger', 'rx', 'tx']
  for (const tone of tones) {
    const html = renderToStaticMarkup(
      <CompactColumnMetric label="M" value="x" percent={50} tone={tone} />
    )
    assertContains(html, `tone-${tone}`, `track should carry class tone-${tone}`)
  }
})

runCase('detail block renders only when detail is provided', () => {
  const withDetail = renderToStaticMarkup(
    <CompactColumnMetric label="CPU" value="12.5%" percent={12.5} detail="usr 7.4%" tone="default" />
  )
  assertContains(withDetail, 'monitor-compact-column-detail', 'detail block must render when prop is given')
  assertContains(withDetail, 'usr 7.4%', 'detail text should be rendered')

  const withoutDetail = renderToStaticMarkup(
    <CompactColumnMetric label="CPU" value="12.5%" percent={12.5} tone="default" />
  )
  assertNotContains(withoutDetail, 'monitor-compact-column-detail', 'detail block must NOT render when prop is absent')
})

runCase('regression: bar heights are strictly ordered by percent', () => {
  // This asserts that the rendered inline height is monotonic with the percent input.
  // Prevents accidental CSS/JS decoupling of the fillPercent variable.
  const percents = [0.5, 12.5, 25.5, 28, 57.8, 78.8, 93, 100]
  const heights: number[] = []
  for (const p of percents) {
    const html = renderToStaticMarkup(
      <CompactColumnMetric label="M" value="x" percent={p} tone="default" />
    )
    const match = html.match(/height:([\d.]+)%/)
    assert(match !== null, `expected an inline height for percent=${p}`)
    heights.push(parseFloat(match![1]))
  }
  for (let i = 1; i < heights.length; i += 1) {
    assert(heights[i] > heights[i - 1], `heights must be strictly increasing: ${heights.join(',')}`)
  }
})
