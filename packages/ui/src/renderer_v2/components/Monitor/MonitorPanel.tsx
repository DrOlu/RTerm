import React from 'react'
import {
  Activity,
  Cpu,
  GripVertical,
  HardDrive,
  MemoryStick,
  Network,
  AlertTriangle,
  Gauge,
  Pause,
} from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { AppStore, TerminalTabModel } from '../../stores/AppStore'
import type { MonitorSnapshot } from '../../lib/ipcTypes'
import {
  getMonitorPresentationConfig,
  resolveMonitorVisibleRows,
  type MonitorVisibleCollection,
} from './monitorPresentation'
import { resolvePrimaryDisk } from './monitorData'
import { CompactPanelTabSelect } from '../Layout/CompactPanelTabSelect'
import { resolvePanelTabBarMode } from '../Layout/panelHeaderPresentation'
import './monitor.scss'

interface MonitorPanelProps {
  store: AppStore
  panelId: string
  tabs: TerminalTabModel[]
  activeTabId: string | null
  onSelectTab: (tabId: string) => void
  onLayoutHeaderContextMenu?: (event: React.MouseEvent<HTMLElement>) => void
}

type ResourceSnapshot = MonitorSnapshot
type NetworkEntry = NonNullable<ResourceSnapshot['network']>[number]
type ProcessEntry = NonNullable<ResourceSnapshot['processes']>[number]
type SocketEntry = NonNullable<ResourceSnapshot['networkConnections']>[number]
type DiskEntry = NonNullable<ResourceSnapshot['disks']>[number]
type GpuEntry = NonNullable<ResourceSnapshot['gpus']>[number]

type CpuViewMode = 'cores' | 'processes'
type NetworkViewMode = 'throughput' | 'sockets'
type MeterTone = 'default' | 'warn' | 'danger' | 'rx' | 'tx'
type MonitorDetailSectionId =
  | 'cpu-cores'
  | 'cpu-processes'
  | 'memory-processes'
  | 'network-interfaces'
  | 'network-sockets'
  | 'storage-disks'
  | 'gpu-devices'
const HISTORY_BAR_COUNT = 24

