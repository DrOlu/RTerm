/**
 * Incident bundle: chat + tabs + recording + run id (v3.8.0).
 */

export interface IncidentBundle {
  id: string
  title: string
  sessionId?: string
  tabIds: string[]
  recordingId?: string
  runId?: string
  createdAt: number
}

const store = new Map<string, IncidentBundle>()
let n = 0

export function openIncident(title: string, parts: Partial<IncidentBundle> = {}): IncidentBundle {
  const id = `INC-${++n}`
  const b: IncidentBundle = {
    id,
    title,
    sessionId: parts.sessionId,
    tabIds: parts.tabIds ?? [],
    recordingId: parts.recordingId,
    runId: parts.runId,
    createdAt: Date.now(),
  }
  store.set(id, b)
  return b
}

export function getIncident(id: string): IncidentBundle | undefined {
  return store.get(id)
}

export function listIncidents(): IncidentBundle[] {
  return [...store.values()]
}
