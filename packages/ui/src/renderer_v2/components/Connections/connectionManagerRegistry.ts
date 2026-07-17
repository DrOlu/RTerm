import { Server, Shield, Waypoints, MonitorCog, type LucideIcon } from 'lucide-react'
import type { AppStore } from '../../stores/AppStore'
import { PortForwardType } from '../../lib/ipcTypes'

export type ConnectionsSection = 'ssh' | 'winrm' | 'proxies' | 'tunnels'

export interface ConnectionManagerSectionDefinition {
  id: ConnectionsSection
  labelKey: 'ssh' | 'winrm' | 'proxy' | 'tunnels'
  icon: LucideIcon
  getEntries: (store: AppStore) => any[]
  createDraft: () => any
  saveDraft: (store: AppStore, draft: any) => Promise<void>
  deleteEntry: (store: AppStore, id: string) => Promise<void>
}

const createSectionDefinition = (
  definition: ConnectionManagerSectionDefinition,
): ConnectionManagerSectionDefinition => definition

export const CONNECTION_MANAGER_SECTIONS: readonly ConnectionManagerSectionDefinition[] =
  Object.freeze([
    createSectionDefinition({
      id: 'ssh',
      labelKey: 'ssh',
      icon: Server,
      getEntries: (store) => store.settings?.connections?.ssh ?? [],
      createDraft: () => ({
        id: `ssh-${crypto.randomUUID?.() ?? Math.random().toString(16).slice(2)}`,
        name: '',
        host: '',
        port: 22,
        username: '',
        authMethod: 'password',
        password: '',
        privateKey: '',
        privateKeyPath: '',
        passphrase: '',
      }),
      saveDraft: async (store, draft) => {
        const next = {
          ...draft,
          port: Number(draft.port) || 22,
          authMethod:
            draft.authMethod === 'privateKey' ? 'privateKey' : 'password',
          jumpHost: draft.jumpHost
            ? {
                ...draft.jumpHost,
                port: Number(draft.jumpHost.port) || 22,
              }
            : undefined,
        }
        await store.saveSshConnection(next)
      },
      deleteEntry: async (store, id) => {
        await store.deleteSshConnection(id)
      },
    }),
    createSectionDefinition({
      id: 'winrm',
      labelKey: 'winrm',
      icon: MonitorCog,
      getEntries: (store) => store.settings?.connections?.winrm ?? [],
      createDraft: () => ({
        id: `winrm-${crypto.randomUUID?.() ?? Math.random().toString(16).slice(2)}`,
        name: '',
        host: '',
        port: 5985,
        username: 'Administrator',
        password: '',
        transport: 'http',
        auth: 'basic',
      }),
      saveDraft: async (store, draft) => {
        await store.saveWinrmConnection({
          ...draft,
          port: Number(draft.port) || 5985,
        })
      },
      deleteEntry: async (store, id) => {
        await store.deleteWinrmConnection(id)
      },
    }),
    createSectionDefinition({
      id: 'proxies',
      labelKey: 'proxy',
      icon: Shield,
      getEntries: (store) => store.settings?.connections?.proxies ?? [],
      createDraft: () => ({
        id: `proxy-${crypto.randomUUID?.() ?? Date.now()}`,
        name: '',
        type: 'socks5',
        host: '',
        port: 1080,
        username: '',
        password: '',
      }),
      saveDraft: async (store, draft) => {
        await store.saveProxy({
          ...draft,
          port: Number(draft.port) || 1080,
        })
      },
      deleteEntry: async (store, id) => {
        await store.deleteProxy(id)
      },
    }),
    createSectionDefinition({
      id: 'tunnels',
      labelKey: 'tunnels',
      icon: Waypoints,
      getEntries: (store) => store.settings?.connections?.tunnels ?? [],
      createDraft: () => ({
        id: `tunnel-${crypto.randomUUID?.() ?? Date.now()}`,
        name: '',
        type: PortForwardType.Local,
        host: '127.0.0.1',
        port: 8080,
        targetAddress: '127.0.0.1',
        targetPort: 80,
      }),
      saveDraft: async (store, draft) => {
        await store.saveTunnel({
          ...draft,
          port: Number(draft.port) || 8080,
          targetPort:
            draft.type !== PortForwardType.Dynamic
              ? Number(draft.targetPort) || 80
              : undefined,
        })
      },
      deleteEntry: async (store, id) => {
        await store.deleteTunnel(id)
      },
    }),
  ])

export const getConnectionManagerSectionDefinition = (
  section: ConnectionsSection,
): ConnectionManagerSectionDefinition =>
  CONNECTION_MANAGER_SECTIONS.find((item) => item.id === section) ??
  CONNECTION_MANAGER_SECTIONS[0]