const formatBytes = (bytes: number | undefined): string => {
  if (!bytes || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${(bytes / 1024 ** 4).toFixed(1)} TB`
}

const formatBytesPerSec = (bytesPerSec: number | undefined): string => {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s'
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`
  if (bytesPerSec < 1024 ** 2) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
  if (bytesPerSec < 1024 ** 3) return `${(bytesPerSec / 1024 ** 2).toFixed(1)} MB/s`
  return `${(bytesPerSec / 1024 ** 3).toFixed(1)} GB/s`
}

const formatPercent = (value: number | undefined): string =>
  value === undefined ? '--' : `${value.toFixed(1)}%`

const formatMiB = (value: number | undefined): string =>
  formatBytes((Number.isFinite(value) ? Number(value) : 0) * 1024 ** 2)

const formatUptime = (seconds: number | undefined): string => {
  if (seconds === undefined || !Number.isFinite(seconds)) return '--'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

const formatAge = (timestamp: number | undefined): string => {
  if (!timestamp) return '--'
  const deltaMs = Date.now() - timestamp
  if (deltaMs < 1000) return 'now'
  return `${Math.floor(deltaMs / 1000)}s ago`
}

const formatPlatform = (platform: 'linux' | 'darwin' | 'windows' | 'unknown') => {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'windows') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return 'Unknown'
}

const clampPercent = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

const sumNetwork = (network: ResourceSnapshot['network']) =>
  (network || []).reduce(
    (acc: { rx: number; tx: number }, entry: NetworkEntry) => {
      acc.rx += entry.rxBytesPerSec
      acc.tx += entry.txBytesPerSec
      return acc
    },
    { rx: 0, tx: 0 }
  )

const resolveGpuMemoryUsagePercent = (gpu: GpuEntry): number | undefined => {
  if (typeof gpu.memoryUsagePercent === 'number' && Number.isFinite(gpu.memoryUsagePercent)) {
    return gpu.memoryUsagePercent
  }
  if (gpu.memoryTotalMiB > 0) {
    return (gpu.memoryUsedMiB / gpu.memoryTotalMiB) * 100
  }
  return undefined
}

const formatGpuMemoryFootprint = (gpu: GpuEntry): string => {
  const parts: string[] = []
  if (gpu.memoryTotalMiB > 0) {
    parts.push(`VRAM ${formatMiB(gpu.memoryUsedMiB)} / ${formatMiB(gpu.memoryTotalMiB)}`)
  } else if (gpu.memoryUsedMiB > 0) {
    parts.push(`VRAM ${formatMiB(gpu.memoryUsedMiB)} used`)
  }
  if ((gpu.sharedMemoryUsedMiB || 0) > 0) {
    parts.push(`shared ${formatMiB(gpu.sharedMemoryUsedMiB)}`)
  }
  return parts.join(' · ') || 'VRAM unavailable'
}

const formatGpuCompactValue = (gpu: GpuEntry): string => {
  const parts = [`GPU ${formatPercent(gpu.utilizationPercent)}`]
  const memoryUsagePercent = resolveGpuMemoryUsagePercent(gpu)
  if (memoryUsagePercent !== undefined) {
    parts.push(`VRAM ${formatPercent(memoryUsagePercent)}`)
  } else if (
    typeof gpu.memoryUtilizationPercent === 'number' &&
    Number.isFinite(gpu.memoryUtilizationPercent)
  ) {
    parts.push(`MEM ${formatPercent(gpu.memoryUtilizationPercent)}`)
  }
  if (gpu.temperatureC !== undefined) {
    parts.push(`${gpu.temperatureC}°C`)
  }
  return parts.join(' · ')
}

const resolveGpuMemoryTone = (percent: number | undefined): MeterTone => {
  if (percent === undefined) return 'default'
  if (percent >= 90) return 'danger'
  if (percent >= 75) return 'warn'
  return 'rx'
}

const MiniHistory: React.FC<{
  values: number[]
  maxValue?: number
  tone?: 'cpu' | 'memory' | 'network-rx' | 'network-tx'
  limit?: number
}> = ({ values, maxValue = 100, tone = 'cpu', limit = HISTORY_BAR_COUNT }) => {
  const recent = values.slice(-limit)
  const normalizedMax = Math.max(maxValue, 1)
  return (
    <div className={`monitor-history monitor-history-${tone}`}>
      {recent.map((value, index) => {
        const height = Math.max(12, (Math.min(value, normalizedMax) / normalizedMax) * 100)
        return (
          <span
            key={`${tone}-${index}`}
            className="monitor-history-bar"
            style={{ height: `${height}%` }}
          />
        )
      })}
    </div>
  )
}

const SegmentedControl: React.FC<{
  value: string
  options: Array<{ id: string; label: string }>
  onChange: (value: string) => void
}> = ({ value, options, onChange }) => (
  <div className="monitor-segmented">
    {options.map((option) => {
      const isActive = option.id === value
      return (
        <button
          key={option.id}
          type="button"
          className={isActive ? 'monitor-segmented-btn is-active' : 'monitor-segmented-btn'}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      )
    })}
  </div>
)

const InlineMeter: React.FC<{
  label: string
  value: string
  percent: number
  tone?: 'default' | 'warn' | 'danger' | 'rx' | 'tx'
}> = ({ label, value, percent, tone = 'default' }) => (
  <div className="monitor-inline-meter">
    <div className="monitor-inline-meter-head">
      <span className="monitor-inline-meter-label">{label}</span>
      <span className="monitor-inline-meter-value">{value}</span>
    </div>
    <div className={`monitor-inline-meter-track tone-${tone}`}>
      <div
        className="monitor-inline-meter-fill"
        style={{ width: `${clampPercent(percent)}%` }}
      />
    </div>
  </div>
)

const EmptyCard: React.FC<{ title: string; body: string; icon: React.ReactNode }> = ({
  title,
  body,
  icon,
}) => (
  <section className="monitor-card">
    <div className="monitor-card-header">
      <div className="monitor-card-title">
        {icon}
        <span>{title}</span>
      </div>
    </div>
    <div className="monitor-card-empty">{body}</div>
  </section>
)

const CompactList: React.FC<{
  rows: Array<{
    id: string
    label: string
    value: string
    detail?: string
    tone?: 'default' | 'rx' | 'tx' | 'warn' | 'danger'
  }>
}> = ({ rows }) => (
  <div className="monitor-compact-list">
    {rows.map((row) => (
      <div key={row.id} className="monitor-compact-row">
        <div className="monitor-compact-main">
          <span className="monitor-compact-label" title={row.label}>
            {row.label}
          </span>
          {row.detail && (
            <span className="monitor-compact-detail" title={row.detail}>
              {row.detail}
            </span>
          )}
        </div>
        <span className={`monitor-compact-value tone-${row.tone || 'default'}`}>
          {row.value}
        </span>
      </div>
    ))}
  </div>
)

const SectionOverflowControl: React.FC<{
  visibility: MonitorVisibleCollection
  itemLabel: string
  active: boolean
  onToggle: () => void
}> = ({ visibility, itemLabel, active, onToggle }) => {
  if (!visibility.hasOverflow) {
    return null
  }

  const buttonLabel = active ? 'CLOSE DETAIL' : 'OPEN DETAIL'
  const ariaLabel = active
    ? `Close ${itemLabel} detail`
    : `Open ${itemLabel} detail`

  return (
    <div className="monitor-overflow-bar">
      <span className="monitor-overflow-meta">
        VISIBLE {visibility.visibleCount} / {visibility.totalCount}
      </span>
      <button
        type="button"
        className={
          active
            ? 'monitor-overflow-toggle is-active-detail'
            : 'monitor-overflow-toggle'
        }
        aria-label={ariaLabel}
        onClick={onToggle}
      >
        {buttonLabel}
      </button>
    </div>
  )
}

const MonitorDetailDock: React.FC<{
  sectionId: MonitorDetailSectionId
  availableWidth: number
  maxBodyHeight: number
  onClose: () => void
  cpuCorePercents: number[]
  cpuProcesses: ProcessEntry[]
  memoryProcesses: ProcessEntry[]
  networkEntries: NetworkEntry[]
  totals: { rx: number; tx: number }
  socketEntries: SocketEntry[]
  diskEntries: DiskEntry[]
  gpuEntries: GpuEntry[]
}> = ({
  sectionId,
  availableWidth,
  maxBodyHeight,
  onClose,
  cpuCorePercents,
  cpuProcesses,
  memoryProcesses,
  networkEntries,
  totals,
  socketEntries,
  diskEntries,
  gpuEntries,
}) => {
  const useCompactTables = availableWidth < 860
  let title = ''
  let subtitle = ''
  let rowCount = 0
  let icon: React.ReactNode = <Activity size={14} />
  let content: React.ReactNode = null

  if (sectionId === 'cpu-cores') {
    title = 'CPU CORES'
    subtitle = 'Per-core usage map'
    rowCount = cpuCorePercents.length
    icon = <Cpu size={14} />
    content =
      cpuCorePercents.length > 0 ? (
        <div className="monitor-core-grid">
          {cpuCorePercents.map((percent: number, index: number) => (
            <div key={`detail-cpu-core-${index}`} className="monitor-core-row">
              <span className="monitor-core-name">
                CPU{String(index).padStart(2, '0')}
              </span>
              <div className="monitor-core-track">
                <div
                  className="monitor-core-fill"
                  style={{ width: `${clampPercent(percent)}%` }}
                />
              </div>
              <span className="monitor-core-value">{formatPercent(percent)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="monitor-card-empty">Per-core data is unavailable for this target.</div>
      )
  } else if (sectionId === 'cpu-processes') {
    title = 'CPU TOP'
    subtitle = 'Sorted by CPU pressure'
    rowCount = cpuProcesses.length
    icon = <Cpu size={14} />
    content =
      cpuProcesses.length > 0 ? (
        useCompactTables ? (
          <CompactList
            rows={cpuProcesses.map((process: ProcessEntry) => ({
              id: `detail-cpu-proc-${process.pid}`,
              label: process.name,
              detail: `PID ${process.pid}${process.user ? ` · ${process.user}` : ''}`,
              value: `${formatPercent(process.cpuPercent)} · ${formatBytes(process.memoryBytes)}`,
            }))}
          />
        ) : (
          <div className="monitor-table">
            <div className="monitor-table-head monitor-table-row monitor-table-row-process">
              <span>PID</span>
              <span>CPU</span>
              <span>RSS</span>
              <span>COMMAND</span>
            </div>
            {cpuProcesses.map((process: ProcessEntry) => (
              <div
                key={`detail-cpu-proc-${process.pid}`}
                className="monitor-table-row monitor-table-row-process"
              >
                <span>{process.pid}</span>
                <span>{formatPercent(process.cpuPercent)}</span>
                <span>{formatBytes(process.memoryBytes)}</span>
                <span title={process.command || process.name}>
                  {process.command || process.name}
                </span>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="monitor-card-empty">No process data.</div>
      )
  } else if (sectionId === 'memory-processes') {
    title = 'MEMORY TOP'
    subtitle = 'Sorted by resident memory'
    rowCount = memoryProcesses.length
    icon = <MemoryStick size={14} />
    content =
      memoryProcesses.length > 0 ? (
        useCompactTables ? (
          <CompactList
            rows={memoryProcesses.map((process: ProcessEntry) => ({
              id: `detail-mem-proc-${process.pid}`,
              label: process.name,
              detail: `PID ${process.pid}${process.user ? ` · ${process.user}` : ''}`,
              value: `${formatBytes(process.memoryBytes)} · ${formatPercent(process.cpuPercent)}`,
            }))}
          />
        ) : (
          <div className="monitor-table">
            <div className="monitor-table-head monitor-table-row monitor-table-row-memory">
              <span>PID</span>
              <span>USER</span>
              <span>RSS</span>
              <span>COMMAND</span>
            </div>
            {memoryProcesses.map((process: ProcessEntry) => (
              <div
                key={`detail-mem-proc-${process.pid}`}
                className="monitor-table-row monitor-table-row-memory"
              >
                <span>{process.pid}</span>
                <span>{process.user || '--'}</span>
                <span>{formatBytes(process.memoryBytes)}</span>
                <span title={process.command || process.name}>
                  {process.command || process.name}
                </span>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="monitor-card-empty">No process memory data.</div>
      )
  } else if (sectionId === 'network-interfaces') {
    title = 'NETWORK IFACES'
    subtitle = 'Traffic split by interface'
    rowCount = networkEntries.length
    icon = <Network size={14} />
    content =
      networkEntries.length > 0 ? (
        useCompactTables ? (
          <CompactList
            rows={networkEntries.map((entry: NetworkEntry) => {
              const ifaceTotal = entry.rxBytesPerSec + entry.txBytesPerSec
              const ifacePercent =
                totals.rx + totals.tx > 0
                  ? (ifaceTotal / (totals.rx + totals.tx)) * 100
                  : 0
              return {
                id: `detail-net-iface-${entry.interface}`,
                label: entry.interface,
                detail: `${ifacePercent.toFixed(1)}% share`,
                value: `↓ ${formatBytesPerSec(entry.rxBytesPerSec)} · ↑ ${formatBytesPerSec(entry.txBytesPerSec)}`,
              }
            })}
          />
        ) : (
          <div className="monitor-table">
            <div className="monitor-table-head monitor-table-row monitor-table-row-network">
              <span>IFACE</span>
              <span>RX</span>
              <span>TX</span>
            </div>
            {networkEntries.map((entry: NetworkEntry) => {
              const ifaceTotal = entry.rxBytesPerSec + entry.txBytesPerSec
              const ifacePercent =
                totals.rx + totals.tx > 0
                  ? (ifaceTotal / (totals.rx + totals.tx)) * 100
                  : 0
              return (
                <div
                  key={`detail-net-iface-${entry.interface}`}
                  className="monitor-network-row"
                >
                  <div className="monitor-network-row-head">
                    <span className="monitor-network-name">{entry.interface}</span>
                    <span className="monitor-network-share">
                      {ifacePercent.toFixed(1)}% share
                    </span>
                  </div>
                  <div className="monitor-network-row-meta">
                    <span className="is-rx">↓ {formatBytesPerSec(entry.rxBytesPerSec)}</span>
                    <span className="is-tx">↑ {formatBytesPerSec(entry.txBytesPerSec)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )
      ) : (
        <div className="monitor-card-empty">No interface throughput data.</div>
      )
  } else if (sectionId === 'network-sockets') {
    title = 'SOCKET HOTSPOTS'
    subtitle = 'Connection fan-out by process'
    rowCount = socketEntries.length
    icon = <Network size={14} />
    content =
      socketEntries.length > 0 ? (
        useCompactTables ? (
          <CompactList
            rows={socketEntries.map((entry: SocketEntry) => ({
              id: `detail-socket-${entry.protocol}-${entry.pid || 'na'}-${entry.localAddress}-${entry.localPort || 'na'}`,
              label: entry.processName || `${entry.localAddress}:${entry.localPort ?? '--'}`,
              detail: `${entry.protocol.toUpperCase()} ${entry.localAddress}:${entry.localPort ?? '--'}${entry.state ? ` · ${entry.state}` : ''}`,
              value: `${entry.remoteHostCount} hosts · ${entry.connectionCount} conn`,
              tone: entry.isListening ? 'rx' : 'default',
            }))}
          />
        ) : (
          <div className="monitor-table">
            <div className="monitor-table-head monitor-table-row monitor-table-row-socket">
              <span>PROTO</span>
              <span>PROC</span>
              <span>BIND</span>
              <span>PORT</span>
              <span>HOSTS</span>
              <span>CONN</span>
              <span>STATE</span>
            </div>
            {socketEntries.map((entry: SocketEntry) => (
              <div
                key={`detail-socket-${entry.protocol}-${entry.pid || 'na'}-${entry.localAddress}-${entry.localPort || 'na'}`}
                className="monitor-table-row monitor-table-row-socket"
              >
                <span>{entry.protocol.toUpperCase()}</span>
                <span title={entry.processName || '--'}>{entry.processName || '--'}</span>
                <span title={entry.localAddress}>{entry.localAddress}</span>
                <span>{entry.localPort ?? '--'}</span>
                <span>{entry.remoteHostCount}</span>
                <span>{entry.connectionCount}</span>
                <span className={entry.isListening ? 'is-listening' : ''}>
                  {entry.state || '--'}
                </span>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="monitor-card-empty">No socket data.</div>
      )
  } else if (sectionId === 'storage-disks') {
    title = 'STORAGE'
    subtitle = 'Sorted by usage pressure'
    rowCount = diskEntries.length
    icon = <HardDrive size={14} />
    content =
      diskEntries.length > 0 ? (
        <div className="monitor-disk-list">
          {diskEntries.map((disk: DiskEntry) => (
            <div
              key={`detail-disk-${disk.filesystem}-${disk.mountPoint}`}
              className="monitor-disk-row"
            >
              <div className="monitor-disk-row-head">
                <span className="monitor-disk-name">{disk.mountPoint}</span>
                <span className="monitor-disk-meta">
                  {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)}
                </span>
              </div>
              <div className="monitor-core-track">
                <div
                  className="monitor-core-fill"
                  style={{ width: `${clampPercent(disk.usagePercent)}%` }}
                />
              </div>
              <div className="monitor-disk-row-foot">
                <span>{disk.filesystem}</span>
                <span>{formatPercent(disk.usagePercent)}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="monitor-card-empty">No disk data.</div>
      )
  } else {
    title = 'GPU'
    subtitle = 'Accelerator load and memory'
    rowCount = gpuEntries.length
    icon = <Gauge size={14} />
    content =
      gpuEntries.length > 0 ? (
        <div className="monitor-disk-list">
          {gpuEntries.map((gpu: GpuEntry, index: number) => {
            const memoryUsagePercent = resolveGpuMemoryUsagePercent(gpu)
            return (
              <div key={`detail-gpu-${index}`} className="monitor-disk-row">
                <div className="monitor-disk-row-head">
                  <span className="monitor-disk-name">
                    {gpu.name || `GPU ${index + 1}`}
                  </span>
                  <span className="monitor-disk-meta">
                    {formatPercent(gpu.utilizationPercent)}
                  </span>
                </div>
                <div className="monitor-meter-grid">
                  <InlineMeter
                    label="GPU"
                    value={formatPercent(gpu.utilizationPercent)}
                    percent={gpu.utilizationPercent || 0}
                    tone="warn"
                  />
                  <InlineMeter
                    label="VRAM"
                    value={formatGpuMemoryFootprint(gpu)}
                    percent={memoryUsagePercent || 0}
                    tone={resolveGpuMemoryTone(memoryUsagePercent)}
                  />
                  {typeof gpu.memoryUtilizationPercent === 'number' &&
                    Number.isFinite(gpu.memoryUtilizationPercent) && (
                      <InlineMeter
                        label="MEM"
                        value={formatPercent(gpu.memoryUtilizationPercent)}
                        percent={gpu.memoryUtilizationPercent}
                        tone="rx"
                      />
                    )}
                </div>
                <div className="monitor-disk-row-foot">
                  <span>{formatGpuMemoryFootprint(gpu)}</span>
                  <span>
                    {gpu.temperatureC !== undefined ? `${gpu.temperatureC}°C` : '--'}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="monitor-card-empty">No GPU data.</div>
      )
  }

  return (
    <section className="monitor-detail-dock" data-monitor-detail-section={sectionId}>
      <div className="monitor-detail-head">
        <div className="monitor-detail-title">
          {icon}
          <span>{title}</span>
        </div>
        <div className="monitor-detail-meta">
          <span>{subtitle}</span>
          <span>{rowCount} rows</span>
          <button type="button" className="monitor-detail-close" onClick={onClose}>
            CLOSE DETAIL
          </button>
        </div>
      </div>
      <div className="monitor-detail-body" style={{ maxHeight: `${maxBodyHeight}px` }}>
        {content}
      </div>
    </section>
  )
}

const CompactBarMetric: React.FC<{
  label: string
  value: string
  detail?: string
  percent: number
  tone?: MeterTone
}> = ({ label, value, detail, percent, tone = 'default' }) => (
  <div className="monitor-compact-meter">
    <div className="monitor-compact-meter-head">
      <span className="monitor-compact-meter-label">{label}</span>
      <span className="monitor-compact-meter-value">{value}</span>
    </div>
    <div className={`monitor-inline-meter-track monitor-compact-meter-track tone-${tone}`}>
      <div
        className="monitor-inline-meter-fill"
        style={{ width: `${clampPercent(percent)}%` }}
      />
    </div>
    {detail && <div className="monitor-compact-meter-detail">{detail}</div>}
  </div>
)

const CompactColumnMetric: React.FC<{
  label: string
  value: string
  detail?: string
  percent: number
  tone?: MeterTone
}> = ({ label, value, detail, percent, tone = 'default' }) => (
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
      <div
        className="monitor-compact-column-fill"
        style={{ height: `${clampPercent(percent)}%` }}
      />
    </div>
  </div>
)

const CompactInfoPill: React.FC<{
  label: string
  value: string
  tone?: MeterTone
}> = ({ label, value, tone = 'default' }) => (
  <div className={`monitor-compact-pill tone-${tone}`}>
    <span className="monitor-compact-pill-label">{label}</span>
    <span className="monitor-compact-pill-value" title={value}>
      {value}
    </span>
  </div>
)

const MonitorTabView: React.FC<{
  store: AppStore
  terminalId: string
  terminalTitle: string
  runtimeState?: TerminalTabModel['runtimeState']
  availableWidth: number
  availableHeight: number
}> = observer(({ store, terminalId, terminalTitle, runtimeState, availableWidth, availableHeight }) => {
  const [cpuMode, setCpuMode] = React.useState<CpuViewMode>('cores')
  const [networkMode, setNetworkMode] = React.useState<NetworkViewMode>('throughput')
  const [detailSectionId, setDetailSectionId] = React.useState<MonitorDetailSectionId | null>(null)
  const detailDockRef = React.useRef<HTMLDivElement | null>(null)
  const toggleDetailSection = (sectionId: MonitorDetailSectionId) => {
    setDetailSectionId((current) => (current === sectionId ? null : sectionId))
  }
  const monitorState = store.getMonitorTerminalState(terminalId)
  const snapshot = monitorState?.snapshot || null
  const lastError = monitorState?.lastError || null
  const cpuHistory = monitorState?.cpuHistory || []
  const memHistory = monitorState?.memoryHistory || []
  const rxHistory = monitorState?.rxHistory || []
  const txHistory = monitorState?.txHistory || []

  const isReady = runtimeState === 'ready' || runtimeState === undefined
  const presentation = getMonitorPresentationConfig(availableWidth, availableHeight)
  const detailBodyMaxHeight = (() => {
    const ratio =
      presentation.mode === 'standard'
        ? 0.38
        : presentation.mode === 'dense'
          ? 0.34
          : 0.3
    const minimum = presentation.mode === 'compact-horizontal' ? 88 : 120
    const maximum =
      presentation.mode === 'standard'
        ? 340
        : presentation.mode === 'dense'
          ? 280
          : 220
    return Math.max(
      minimum,
      Math.min(maximum, Math.floor(Math.max(availableHeight, 0) * ratio))
    )
  })()
  const cpuProcessesSorted = (snapshot?.processes || [])
    .slice()
    .sort((left: ProcessEntry, right: ProcessEntry) => (right.cpuPercent || 0) - (left.cpuPercent || 0))
  const memoryProcessesSorted = (snapshot?.processes || [])
    .slice()
    .sort((left: ProcessEntry, right: ProcessEntry) => (right.memoryBytes || 0) - (left.memoryBytes || 0))
  const networkEntries = (snapshot?.network || [])
    .slice()
    .sort(
      (left: NetworkEntry, right: NetworkEntry) =>
        right.rxBytesPerSec +
        right.txBytesPerSec -
        (left.rxBytesPerSec + left.txBytesPerSec)
    )
  const socketEntries = (snapshot?.networkConnections || [])
    .slice()
    .sort((left: SocketEntry, right: SocketEntry) => {
      const leftScore = left.connectionCount * 1000 + left.remoteHostCount
      const rightScore = right.connectionCount * 1000 + right.remoteHostCount
      return rightScore - leftScore
    })
  const diskEntries = (snapshot?.disks || [])
    .slice()
    .sort((left: DiskEntry, right: DiskEntry) => right.usagePercent - left.usagePercent)
  const gpuEntries = (snapshot?.gpus || [])
    .slice()
    .sort(
      (left: GpuEntry, right: GpuEntry) =>
        (right.utilizationPercent || 0) - (left.utilizationPercent || 0)
    )
  const cpuCoreRows = resolveMonitorVisibleRows<number>(
    snapshot?.cpu?.corePercents || [],
    presentation.coreRows,
    false
  )
  const cpuProcessRows = resolveMonitorVisibleRows(
    cpuProcessesSorted,
    presentation.cpuProcessRows,
    false
  )
  const memoryProcessRows = resolveMonitorVisibleRows(
    memoryProcessesSorted,
    presentation.memoryProcessRows,
    false
  )
  const interfaceRows = resolveMonitorVisibleRows(
    networkEntries,
    presentation.interfaceRows,
    false
  )
  const socketRows = resolveMonitorVisibleRows(
    socketEntries,
    presentation.socketRows,
    false
  )
  const ultraSocketRows = resolveMonitorVisibleRows(
    socketEntries,
    presentation.mode === 'compact-horizontal' ? 2 : 1,
    false
  )
  const diskRows = resolveMonitorVisibleRows(
    diskEntries,
    presentation.diskRows,
    false
  )
  const gpuRows = resolveMonitorVisibleRows(
    gpuEntries,
    presentation.gpuRows,
    false
  )

  React.useEffect(() => {
    if (!detailSectionId) {
      return
    }

    const detailStillAvailable =
      (detailSectionId === 'cpu-cores' && cpuCoreRows.hasOverflow) ||
      (detailSectionId === 'cpu-processes' && cpuProcessRows.hasOverflow) ||
      (detailSectionId === 'memory-processes' && memoryProcessRows.hasOverflow) ||
      (detailSectionId === 'network-interfaces' && interfaceRows.hasOverflow) ||
      (detailSectionId === 'network-sockets' && socketRows.hasOverflow) ||
      (detailSectionId === 'storage-disks' && diskRows.hasOverflow) ||
      (detailSectionId === 'gpu-devices' && gpuRows.hasOverflow)

    if (!detailStillAvailable) {
      setDetailSectionId(null)
    }
  }, [
    detailSectionId,
    cpuCoreRows.hasOverflow,
    cpuProcessRows.hasOverflow,
    memoryProcessRows.hasOverflow,
    interfaceRows.hasOverflow,
    socketRows.hasOverflow,
    diskRows.hasOverflow,
    gpuRows.hasOverflow,
  ])

  React.useEffect(() => {
    if (!detailSectionId) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDetailSectionId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [detailSectionId])

  React.useEffect(() => {
    if (!detailSectionId) {
      return
    }
    const detailDock = detailDockRef.current
    if (!detailDock) {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      detailDock.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      })
    })
    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [detailSectionId])

  if (!isReady) {
    const waitingMessage =
      runtimeState === 'exited'
        ? `${terminalTitle} runtime exited.`
        : `Waiting for ${terminalTitle} runtime...`
    return (
      <div className="monitor-loading">
        <Activity size={16} className="monitor-loading-spinner" />
        <span>{waitingMessage}</span>
      </div>
    )
  }

  if (!snapshot && lastError) {
    return (
      <div className="monitor-error">
        <AlertTriangle size={16} />
        <span className="monitor-error-text">{lastError}</span>
      </div>
    )
  }

  if (!snapshot) {
    return (
      <div className="monitor-loading">
        <Activity size={16} className="monitor-loading-spinner" />
        <span>Collecting {terminalTitle} metrics...</span>
      </div>
    )
  }

  const useCompactCards = presentation.mode !== 'standard'
  const totals = sumNetwork(snapshot.network)
  const isUltraCompact =
    presentation.mode === 'compact-horizontal' || presentation.mode === 'compact-vertical'
  const isUltraHorizontal = presentation.mode === 'compact-horizontal'
  const platformLabel = formatPlatform(snapshot.system?.platform || 'unknown')
  const connectionLabel = (snapshot.system?.connectionType || 'local').toUpperCase()
  const hostLabel =
    snapshot.system?.hostname && snapshot.system.hostname !== terminalTitle
      ? `${terminalTitle} @ ${snapshot.system.hostname}`
      : terminalTitle
  const compactHostLabel = snapshot.system?.hostname || terminalTitle
  const primaryDisk = resolvePrimaryDisk(snapshot)
  const topCpuProcesses = cpuProcessRows.rows
  const topMemoryProcesses = memoryProcessRows.rows
  const visibleInterfaces = interfaceRows.rows
  const visibleSockets = socketRows.rows
  const visibleDisks = diskRows.rows
  const visibleGpus = gpuRows.rows
  const compactGpuRows = visibleGpus.map((gpu: GpuEntry, index: number) => ({
    id: `compact-gpu-${index}`,
    label: gpu.name || `GPU ${index + 1}`,
    detail: formatGpuMemoryFootprint(gpu),
    value: formatGpuCompactValue(gpu),
  }))
  const visibleCorePercents = cpuCoreRows.rows
  const compactSocketRows = ultraSocketRows.rows
  const listeningSocketCount = socketEntries.filter((entry: SocketEntry) => entry.isListening).length
  const swapUsagePercent =
    snapshot.memory?.swap && snapshot.memory.swap.totalBytes > 0
      ? (snapshot.memory.swap.usedBytes / snapshot.memory.swap.totalBytes) * 100
      : undefined
  const networkRateScale = Math.max(1, totals.rx, totals.tx)
  const loadPercent =
    snapshot.loadAverage?.[0] !== undefined
      ? Math.min(
          100,
          (snapshot.loadAverage[0] / Math.max(snapshot.cpu?.logicalCoreCount || 1, 1)) * 100
        )
      : undefined
  const leadProcess = cpuProcessesSorted[0] || memoryProcessesSorted[0]
  const leadInterface = networkEntries[0]
  const leadGpu = gpuEntries[0]
  const memoryTags = [
    snapshot.memory?.cachedBytes !== undefined ? `CACHE ${formatBytes(snapshot.memory.cachedBytes)}` : null,
    snapshot.memory?.wiredBytes !== undefined ? `WIRED ${formatBytes(snapshot.memory.wiredBytes)}` : null,
    snapshot.memory?.compressedBytes !== undefined ? `COMP ${formatBytes(snapshot.memory.compressedBytes)}` : null,
    snapshot.memory?.freeBytes !== undefined ? `FREE ${formatBytes(snapshot.memory.freeBytes)}` : null,
  ]
    .filter((value): value is string => !!value)
    .slice(0, presentation.memoryTagCount)
  const ultraMetricModules: Array<{
    id: string
    label: string
    value: string
    detail?: string
    percent: number
    tone?: MeterTone
  }> = []

  if (snapshot.cpu) {
    ultraMetricModules.push({
      id: 'cpu',
      label: 'CPU',
      value: formatPercent(snapshot.cpu.usagePercent),
      detail: `usr ${formatPercent(snapshot.cpu.userPercent)} · sys ${formatPercent(snapshot.cpu.systemPercent)}`,
      percent: snapshot.cpu.usagePercent || 0,
    })
  }

  if (snapshot.memory) {
    ultraMetricModules.push({
      id: 'ram',
      label: 'RAM',
      value: formatPercent(snapshot.memory.usagePercent),
      detail: `${formatBytes(snapshot.memory.usedBytes)} / ${formatBytes(snapshot.memory.totalBytes)}`,
      percent: snapshot.memory.usagePercent,
      tone:
        snapshot.memory.usagePercent >= 85
          ? 'danger'
          : snapshot.memory.usagePercent >= 70
            ? 'warn'
            : 'default',
    })
  }

  if (snapshot.memory?.swap && snapshot.memory.swap.totalBytes > 0 && swapUsagePercent !== undefined) {
    ultraMetricModules.push({
      id: 'swap',
      label: 'SWAP',
      value: formatPercent(swapUsagePercent),
      detail: `${formatBytes(snapshot.memory.swap.usedBytes)} / ${formatBytes(snapshot.memory.swap.totalBytes)}`,
      percent: swapUsagePercent,
      tone: swapUsagePercent >= 70 ? 'warn' : 'default',
    })
  }

  if (primaryDisk) {
    ultraMetricModules.push({
      id: 'disk',
      label: 'DISK',
      value: formatPercent(primaryDisk.usagePercent),
      detail: `${primaryDisk.mountPoint} · ${formatBytes(primaryDisk.usedBytes)}`,
      percent: primaryDisk.usagePercent,
      tone:
        primaryDisk.usagePercent >= 85
          ? 'danger'
          : primaryDisk.usagePercent >= 70
            ? 'warn'
            : 'default',
    })
  }

  ultraMetricModules.push(
    {
      id: 'rx',
      label: 'RX',
      value: formatBytesPerSec(totals.rx),
      detail: leadInterface ? leadInterface.interface : 'no iface',
      percent: (totals.rx / networkRateScale) * 100,
      tone: 'rx',
    },
    {
      id: 'tx',
      label: 'TX',
      value: formatBytesPerSec(totals.tx),
      detail: leadInterface ? leadInterface.interface : 'no iface',
      percent: (totals.tx / networkRateScale) * 100,
      tone: 'tx',
    }
  )

  if (loadPercent !== undefined && snapshot.loadAverage) {
    ultraMetricModules.push({
      id: 'load',
      label: 'LOAD',
      value: snapshot.loadAverage[0].toFixed(2),
      detail: snapshot.loadAverage.map((value: number) => value.toFixed(2)).join(' / '),
      percent: loadPercent,
    })
  }

  if (leadGpu) {
    ultraMetricModules.push({
      id: 'gpu',
      label: 'GPU',
      value: formatPercent(leadGpu.utilizationPercent),
      detail: leadGpu.name || 'accelerator',
      percent: leadGpu.utilizationPercent || 0,
      tone: 'warn',
    })
  }

  const ultraInfoPills: Array<{
    id: string
    label: string
    value: string
    tone?: MeterTone
  }> = [
    {
      id: 'proc',
      label: 'PROC',
      value: leadProcess
        ? `${leadProcess.name} ${formatPercent(leadProcess.cpuPercent)}`
        : `${snapshot.processes?.length || 0} total`,
    },
    {
      id: 'net',
      label: 'NET',
      value: `${networkEntries.length} iface · ${socketEntries.length} sockets`,
    },
  ]

  if (primaryDisk) {
    ultraInfoPills.push({
      id: 'store',
      label: 'STORE',
      value: `${primaryDisk.mountPoint} · ${formatBytes(primaryDisk.availableBytes)} free`,
      tone: primaryDisk.usagePercent >= 85 ? 'danger' : 'default',
    })
  }

  if (snapshot.cpu?.logicalCoreCount) {
    ultraInfoPills.push({
      id: 'cpu-meta',
      label: 'CPU',
      value: `${snapshot.cpu.logicalCoreCount} logical`,
    })
  }

  if (leadInterface) {
    ultraInfoPills.push({
      id: 'iface',
      label: 'IFACE',
      value: `${leadInterface.interface} ↓ ${formatBytesPerSec(leadInterface.rxBytesPerSec)} · ↑ ${formatBytesPerSec(leadInterface.txBytesPerSec)}`,
      tone: 'rx',
    })
  }

  const cpuCardActive =
    detailSectionId === 'cpu-cores' || detailSectionId === 'cpu-processes'
  const memoryCardActive = detailSectionId === 'memory-processes'
  const networkCardActive =
    detailSectionId === 'network-interfaces' || detailSectionId === 'network-sockets'
  const storageCardActive = detailSectionId === 'storage-disks'
  const gpuCardActive = detailSectionId === 'gpu-devices'
  const detailDock = detailSectionId ? (
    <div ref={detailDockRef} className="monitor-detail-wrap">
      <MonitorDetailDock
        sectionId={detailSectionId}
        availableWidth={availableWidth}
        maxBodyHeight={detailBodyMaxHeight}
        onClose={() => setDetailSectionId(null)}
        cpuCorePercents={snapshot.cpu?.corePercents || []}
        cpuProcesses={cpuProcessesSorted}
        memoryProcesses={memoryProcessesSorted}
        networkEntries={networkEntries}
        totals={totals}
        socketEntries={socketEntries}
        diskEntries={diskEntries}
        gpuEntries={gpuEntries}
      />
    </div>
  ) : null

  const compactDetailGrid = (
    <div className="monitor-compact-grid">
      <section className={cpuCardActive ? 'monitor-card is-detail-source' : 'monitor-card'}>
        <div className="monitor-card-header">
          <div className="monitor-card-title">
            <Cpu size={14} />
            <span>TOP PROC</span>
          </div>
          <span className="monitor-compact-card-value">{snapshot.processes?.length || 0} total</span>
        </div>
        <div className="monitor-card-body">
          {topCpuProcesses.length > 0 ? (
            <>
              <CompactList
                rows={topCpuProcesses.map((process: ProcessEntry) => ({
                  id: `compact-proc-${process.pid}`,
                  label: process.name,
                  detail: `PID ${process.pid}${process.user ? ` · ${process.user}` : ''}`,
                  value: `${formatPercent(process.cpuPercent)} · ${formatBytes(process.memoryBytes)}`,
                }))}
              />
              <SectionOverflowControl
                visibility={cpuProcessRows}
                itemLabel="processes"
                active={detailSectionId === 'cpu-processes'}
                onToggle={() => toggleDetailSection('cpu-processes')}
              />
            </>
          ) : (
            <div className="monitor-card-empty">No process data.</div>
          )}
        </div>
      </section>

      <section className={networkCardActive ? 'monitor-card is-detail-source' : 'monitor-card'}>
        <div className="monitor-card-header">
          <div className="monitor-card-title">
            <Network size={14} />
            <span>NET</span>
          </div>
          <span className="monitor-compact-card-value">
            ↓ {formatBytesPerSec(totals.rx)} · ↑ {formatBytesPerSec(totals.tx)}
          </span>
        </div>
        <div className="monitor-card-body">
          {visibleInterfaces.length > 0 ? (
            <>
              <CompactList
                rows={visibleInterfaces.map((entry: NetworkEntry) => ({
                  id: `compact-iface-${entry.interface}`,
                  label: entry.interface,
                  detail: `${(
                    totals.rx + totals.tx > 0
                      ? ((entry.rxBytesPerSec + entry.txBytesPerSec) / (totals.rx + totals.tx)) * 100
                      : 0
                  ).toFixed(1)}% share`,
                  value: `↓ ${formatBytesPerSec(entry.rxBytesPerSec)} · ↑ ${formatBytesPerSec(entry.txBytesPerSec)}`,
                }))}
              />
              <SectionOverflowControl
                visibility={interfaceRows}
                itemLabel="interfaces"
                active={detailSectionId === 'network-interfaces'}
                onToggle={() => toggleDetailSection('network-interfaces')}
              />
            </>
          ) : (
            <div className="monitor-card-empty">No interface data.</div>
          )}

          <div className="monitor-compact-meta-strip">
            <span>{networkEntries.length} iface</span>
            <span>{socketEntries.length} sockets</span>
            <span>{listeningSocketCount} listen</span>
          </div>

          {compactSocketRows.length > 0 && (
            <div className="monitor-subsection">
              <div className="monitor-subsection-header">
                <Activity size={13} />
                <span>ACTIVE SOCKETS</span>
              </div>
              <CompactList
                rows={compactSocketRows.map((entry: SocketEntry) => ({
                  id: `compact-socket-${entry.protocol}-${entry.pid || 'na'}-${entry.localAddress}-${entry.localPort || 'na'}`,
                  label: entry.processName || `${entry.localAddress}:${entry.localPort ?? '--'}`,
                  detail: `${entry.protocol.toUpperCase()} ${entry.localAddress}:${entry.localPort ?? '--'}${entry.state ? ` · ${entry.state}` : ''}`,
                  value: `${entry.remoteHostCount} hosts · ${entry.connectionCount} conn`,
                  tone: entry.isListening ? 'rx' : 'default',
                }))}
              />
              <SectionOverflowControl
                visibility={ultraSocketRows}
                itemLabel="sockets"
                active={detailSectionId === 'network-sockets'}
                onToggle={() => toggleDetailSection('network-sockets')}
              />
            </div>
          )}
        </div>
      </section>

      <section className={storageCardActive ? 'monitor-card is-detail-source' : 'monitor-card'}>
        <div className="monitor-card-header">
          <div className="monitor-card-title">
            <HardDrive size={14} />
            <span>STORAGE</span>
          </div>
          <span className="monitor-compact-card-value">
            {diskEntries.length} total
          </span>
        </div>
        <div className="monitor-card-body">
          {visibleDisks.length > 0 ? (
            <>
              <CompactList
                rows={visibleDisks.map((disk: DiskEntry) => ({
                  id: `compact-disk-${disk.filesystem}-${disk.mountPoint}`,
                  label: disk.mountPoint,
                  detail: disk.filesystem,
                  value: `${formatPercent(disk.usagePercent)} · ${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`,
                }))}
              />
              <SectionOverflowControl
                visibility={diskRows}
                itemLabel="disks"
                active={detailSectionId === 'storage-disks'}
                onToggle={() => toggleDetailSection('storage-disks')}
              />
            </>
          ) : (
            <div className="monitor-card-empty">No disk data.</div>
          )}
        </div>
      </section>

      {gpuRows.totalCount > 0 && (
        <section className={gpuCardActive ? 'monitor-card is-detail-source' : 'monitor-card'}>
          <div className="monitor-card-header">
            <div className="monitor-card-title">
              <Gauge size={14} />
              <span>GPU</span>
            </div>
            <span className="monitor-compact-card-value">{gpuEntries.length} total</span>
          </div>
          <div className="monitor-card-body">
            <CompactList rows={compactGpuRows} />
            <SectionOverflowControl
              visibility={gpuRows}
              itemLabel="gpus"
              active={detailSectionId === 'gpu-devices'}
              onToggle={() => toggleDetailSection('gpu-devices')}
            />
          </div>
        </section>
      )}
    </div>
  )

  if (isUltraCompact) {
    return (
      <div
        className={`monitor-content layout-${presentation.mode} monitor-content-ultra`}
        data-monitor-presentation={presentation.mode}
      >
        <div className={`monitor-compact-strip-head ${isUltraHorizontal ? 'is-horizontal' : 'is-vertical'}`}>
          <div className="monitor-compact-strip-identity">
            <span className="monitor-hud-kicker">{platformLabel} · {connectionLabel}</span>
            <span className="monitor-compact-strip-title" title={hostLabel}>
              {compactHostLabel}
            </span>
          </div>
          <div className="monitor-compact-strip-meta">
            <span>{snapshot.system?.osName || platformLabel}</span>
            {snapshot.system?.release && <span>{snapshot.system.release}</span>}
            {snapshot.system?.arch && <span>{snapshot.system.arch}</span>}
            {snapshot.cpu?.logicalCoreCount && <span>{snapshot.cpu.logicalCoreCount} logical</span>}
          </div>
        </div>

        {lastError && (
          <div className="monitor-banner is-warning">
            <AlertTriangle size={14} />
            <span>{lastError}</span>
          </div>
        )}

        {isUltraHorizontal ? (
          <>
            <div className="monitor-compact-horizontal-pack">
              {ultraMetricModules.map((metric) => (
                <CompactColumnMetric
                  key={metric.id}
                  label={metric.label}
                  value={metric.value}
                  detail={metric.detail}
                  percent={metric.percent}
                  tone={metric.tone}
                />
              ))}
            </div>
            <div className="monitor-compact-pill-row">
              {ultraInfoPills.map((pill) => (
                <CompactInfoPill
                  key={pill.id}
                  label={pill.label}
                  value={pill.value}
                  tone={pill.tone}
                />
              ))}
            </div>
            {detailDock}
            {compactDetailGrid}
          </>
        ) : (
          <>
            <div className="monitor-compact-metrics">
              {snapshot.cpu && (
                <CompactBarMetric
                  label="CPU"
                  value={formatPercent(snapshot.cpu.usagePercent)}
                  detail={[
                    `usr ${formatPercent(snapshot.cpu.userPercent)}`,
                    `sys ${formatPercent(snapshot.cpu.systemPercent)}`,
                    snapshot.loadAverage
                      ? `load ${snapshot.loadAverage.map((value: number) => value.toFixed(2)).join('/')}`
                      : null,
                  ]
                    .filter((value): value is string => Boolean(value))
                    .join(' · ')}
                  percent={snapshot.cpu.usagePercent || 0}
                />
              )}
              {snapshot.memory && (
                <CompactBarMetric
                  label="RAM"
                  value={`${formatBytes(snapshot.memory.usedBytes)} / ${formatBytes(snapshot.memory.totalBytes)}`}
                  detail={`used ${formatPercent(snapshot.memory.usagePercent)} · avail ${formatBytes(snapshot.memory.availableBytes)}`}
                  percent={snapshot.memory.usagePercent}
                  tone={
                    snapshot.memory.usagePercent >= 85
                      ? 'danger'
                      : snapshot.memory.usagePercent >= 70
                        ? 'warn'
                        : 'default'
                  }
                />
              )}
              {snapshot.memory?.swap && snapshot.memory.swap.totalBytes > 0 && swapUsagePercent !== undefined && (
                <CompactBarMetric
                  label="SWAP"
                  value={`${formatBytes(snapshot.memory.swap.usedBytes)} / ${formatBytes(snapshot.memory.swap.totalBytes)}`}
                  detail={`used ${formatPercent(swapUsagePercent)}`}
                  percent={swapUsagePercent}
                  tone={swapUsagePercent >= 70 ? 'warn' : 'default'}
                />
              )}
              {primaryDisk && (
                <CompactBarMetric
                  label="DISK"
                  value={`${formatBytes(primaryDisk.usedBytes)} / ${formatBytes(primaryDisk.totalBytes)}`}
                  detail={`${primaryDisk.mountPoint} · ${formatPercent(primaryDisk.usagePercent)}`}
                  percent={primaryDisk.usagePercent}
                  tone={primaryDisk.usagePercent >= 85 ? 'danger' : primaryDisk.usagePercent >= 70 ? 'warn' : 'default'}
                />
              )}
            </div>
            {detailDock}
            {compactDetailGrid}
          </>
        )}
      </div>
    )
  }

  return (
    <div
      className={`monitor-content layout-${presentation.mode}`}
      data-monitor-presentation={presentation.mode}
    >
      <div className="monitor-hud">
        <div className="monitor-hud-main">
          <div className="monitor-hud-kicker">
            {platformLabel} · {(snapshot.system?.connectionType || 'local').toUpperCase()}
          </div>
          <div className="monitor-hud-title">{hostLabel}</div>
          <div className="monitor-hud-meta">
            <span>{snapshot.system?.osName || platformLabel}</span>
            {snapshot.system?.release && <span>{snapshot.system.release}</span>}
            {snapshot.system?.arch && <span>{snapshot.system.arch}</span>}
            {snapshot.cpu?.logicalCoreCount && <span>{snapshot.cpu.logicalCoreCount} logical</span>}
          </div>
        </div>
        <div className="monitor-hud-side">
          <div className="monitor-hud-side-row">
            <span className="monitor-hud-side-label">UPTIME</span>
            <span className="monitor-hud-side-value">{formatUptime(snapshot.uptimeSeconds)}</span>
          </div>
          <div className="monitor-hud-side-row">
            <span className="monitor-hud-side-label">SYNC</span>
            <span className="monitor-hud-side-value">{formatAge(snapshot.timestamp)}</span>
          </div>
          {snapshot.loadAverage && (
            <div className="monitor-hud-side-row">
              <span className="monitor-hud-side-label">LOAD</span>
              <span className="monitor-hud-side-value">
                {snapshot.loadAverage.map((value: number) => value.toFixed(2)).join(' / ')}
              </span>
            </div>
          )}
        </div>
      </div>

      {lastError && (
        <div className="monitor-banner is-warning">
          <AlertTriangle size={14} />
          <span>{lastError}</span>
        </div>
      )}

      <div className="monitor-summary-grid">
        <div className="monitor-summary-tile">
          <div className="monitor-summary-head">
            <span className="monitor-summary-label">CPU</span>
            <span className="monitor-summary-value">{formatPercent(snapshot.cpu?.usagePercent)}</span>
          </div>
          <MiniHistory values={cpuHistory} tone="cpu" limit={presentation.historyBarCount} />
          <div className="monitor-summary-subgrid">
            <span>USR {formatPercent(snapshot.cpu?.userPercent)}</span>
            <span>SYS {formatPercent(snapshot.cpu?.systemPercent)}</span>
            <span>IDLE {formatPercent(snapshot.cpu?.idlePercent)}</span>
          </div>
        </div>

        <div className="monitor-summary-tile">
          <div className="monitor-summary-head">
            <span className="monitor-summary-label">RAM</span>
            <span className="monitor-summary-value">{formatPercent(snapshot.memory?.usagePercent)}</span>
          </div>
          <MiniHistory values={memHistory} tone="memory" limit={presentation.historyBarCount} />
          <div className="monitor-summary-subgrid">
            <span>{formatBytes(snapshot.memory?.usedBytes)}</span>
            <span>/</span>
            <span>{formatBytes(snapshot.memory?.totalBytes)}</span>
          </div>
        </div>

        <div className="monitor-summary-tile">
          <div className="monitor-summary-head">
            <span className="monitor-summary-label">NET</span>
            <span className="monitor-summary-value">
              ↓ {formatBytesPerSec(totals.rx)} · ↑ {formatBytesPerSec(totals.tx)}
            </span>
          </div>
          <div className="monitor-network-summary-history">
            <MiniHistory
              values={rxHistory}
              maxValue={Math.max(1, ...rxHistory, ...txHistory)}
              tone="network-rx"
              limit={presentation.historyBarCount}
            />
            <MiniHistory
              values={txHistory}
              maxValue={Math.max(1, ...rxHistory, ...txHistory)}
              tone="network-tx"
              limit={presentation.historyBarCount}
            />
          </div>
          <div className="monitor-summary-subgrid">
            <span>{snapshot.network?.length || 0} iface</span>
            <span>{snapshot.networkConnections?.length || 0} sockets</span>
          </div>
        </div>

        <div className="monitor-summary-tile">
          <div className="monitor-summary-head">
            <span className="monitor-summary-label">DISK</span>
            <span className="monitor-summary-value">
              {primaryDisk ? `${Math.round(primaryDisk.usagePercent)}%` : '--'}
            </span>
          </div>
          <div className="monitor-summary-path">
            {primaryDisk ? primaryDisk.mountPoint : 'No disk data'}
          </div>
          <div className="monitor-summary-subgrid">
            <span>{primaryDisk ? formatBytes(primaryDisk.usedBytes) : '--'}</span>
            <span>/</span>
            <span>{primaryDisk ? formatBytes(primaryDisk.totalBytes) : '--'}</span>
          </div>
        </div>
      </div>

      {detailDock}

      <div className="monitor-grid">
        {snapshot.cpu ? (
          <section className={cpuCardActive ? 'monitor-card is-detail-source' : 'monitor-card'}>
            <div className="monitor-card-header">
              <div className="monitor-card-title">
                <Cpu size={14} />
                <span>CPU</span>
              </div>
              <SegmentedControl
                value={cpuMode}
                options={[
                  { id: 'cores', label: 'CORES' },
                  { id: 'processes', label: 'TOP' },
                ]}
                onChange={(value) => setCpuMode(value as CpuViewMode)}
              />
            </div>

            <div className="monitor-card-body">
              <div className="monitor-stat-row">
                <div className="monitor-stat-emphasis">{formatPercent(snapshot.cpu.usagePercent)}</div>
                <div className="monitor-stat-meta">
                  {snapshot.cpu.modelName && <span>{snapshot.cpu.modelName}</span>}
                  {snapshot.loadAverage && (
                    <span>load {snapshot.loadAverage.map((value: number) => value.toFixed(2)).join(' / ')}</span>
                  )}
                </div>
              </div>

              <div className="monitor-meter-grid">
                <InlineMeter
                  label="USER"
                  value={formatPercent(snapshot.cpu.userPercent)}
                  percent={snapshot.cpu.userPercent || 0}
                />
                <InlineMeter
                  label="SYSTEM"
                  value={formatPercent(snapshot.cpu.systemPercent)}
                  percent={snapshot.cpu.systemPercent || 0}
                  tone="warn"
                />
                <InlineMeter
                  label="IDLE"
                  value={formatPercent(snapshot.cpu.idlePercent)}
                  percent={snapshot.cpu.idlePercent || 0}
                  tone="rx"
                />
              </div>

              {cpuMode === 'cores' ? (
                visibleCorePercents.length > 0 ? (
                  <>
                    <div className="monitor-core-grid">
                      {visibleCorePercents.map((percent: number, index: number) => (
                        <div key={`cpu-core-${index}`} className="monitor-core-row">
                          <span className="monitor-core-name">
                            CPU{String(index).padStart(2, '0')}
                          </span>
                          <div className="monitor-core-track">
                            <div
                              className="monitor-core-fill"
                              style={{ width: `${clampPercent(percent)}%` }}
                            />
                          </div>
                          <span className="monitor-core-value">{formatPercent(percent)}</span>
                        </div>
                      ))}
                    </div>
                    <SectionOverflowControl
                      visibility={cpuCoreRows}
                      itemLabel="cpu cores"
                      active={detailSectionId === 'cpu-cores'}
                      onToggle={() => toggleDetailSection('cpu-cores')}
                    />
                  </>
                ) : (
                  <div className="monitor-card-empty">Per-core data is unavailable for this target.</div>
                )
              ) : topCpuProcesses.length > 0 ? (
                useCompactCards ? (
                  <>
                    <CompactList
                      rows={topCpuProcesses.map((process: ProcessEntry) => ({
                        id: `cpu-proc-${process.pid}`,
                        label: process.name,
                        detail: `PID ${process.pid}${process.user ? ` · ${process.user}` : ''}`,
                        value: `${formatPercent(process.cpuPercent)} · ${formatBytes(process.memoryBytes)}`,
                      }))}
                    />
                    <SectionOverflowControl
                      visibility={cpuProcessRows}
                      itemLabel="processes"
                      active={detailSectionId === 'cpu-processes'}
                      onToggle={() => toggleDetailSection('cpu-processes')}
                    />
                  </>
                ) : (
                  <>
                    <div className="monitor-table">
                      <div className="monitor-table-head monitor-table-row monitor-table-row-process">
                        <span>PID</span>
                        <span>CPU</span>
                        <span>RSS</span>
                        <span>COMMAND</span>
                      </div>
                      {topCpuProcesses.map((process: ProcessEntry) => (
                        <div
                          key={`cpu-proc-${process.pid}`}
                          className="monitor-table-row monitor-table-row-process"
                        >
                          <span>{process.pid}</span>
                          <span>{formatPercent(process.cpuPercent)}</span>
                          <span>{formatBytes(process.memoryBytes)}</span>
                          <span title={process.command || process.name}>
                            {process.command || process.name}
                          </span>
                        </div>
                      ))}
                    </div>
                    <SectionOverflowControl
                      visibility={cpuProcessRows}
                      itemLabel="processes"
                      active={detailSectionId === 'cpu-processes'}
                      onToggle={() => toggleDetailSection('cpu-processes')}
                    />
                  </>
                )
              ) : (
                <div className="monitor-card-empty">No process data.</div>
              )}
            </div>
          </section>
        ) : (
          <EmptyCard title="CPU" body="No CPU data." icon={<Cpu size={14} />} />
        )}

        {snapshot.memory ? (
          <section className={memoryCardActive ? 'monitor-card is-detail-source' : 'monitor-card'}>
            <div className="monitor-card-header">
              <div className="monitor-card-title">
                <MemoryStick size={14} />
                <span>MEMORY</span>
              </div>
            </div>

            <div className="monitor-card-body">
              <div className="monitor-stat-row">
                <div className="monitor-stat-emphasis">{formatPercent(snapshot.memory.usagePercent)}</div>
                <div className="monitor-stat-meta">
                  <span>
                    {formatBytes(snapshot.memory.usedBytes)} / {formatBytes(snapshot.memory.totalBytes)}
                  </span>
                  <span>avail {formatBytes(snapshot.memory.availableBytes)}</span>
                </div>
              </div>

              <div className="monitor-meter-grid">
                <InlineMeter
                  label="USED"
                  value={formatBytes(snapshot.memory.usedBytes)}
                  percent={snapshot.memory.usagePercent}
                  tone={snapshot.memory.usagePercent >= 85 ? 'danger' : snapshot.memory.usagePercent >= 70 ? 'warn' : 'default'}
                />
                <InlineMeter
                  label="AVAILABLE"
                  value={formatBytes(snapshot.memory.availableBytes)}
                  percent={
                    snapshot.memory.totalBytes > 0
                      ? (snapshot.memory.availableBytes / snapshot.memory.totalBytes) * 100
                      : 0
                  }
                  tone="rx"
                />
                {snapshot.memory.swap && snapshot.memory.swap.totalBytes > 0 && (
                  <InlineMeter
                    label="SWAP"
                    value={`${formatBytes(snapshot.memory.swap.usedBytes)} / ${formatBytes(snapshot.memory.swap.totalBytes)}`}
                    percent={
                      snapshot.memory.swap.totalBytes > 0
                        ? (snapshot.memory.swap.usedBytes / snapshot.memory.swap.totalBytes) * 100
                        : 0
                    }
                    tone="warn"
                  />
                )}
              </div>

              {memoryTags.length > 0 && (
                <div className="monitor-tag-row">
                  {memoryTags.map((tag) => (
                    <span key={tag} className="monitor-tag">
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {topMemoryProcesses.length > 0 ? (
                useCompactCards ? (
                  <>
                    <CompactList
                      rows={topMemoryProcesses.map((process: ProcessEntry) => ({
                        id: `mem-proc-${process.pid}`,
                        label: process.name,
                        detail: `PID ${process.pid}${process.user ? ` · ${process.user}` : ''}`,
                        value: `${formatBytes(process.memoryBytes)} · ${formatPercent(process.cpuPercent)}`,
                      }))}
                    />
                    <SectionOverflowControl
                      visibility={memoryProcessRows}
                      itemLabel="processes"
                      active={detailSectionId === 'memory-processes'}
                      onToggle={() => toggleDetailSection('memory-processes')}
                    />
                  </>
                ) : (
                  <>
                    <div className="monitor-table">
                      <div className="monitor-table-head monitor-table-row monitor-table-row-memory">
                        <span>PID</span>
                        <span>USER</span>
                        <span>RSS</span>
                        <span>COMMAND</span>
                      </div>
                      {topMemoryProcesses.map((process: ProcessEntry) => (
                        <div
                          key={`mem-proc-${process.pid}`}
                          className="monitor-table-row monitor-table-row-memory"
                        >
                          <span>{process.pid}</span>
                          <span>{process.user || '--'}</span>
                          <span>{formatBytes(process.memoryBytes)}</span>
                          <span title={process.command || process.name}>
                            {process.command || process.name}
                          </span>
                        </div>
                      ))}
                    </div>
                    <SectionOverflowControl
                      visibility={memoryProcessRows}
                      itemLabel="processes"
                      active={detailSectionId === 'memory-processes'}
                      onToggle={() => toggleDetailSection('memory-processes')}
                    />
                  </>
                )
              ) : (
                <div className="monitor-card-empty">No process memory data.</div>
              )}
            </div>
          </section>
        ) : (
          <EmptyCard title="Memory" body="No memory data." icon={<MemoryStick size={14} />} />
        )}

        <section className={networkCardActive ? 'monitor-card is-detail-source' : 'monitor-card'}>
          <div className="monitor-card-header">
            <div className="monitor-card-title">
              <Network size={14} />
              <span>NETWORK</span>
            </div>
            <SegmentedControl
              value={networkMode}
              options={[
                { id: 'throughput', label: 'TRAFFIC' },
                { id: 'sockets', label: 'SOCKETS' },
              ]}
              onChange={(value) => setNetworkMode(value as NetworkViewMode)}
            />
          </div>

          <div className="monitor-card-body">
            {networkMode === 'throughput' ? (
              snapshot.network && snapshot.network.length > 0 ? (
                <>
                  <div className="monitor-stat-row">
                    <div className="monitor-stat-emphasis">
                      ↓ {formatBytesPerSec(totals.rx)}
                    </div>
                    <div className="monitor-stat-meta">
                      <span>↑ {formatBytesPerSec(totals.tx)}</span>
                      <span>{snapshot.network.length} interfaces</span>
                    </div>
                  </div>

                  <div className="monitor-network-history-block">
                    <div className="monitor-network-history-row">
                      <span className="monitor-network-history-label">RX</span>
                      <MiniHistory
                        values={rxHistory}
                        maxValue={Math.max(1, ...rxHistory, ...txHistory)}
                        tone="network-rx"
                        limit={presentation.historyBarCount}
                      />
                    </div>
                    <div className="monitor-network-history-row">
                      <span className="monitor-network-history-label">TX</span>
                      <MiniHistory
                        values={txHistory}
                        maxValue={Math.max(1, ...rxHistory, ...txHistory)}
                        tone="network-tx"
                        limit={presentation.historyBarCount}
                      />
                    </div>
                  </div>

                  {useCompactCards ? (
                    <>
                      <CompactList
                        rows={visibleInterfaces.map((entry: NetworkEntry) => {
                          const ifaceTotal = entry.rxBytesPerSec + entry.txBytesPerSec
                          const ifacePercent =
                            totals.rx + totals.tx > 0
                              ? (ifaceTotal / (totals.rx + totals.tx)) * 100
                              : 0
                        return {
                          id: `net-iface-${entry.interface}`,
                          label: entry.interface,
                          detail: `${ifacePercent.toFixed(1)}% share`,
                          value: `↓ ${formatBytesPerSec(entry.rxBytesPerSec)} · ↑ ${formatBytesPerSec(entry.txBytesPerSec)}`,
                        }
                      })}
                    />
                      <SectionOverflowControl
                        visibility={interfaceRows}
                        itemLabel="interfaces"
                        active={detailSectionId === 'network-interfaces'}
                        onToggle={() => toggleDetailSection('network-interfaces')}
                      />
                    </>
                  ) : (
                    <>
                      <div className="monitor-table">
                        <div className="monitor-table-head monitor-table-row monitor-table-row-network">
                          <span>IFACE</span>
                          <span>RX</span>
                          <span>TX</span>
                        </div>
                        {visibleInterfaces.map((entry: NetworkEntry) => {
                          const ifaceTotal = entry.rxBytesPerSec + entry.txBytesPerSec
                          const ifacePercent =
                            totals.rx + totals.tx > 0
                              ? (ifaceTotal / (totals.rx + totals.tx)) * 100
                              : 0
                          return (
                            <div
                              key={`net-iface-${entry.interface}`}
                              className="monitor-network-row"
                            >
                              <div className="monitor-network-row-head">
                                <span className="monitor-network-name">{entry.interface}</span>
                                <span className="monitor-network-share">
                                  {ifacePercent.toFixed(1)}% share
                                </span>
                              </div>
                              <div className="monitor-network-row-meta">
                                <span className="is-rx">↓ {formatBytesPerSec(entry.rxBytesPerSec)}</span>
                                <span className="is-tx">↑ {formatBytesPerSec(entry.txBytesPerSec)}</span>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                      <SectionOverflowControl
                        visibility={interfaceRows}
                        itemLabel="interfaces"
                        active={detailSectionId === 'network-interfaces'}
                        onToggle={() => toggleDetailSection('network-interfaces')}
                      />
                    </>
                  )}
                </>
              ) : (
                <div className="monitor-card-empty">No interface throughput data.</div>
              )
            ) : visibleSockets.length > 0 ? (
              useCompactCards ? (
                <>
                  <CompactList
                    rows={visibleSockets.map((entry: SocketEntry) => ({
                      id: `socket-${entry.protocol}-${entry.pid || 'na'}-${entry.localAddress}-${entry.localPort || 'na'}`,
                      label: entry.processName || `${entry.localAddress}:${entry.localPort ?? '--'}`,
                      detail: `${entry.protocol.toUpperCase()} ${entry.localAddress}:${entry.localPort ?? '--'}${entry.state ? ` · ${entry.state}` : ''}`,
                      value: `${entry.remoteHostCount} hosts · ${entry.connectionCount} conn`,
                      tone: entry.isListening ? 'rx' : 'default',
                    }))}
                  />
                  <SectionOverflowControl
                    visibility={socketRows}
                    itemLabel="sockets"
                    active={detailSectionId === 'network-sockets'}
                    onToggle={() => toggleDetailSection('network-sockets')}
                  />
                </>
              ) : (
                <>
                  <div className="monitor-table">
                    <div className="monitor-table-head monitor-table-row monitor-table-row-socket">
                      <span>PROTO</span>
                      <span>PROC</span>
                      <span>BIND</span>
                      <span>PORT</span>
                      <span>HOSTS</span>
                      <span>CONN</span>
                      <span>STATE</span>
                    </div>
                    {visibleSockets.map((entry: SocketEntry) => (
                      <div
                        key={`socket-${entry.protocol}-${entry.pid || 'na'}-${entry.localAddress}-${entry.localPort || 'na'}`}
                        className="monitor-table-row monitor-table-row-socket"
                      >
                        <span>{entry.protocol.toUpperCase()}</span>
                        <span title={entry.processName || '--'}>{entry.processName || '--'}</span>
                        <span title={entry.localAddress}>{entry.localAddress}</span>
                        <span>{entry.localPort ?? '--'}</span>
                        <span>{entry.remoteHostCount}</span>
                        <span>{entry.connectionCount}</span>
                        <span className={entry.isListening ? 'is-listening' : ''}>
                          {entry.state || '--'}
                        </span>
                      </div>
                    ))}
                  </div>
                  <SectionOverflowControl
                    visibility={socketRows}
                    itemLabel="sockets"
                    active={detailSectionId === 'network-sockets'}
                    onToggle={() => toggleDetailSection('network-sockets')}
                  />
                </>
              )
            ) : (
              <div className="monitor-card-empty">No socket data.</div>
            )}
          </div>
        </section>

        <section className={storageCardActive ? 'monitor-card is-detail-source' : 'monitor-card'}>
          <div className="monitor-card-header">
            <div className="monitor-card-title">
              <HardDrive size={14} />
              <span>STORAGE</span>
            </div>
          </div>

          <div className="monitor-card-body">
            {visibleDisks.length > 0 ? (
              useCompactCards ? (
                <>
                  <CompactList
                    rows={visibleDisks.map((disk: DiskEntry) => ({
                      id: `disk-${disk.filesystem}-${disk.mountPoint}`,
                      label: disk.mountPoint,
                      detail: disk.filesystem,
                      value: `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)} · ${formatPercent(disk.usagePercent)}`,
                    }))}
                  />
                  <SectionOverflowControl
                    visibility={diskRows}
                    itemLabel="disks"
                    active={detailSectionId === 'storage-disks'}
                    onToggle={() => toggleDetailSection('storage-disks')}
                  />
                </>
              ) : (
                <>
                  <div className="monitor-disk-list">
                    {visibleDisks.map((disk: DiskEntry) => (
                      <div
                        key={`disk-${disk.filesystem}-${disk.mountPoint}`}
                        className="monitor-disk-row"
                      >
                        <div className="monitor-disk-row-head">
                          <span className="monitor-disk-name">{disk.mountPoint}</span>
                          <span className="monitor-disk-meta">
                            {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)}
                          </span>
                        </div>
                        <div className="monitor-core-track">
                          <div
                            className="monitor-core-fill"
                            style={{ width: `${clampPercent(disk.usagePercent)}%` }}
                          />
                        </div>
                        <div className="monitor-disk-row-foot">
                          <span>{disk.filesystem}</span>
                          <span>{formatPercent(disk.usagePercent)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <SectionOverflowControl
                    visibility={diskRows}
                    itemLabel="disks"
                    active={detailSectionId === 'storage-disks'}
                    onToggle={() => toggleDetailSection('storage-disks')}
                  />
                </>
              )
            ) : (
              <div className="monitor-card-empty">No disk data.</div>
            )}
          </div>
        </section>

        {gpuRows.totalCount > 0 && (
          <section className={gpuCardActive ? 'monitor-card is-detail-source' : 'monitor-card'}>
            <div className="monitor-card-header">
              <div className="monitor-card-title">
                <Gauge size={14} />
                <span>GPU</span>
              </div>
            </div>

            <div className="monitor-card-body">
              {useCompactCards ? (
                <>
                  <CompactList rows={compactGpuRows} />
                  <SectionOverflowControl
                    visibility={gpuRows}
                    itemLabel="gpus"
                    active={detailSectionId === 'gpu-devices'}
                    onToggle={() => toggleDetailSection('gpu-devices')}
                  />
                </>
              ) : (
                <>
                  <div className="monitor-disk-list">
                    {visibleGpus.map((gpu: GpuEntry, index: number) => {
                      const memoryUsagePercent = resolveGpuMemoryUsagePercent(gpu)
                      return (
                        <div key={`gpu-${index}`} className="monitor-disk-row">
                          <div className="monitor-disk-row-head">
                            <span className="monitor-disk-name">
                              {gpu.name || `GPU ${index + 1}`}
                            </span>
                            <span className="monitor-disk-meta">
                              {formatPercent(gpu.utilizationPercent)}
                            </span>
                          </div>
                          <div className="monitor-meter-grid">
                            <InlineMeter
                              label="GPU"
                              value={formatPercent(gpu.utilizationPercent)}
                              percent={gpu.utilizationPercent || 0}
                              tone="warn"
                            />
                            <InlineMeter
                              label="VRAM"
                              value={formatGpuMemoryFootprint(gpu)}
                              percent={memoryUsagePercent || 0}
                              tone={resolveGpuMemoryTone(memoryUsagePercent)}
                            />
                            {typeof gpu.memoryUtilizationPercent === 'number' &&
                              Number.isFinite(gpu.memoryUtilizationPercent) && (
                                <InlineMeter
                                  label="MEM"
                                  value={formatPercent(gpu.memoryUtilizationPercent)}
                                  percent={gpu.memoryUtilizationPercent}
                                  tone="rx"
                                />
                              )}
                          </div>
                          <div className="monitor-disk-row-foot">
                            <span>{formatGpuMemoryFootprint(gpu)}</span>
                            <span>
                              {gpu.temperatureC !== undefined ? `${gpu.temperatureC}°C` : '--'}
                            </span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <SectionOverflowControl
                    visibility={gpuRows}
                    itemLabel="gpus"
                    active={detailSectionId === 'gpu-devices'}
                    onToggle={() => toggleDetailSection('gpu-devices')}
                  />
                </>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  )
})

const MonitorToggle: React.FC<{
  enabled: boolean
  onToggle: () => void
}> = ({ enabled, onToggle }) => (
  <button
    type="button"
    className={enabled ? 'monitor-polling-toggle is-enabled' : 'monitor-polling-toggle'}
    title={enabled ? 'Pause monitoring' : 'Resume monitoring'}
    aria-label={enabled ? 'Pause monitoring' : 'Resume monitoring'}
    aria-pressed={enabled}
    onClick={(event) => {
      event.stopPropagation()
      onToggle()
    }}
  >
    <span className="monitor-polling-toggle-track" aria-hidden="true">
      <span className="monitor-polling-toggle-thumb" />
    </span>
  </button>
)

export const MonitorPanel: React.FC<MonitorPanelProps> = observer(({
  store,
  panelId,
  tabs,
  activeTabId,
  onSelectTab,
  onLayoutHeaderContextMenu,
}) => {
  const t = store.i18n.t
  const isLayoutDragSource = store.layout.isDragging && store.layout.draggingPanelId === panelId
  const panelBodyRef = React.useRef<HTMLDivElement | null>(null)
  const [panelBodySize, setPanelBodySize] = React.useState({ width: 0, height: 0 })
  const panelRect = store.layout.getPanelRect(panelId)
  const tabBarMode = resolvePanelTabBarMode(
    'monitor',
    panelRect?.width || 0,
    tabs.length,
    store.panelTabDisplayMode,
  )

  const activeTerminalId =
    activeTabId && tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0]?.id ?? null

  const monitorEnabled = activeTerminalId ? store.isMonitorSourceEnabled(activeTerminalId) : false
  const handleToggleMonitor = React.useCallback(() => {
    if (activeTerminalId) {
      store.setMonitorEnabled(activeTerminalId, !monitorEnabled)
    }
  }, [activeTerminalId, monitorEnabled, store])

  React.useEffect(() => {
    if (tabs.length > 0 && !activeTabId) {
      onSelectTab(tabs[0].id)
    }
  }, [tabs, activeTabId, onSelectTab])

  React.useEffect(() => {
    const panelBody = panelBodyRef.current
    if (!panelBody) return

    const updateSize = () => {
      const nextWidth = panelBody.clientWidth
      const nextHeight = panelBody.clientHeight
      setPanelBodySize((current) =>
        current.width === nextWidth && current.height === nextHeight
          ? current
          : { width: nextWidth, height: nextHeight }
      )
    }

    updateSize()
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateSize) : null
    observer?.observe(panelBody)
    return () => {
      observer?.disconnect()
    }
  }, [])

  const activeTab = activeTerminalId ? tabs.find((tab) => tab.id === activeTerminalId) : null
  const monitorToggleControl = (
    <MonitorToggle enabled={monitorEnabled} onToggle={handleToggleMonitor} />
  )

  if (tabs.length === 0) {
    return (
      <div className={`panel panel-monitor${isLayoutDragSource ? ' is-dragging-source' : ''}`}>
        <div
          className="monitor-tabs-container is-draggable"
          draggable
          data-layout-panel-draggable="true"
          data-layout-panel-id={panelId}
          data-layout-panel-kind="monitor"
          onContextMenu={onLayoutHeaderContextMenu}
        >
          <div className="panel-tab-drag-handle" aria-hidden="true">
            <GripVertical size={12} strokeWidth={2.4} />
          </div>
          <div className="monitor-tabs-bar" />
        </div>
        <div className="panel-body monitor-panel-body" ref={panelBodyRef}>
          <div className="monitor-empty-state">{t.layout.monitorKind}: No active connections</div>
        </div>
      </div>
    )
  }

  return (
    <div className={`panel panel-monitor${isLayoutDragSource ? ' is-dragging-source' : ''}`}>
      <div
        className="monitor-tabs-container is-draggable"
        draggable
        data-layout-panel-draggable="true"
        data-layout-panel-id={panelId}
        data-layout-panel-kind="monitor"
        onContextMenu={onLayoutHeaderContextMenu}
      >
        <div className="panel-tab-drag-handle" aria-hidden="true">
          <GripVertical size={12} strokeWidth={2.4} />
        </div>
        {tabBarMode === 'select' ? (
          <>
            <CompactPanelTabSelect
              className="monitor-tabs-select"
              panelId={panelId}
              panelKind="monitor"
              value={activeTerminalId}
              options={tabs.map((tab) => ({
                value: tab.id,
                label: tab.title,
                leading: (
                  <span className="monitor-tab-icon">
                    <Activity size={14} strokeWidth={2} />
                  </span>
                ),
                trailing: (
                  <span
                    className={`tab-runtime-state tab-runtime-state-${(tab.runtimeState || 'initializing') === 'ready' ? 'ready' : 'inactive'}`}
                    title={tab.runtimeState || 'initializing'}
                  />
                )
              }))}
              onChange={onSelectTab}
              leading={
                <span className="monitor-tab-icon">
                  <Activity size={14} strokeWidth={2} />
                </span>
              }
              trailing={
                activeTab ? (
                  <span
                    className={`tab-runtime-state tab-runtime-state-${(activeTab.runtimeState || 'initializing') === 'ready' ? 'ready' : 'inactive'}`}
                    title={activeTab.runtimeState || 'initializing'}
                  />
                ) : null
              }
            />
            <div className="monitor-tabs-actions">{monitorToggleControl}</div>
          </>
        ) : (
          <>
            <div
              className="monitor-tabs-bar"
              data-layout-tab-bar="true"
              data-layout-tab-panel-id={panelId}
              data-layout-tab-kind="monitor"
            >
              {tabs.map((tab, index) => {
                const isActive = tab.id === activeTerminalId
                const runtimeState = tab.runtimeState || 'initializing'
                const runtimeIndicatorState = runtimeState === 'ready' ? 'ready' : 'inactive'
                return (
                  <div
                    key={tab.id}
                    className={isActive ? 'monitor-tab is-active' : 'monitor-tab'}
                    onClick={() => onSelectTab(tab.id)}
                    role="button"
                    tabIndex={0}
                    draggable
                    data-layout-tab-draggable="true"
                    data-layout-tab-id={tab.id}
                    data-layout-tab-kind="monitor"
                    data-layout-tab-panel-id={panelId}
                    data-layout-tab-index={index}
                  >
                    <span className="monitor-tab-icon">
                      <Activity size={14} strokeWidth={2} />
                    </span>
                    <span className="monitor-tab-title">{tab.title}</span>
                    <span
                      className={`tab-runtime-state tab-runtime-state-${runtimeIndicatorState}`}
                      title={runtimeState}
                    />
                  </div>
                )
              })}
            </div>
            <div className="monitor-tabs-actions">{monitorToggleControl}</div>
          </>
        )}
      </div>
      <div className="panel-body monitor-panel-body" ref={panelBodyRef}>
        {activeTab && (
          monitorEnabled ? (
            <MonitorTabView
              key={activeTab.id}
              store={store}
              terminalId={activeTab.id}
              terminalTitle={activeTab.title}
              runtimeState={activeTab.runtimeState}
              availableWidth={panelBodySize.width}
              availableHeight={panelBodySize.height}
            />
          ) : (
            <div className="monitor-paused-state">
              <Pause size={16} />
              <span>Monitoring paused</span>
            </div>
          )
        )}
      </div>
    </div>
  )
})
