import React from 'react'
import { observer } from 'mobx-react-lite'
import { ArrowLeft, KeyRound, LockKeyhole, MonitorCog, Cable, FolderTree, Pencil, Plus, Save, Server, Shield, Trash2, Waypoints, Upload } from 'lucide-react'
import type { AppStore } from '../../stores/AppStore'
import { PortForwardType, type TunnelEntry } from '../../lib/ipcTypes'
import './connections.scss'
import { ConfirmDialog } from '../Common/ConfirmDialog'

import { Select } from '../../platform/Select'
import {
  CONNECTION_MANAGER_SECTIONS,
  getConnectionManagerSectionDefinition,
  type ConnectionsSection,
} from './connectionManagerRegistry'

export const ConnectionsView: React.FC<{ store: AppStore }> = observer(({ store }) => {
  const t = store.i18n.t
  const [section, setSection] = React.useState<ConnectionsSection>('ssh')
  const sectionDefinition = React.useMemo(
    () => getConnectionManagerSectionDefinition(section),
    [section],
  )
  const ssh = store.settings?.connections?.ssh ?? []
  const winrm = store.settings?.connections?.winrm ?? []
  const serial = store.settings?.connections?.serial ?? []
  const groups = store.settings?.automation?.groups ?? []
  const scripts = store.settings?.automation?.scripts ?? []
  const scheduledTasks = store.settings?.automation?.scheduledTasks ?? []
  const templates = store.settings?.automation?.templates ?? []

  const proxies = store.settings?.connections?.proxies ?? []
  const tunnels = store.settings?.connections?.tunnels ?? []
  const groupsList = groups

  // PuTTY import file picker
  const puttyInputRef = React.useRef<HTMLInputElement>(null)
  const [puttyMsg, setPuttyMsg] = React.useState<string | null>(null)
  async function handlePuttyFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const n = await store.importPuttySessions(text)
    setPuttyMsg(n > 0 ? `Imported ${n} SSH connection(s) from PuTTY.` : 'No new SSH sessions found in the file.')
    e.target.value = ''
  }

  const [editingId, setEditingId] = React.useState<string | null>(null)

  const [draft, setDraft] = React.useState<any>(null)
  const [deleteConfirm, setDeleteConfirm] = React.useState<null | { section: ConnectionsSection; id: string }>(null)

  React.useEffect(() => {
    // reset editor when switching sections
    setEditingId(null)
    setDraft(null)
  }, [section])

  function startNewEntry() {
    const nextDraft = sectionDefinition.createDraft()
    setEditingId(nextDraft.id)
    setDraft(nextDraft)
  }

  function startEdit(entry: any) {
    setEditingId(entry.id)
    setDraft({ ...entry })
  }

  async function saveDraft() {
    if (!draft) return
    await sectionDefinition.saveDraft(store, draft)
  }

  async function deleteCurrent() {
    if (!editingId) return
    setDeleteConfirm({ section, id: editingId })
  }

  return (
    <div className="connections">
      <ConfirmDialog
        open={!!deleteConfirm}
        title={t.common.confirmDeleteTitle}
        message={t.common.confirmDeleteConfig}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        danger
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={async () => {
          if (!deleteConfirm) return
          const { section: sec, id } = deleteConfirm
          await getConnectionManagerSectionDefinition(sec).deleteEntry(store, id)
          setDeleteConfirm(null)
          setEditingId(null)
          setDraft(null)
        }}
      />
      <div className="connections-sidebar">
        <button className="connections-back-btn" onClick={() => store.closeOverlay()} title={t.common.back}>
          <ArrowLeft size={16} strokeWidth={2} />
        </button>

        <div className="connections-nav">
          {CONNECTION_MANAGER_SECTIONS.map((item) => {
            const Icon = item.icon
            const label =
              item.labelKey === 'ssh'
                ? t.connections.ssh
                : item.labelKey === 'winrm'
                  ? (t.connections as any).winrm ?? 'WinRM'
                  : item.labelKey === 'serial'
                    ? (t.connections as any).serial ?? 'Serial'
                    : item.labelKey === 'proxy'
                      ? t.connections.proxy
                      : item.labelKey === 'tunnels'
                        ? t.connections.tunnels
                        : item.labelKey === 'groups'
                          ? (t.connections as any).groups ?? 'Groups'
                          : item.labelKey === 'scripts'
                            ? (t.connections as any).scripts ?? 'Scripts'
                            : item.labelKey === 'scheduledTasks'
                              ? (t.connections as any).scheduledTasks ?? 'Scheduled Tasks'
                              : (t.connections as any).templates ?? 'Templates'
            return (
              <div
                key={item.id}
                className={section === item.id ? 'connections-nav-item is-active' : 'connections-nav-item'}
                onClick={() => setSection(item.id)}
                role="button"
                tabIndex={0}
              >
                <span className="icon">
                  <Icon size={16} strokeWidth={2} />
                </span>
                <span>{label}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="connections-content">
        {section === 'ssh' ? (
          <>
            <div className="connections-header">
              <div className="connections-title">{t.connections.ssh}</div>
              <div className="connections-actions">
                {/* Add new remote connection (as requested: + placed inside SSH panel) */}
                <button className="icon-btn-sm" title={t.common.add} onClick={startNewEntry}>
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
            </div>

            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header">
                  <div className="connections-row-main header-main">
                    <div>{t.common.name}</div>
                    <div>{t.common.host}</div>
                    <div>{t.common.port}</div>
                    <div>{t.common.user}</div>
                  </div>
                  <div className="row-icon header-icon" aria-hidden="true" />
                </div>
                {ssh.map((c) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button
                      className="connections-row-main"
                      onClick={() => startEdit(c)}
                      title={t.common.edit}
                    >
                      <div>{c.name}</div>
                      <div>{c.host}</div>
                      <div>{c.port}</div>
                      <div>{c.username}</div>
                    </button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}>
                      <Pencil size={14} strokeWidth={2} />
                    </button>
                  </div>
                ))}
                {!ssh.length ? <div className="connections-empty">No SSH connections yet.</div> : null}
              </div>

              <div className="connections-editor">
                {!draft ? (
                  <div className="editor-empty">{t.common.selectOrCreate}</div>
                ) : (
                  <div className="editor-card">
                    <div className="editor-row">
                      <span className="editor-icon">
                        <Server size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.common.name}
                        value={draft.name ?? ''}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Server size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.common.host}
                        value={draft.host ?? ''}
                        onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Server size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.common.port}
                        value={String(draft.port ?? 22)}
                        onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Server size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder={t.common.user}
                        value={draft.username ?? ''}
                        onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <KeyRound size={16} strokeWidth={2} />
                      </span>
                      <Select
                        className="editor-select"
                        value={draft.authMethod ?? 'password'}
                        onChange={(val) => setDraft({ ...draft, authMethod: val })}
                        options={[
                          { value: 'password', label: 'Password' },
                          { value: 'privateKey', label: 'Private Key' }
                        ]}
                      />
                    </div>

                    {/* Default pwd, but all fields supported: show key/path/passphrase in key mode */}
                    {(draft.authMethod ?? 'password') === 'password' ? (
                    <div className="editor-row">
                      <span className="editor-icon">
                        <LockKeyhole size={16} strokeWidth={2} />
                      </span>
                      <input
                        type="password"
                        className="editor-input"
                        placeholder={t.common.password}
                        autoComplete="new-password"
                        value={draft.password ?? ''}
                        onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                      />
                    </div>
                    ) : (
                      <>
                        <div className="editor-row">
                          <span className="editor-icon">
                            <LockKeyhole size={16} strokeWidth={2} />
                          </span>
                          <input
                            className="editor-input"
                            placeholder={t.common.privateKeyPath}
                            value={draft.privateKeyPath ?? ''}
                            onChange={(e) => setDraft({ ...draft, privateKeyPath: e.target.value })}
                          />
                        </div>
                        <div className="editor-row">
                          <span className="editor-icon">
                            <LockKeyhole size={16} strokeWidth={2} />
                          </span>
                          <input
                            className="editor-input"
                            placeholder={t.common.privateKeyInline}
                            value={draft.privateKey ?? ''}
                            onChange={(e) => setDraft({ ...draft, privateKey: e.target.value })}
                          />
                        </div>
                        <div className="editor-row">
                          <span className="editor-icon">
                            <LockKeyhole size={16} strokeWidth={2} />
                          </span>
                          <input
                            className="editor-input"
                            placeholder={t.common.passphrase}
                            value={draft.passphrase ?? ''}
                            onChange={(e) => setDraft({ ...draft, passphrase: e.target.value })}
                          />
                        </div>
                      </>
                    )}

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Shield size={16} strokeWidth={2} />
                      </span>
                      <Select
                        className="editor-select"
                        value={draft.proxyId ?? ''}
                        onChange={(id) => setDraft({ ...draft, proxyId: id || undefined })}
                        options={[
                          { value: '', label: `${t.connections.proxy}: None` },
                          ...proxies.map(p => ({ value: p.id, label: p.name }))
                        ]}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Waypoints size={16} strokeWidth={2} />
                      </span>
                      <Select
                        className="editor-select"
                        value={draft.jumpHost?.id ?? ''}
                        onChange={(selectedId) => {
                          if (!selectedId) {
                            const { jumpHost, ...rest } = draft
                            setDraft(rest)
                          } else {
                            const selected = ssh.find(s => s.id === selectedId)
                            if (selected) {
                              setDraft({ ...draft, jumpHost: { ...selected } })
                            }
                          }
                        }}
                        options={[
                          { value: '', label: `${t.connections.jumpHost}: None` },
                          ...ssh.filter(s => s.id !== draft.id).map(s => ({ value: s.id, label: s.name || s.host }))
                        ]}
                      />
                    </div>

                    {/* SSH algorithms / TERM preset for legacy network equipment.
                        Older Cisco IOS/IOS-XE (and similar) only offer legacy
                        algorithms (DH group1/14-SHA1, ssh-rsa, aes*-cbc,
                        hmac-sha1) and reject ssh2's modern strict defaults at
                        handshake. `cisco`/`legacy` broaden the negotiated set.
                        Some images also require TERM=vt100 instead of xterm. */}
                    <div className="editor-row">
                      <span className="editor-icon">
                        <Shield size={16} strokeWidth={2} />
                      </span>
                      <Select
                        className="editor-select"
                        value={draft.algorithmsPreset ?? 'modern'}
                        onChange={(val) => setDraft({ ...draft, algorithmsPreset: val === 'modern' ? undefined : val })}
                        options={[
                          { value: 'modern', label: 'Algorithms: Modern (default)' },
                          { value: 'legacy', label: 'Algorithms: Legacy' },
                          { value: 'cisco', label: 'Algorithms: Cisco / Network gear' }
                        ]}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon">
                        <Server size={16} strokeWidth={2} />
                      </span>
                      <input
                        className="editor-input"
                        placeholder="TERM (default: xterm-256color)"
                        value={draft.termType ?? ''}
                        onChange={(e) => setDraft({ ...draft, termType: e.target.value || undefined })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon"><FolderTree size={16} strokeWidth={2} /></span>
                      <Select
                        className="editor-select"
                        value={draft.groupId ?? ''}
                        onChange={(val) => setDraft({ ...draft, groupId: val || undefined })}
                        options={[{ value: '', label: 'Group: (none)' }, ...groupsList.map((g: any) => ({ value: g.id, label: `Group: ${g.name}` }))]}
                      />
                    </div>
                    <div className="editor-row" style={{ height: 'auto', alignItems: 'flex-start', padding: '8px 0' }}>
                      <span className="editor-icon" style={{ marginTop: 6 }}><Pencil size={16} strokeWidth={2} /></span>
                      <textarea
                        className="editor-input"
                        style={{ minHeight: 48, resize: 'vertical' }}
                        placeholder="Notes (per-device knowledge)"
                        value={draft.notes ?? ''}
                        onChange={(e) => setDraft({ ...draft, notes: e.target.value || undefined })}
                      />
                    </div>
                    {ssh.length === 0 && (
                      <div className="editor-row" style={{ justifyContent: 'flex-end' }}>
                        <button className="icon-btn-sm" title="Import PuTTY sessions" onClick={() => puttyInputRef.current?.click()}><Upload size={14} /></button>
                        <input ref={puttyInputRef} type="file" accept=".reg,.txt" style={{ display: 'none' }} onChange={handlePuttyFile} />
                      </div>
                    )}
                    {puttyMsg && section === 'ssh' && <div style={{ fontSize: 12, color: 'var(--fg-muted)', padding: '4px 0' }}>{puttyMsg}</div>}

                    <div className="editor-row" style={{ height: 'auto', alignItems: 'flex-start', padding: '8px 0' }}>
                      <span className="editor-icon" style={{ marginTop: 6 }}>
                        <Waypoints size={16} strokeWidth={2} />
                      </span>
                      <div style={{ flex: 1, padding: '0 8px' }}>
                        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 4 }}>{t.connections.tunnels}</div>
                        {tunnels.map(tu => (
                          <div key={tu.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                            <input
                              type="checkbox"
                              checked={(draft.tunnelIds ?? []).includes(tu.id)}
                              onChange={(e) => {
                                const current = draft.tunnelIds ?? []
                                if (e.target.checked) setDraft({ ...draft, tunnelIds: [...current, tu.id] })
                                else setDraft({ ...draft, tunnelIds: current.filter((x: string) => x !== tu.id) })
                              }}
                            />
                            <span style={{ fontSize: 13, color: 'var(--fg)' }}>{tu.name}</span>
                          </div>
                        ))}
                        {!tunnels.length && <div style={{ fontSize: 12, color: 'var(--fg-muted)', opacity: 0.5 }}>No tunnels defined</div>}
                      </div>
                    </div>

                    <div className="editor-actions">
                      <button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}>
                        <Save size={16} strokeWidth={2} />
                      </button>
                      <button
                        className="icon-btn-sm danger"
                        title={t.common.delete}
                        onClick={deleteCurrent}
                      >
                        <Trash2 size={16} strokeWidth={2} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}

        {section === 'winrm' ? (
          <>
            <div className="connections-header">
              <div className="connections-title">{(t.connections as any).winrm ?? 'WinRM'}</div>
              <div className="connections-actions">
                <button className="icon-btn-sm" title={t.common.add} onClick={startNewEntry}>
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
            </div>

            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header">
                  <div className="connections-row-main header-main">
                    <div>{t.common.name}</div>
                    <div>{t.common.host}</div>
                    <div>{t.common.port}</div>
                    <div>{t.common.user}</div>
                  </div>
                  <div className="row-icon header-icon" aria-hidden="true" />
                </div>
                {winrm.map((c) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button className="connections-row-main" onClick={() => startEdit(c)} title={t.common.edit}>
                      <div>{c.name}</div>
                      <div>{c.host}</div>
                      <div>{c.port}</div>
                      <div>{c.username}</div>
                    </button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}>
                      <Pencil size={14} strokeWidth={2} />
                    </button>
                  </div>
                ))}
                {!winrm.length ? <div className="connections-empty">No WinRM connections yet.</div> : null}
              </div>

              <div className="connections-editor">
                {!draft ? (
                  <div className="editor-empty">{t.common.selectOrCreate}</div>
                ) : (
                  <div className="editor-card">
                    <div className="editor-row">
                      <span className="editor-icon"><MonitorCog size={16} strokeWidth={2} /></span>
                      <input className="editor-input" placeholder={t.common.name} value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><MonitorCog size={16} strokeWidth={2} /></span>
                      <input className="editor-input" placeholder={t.common.host} value={draft.host ?? ''} onChange={(e) => setDraft({ ...draft, host: e.target.value })} />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><MonitorCog size={16} strokeWidth={2} /></span>
                      <input className="editor-input" placeholder={t.common.port} value={String(draft.port ?? 5985)} onChange={(e) => setDraft({ ...draft, port: e.target.value })} />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><MonitorCog size={16} strokeWidth={2} /></span>
                      <input className="editor-input" placeholder={t.common.user} value={draft.username ?? ''} onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><MonitorCog size={16} strokeWidth={2} /></span>
                      <input className="editor-input" type="password" placeholder={t.common.password ?? 'Password'} value={draft.password ?? ''} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><MonitorCog size={16} strokeWidth={2} /></span>
                      <input className="editor-input" placeholder="Domain (optional, e.g. CORP)" value={draft.domain ?? ''} onChange={(e) => setDraft({ ...draft, domain: e.target.value || undefined })} />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Shield size={16} strokeWidth={2} /></span>
                      <Select
                        className="editor-select"
                        value={draft.transport ?? 'http'}
                        onChange={(val) => setDraft({ ...draft, transport: val as 'http' | 'https', port: val === 'https' ? 5986 : 5985 })}
                        options={[
                          { value: 'http', label: 'Transport: HTTP (5985)' },
                          { value: 'https', label: 'Transport: HTTPS (5986)' },
                        ]}
                      />
                    </div>
                    <div className="editor-actions">
                      <button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}><Save size={16} /></button>
                      <button className="icon-btn-sm danger" title={t.common.delete} onClick={deleteCurrent}><Trash2 size={16} strokeWidth={2} /></button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}

        {section === 'serial' ? (
          <>
            <div className="connections-header">
              <div className="connections-title">{(t.connections as any).serial ?? 'Serial'}</div>
              <div className="connections-actions">
                <button className="icon-btn-sm" title={t.common.add} onClick={startNewEntry}><Plus size={16} strokeWidth={2} /></button>
              </div>
            </div>
            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header"><div className="connections-row-main header-main"><div>{t.common.name}</div><div>Path</div><div>Baud</div><div></div></div><div className="row-icon header-icon" /></div>
                {serial.map((c) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button className="connections-row-main" onClick={() => startEdit(c)} title={t.common.edit}><div>{c.name}</div><div>{c.path}</div><div>{c.baudRate}</div><div></div></button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}><Pencil size={14} strokeWidth={2} /></button>
                  </div>
                ))}
                {!serial.length ? <div className="connections-empty">No serial connections yet. (Requires the `serialport` npm package.)</div> : null}
              </div>
              <div className="connections-editor">
                {!draft ? <div className="editor-empty">{t.common.selectOrCreate}</div> : (
                  <div className="editor-card">
                    <div className="editor-row"><span className="editor-icon"><Cable size={16} strokeWidth={2} /></span><input className="editor-input" placeholder={t.common.name} value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
                    <div className="editor-row"><span className="editor-icon"><Cable size={16} strokeWidth={2} /></span><input className="editor-input" placeholder="Device path (/dev/ttyUSB0 or COM3)" value={draft.path ?? ''} onChange={(e) => setDraft({ ...draft, path: e.target.value })} /></div>
                    <div className="editor-row"><span className="editor-icon"><Cable size={16} strokeWidth={2} /></span><input className="editor-input" placeholder="Baud rate" value={String(draft.baudRate ?? 9600)} onChange={(e) => setDraft({ ...draft, baudRate: e.target.value })} /></div>
                    <div className="editor-row"><span className="editor-icon"><Shield size={16} strokeWidth={2} /></span>
                      <Select className="editor-select" value={String(draft.parity ?? 'none')} onChange={(val) => setDraft({ ...draft, parity: val })} options={[{value:'none',label:'Parity: none'},{value:'even',label:'Parity: even'},{value:'odd',label:'Parity: odd'}]} />
                    </div>
                    <div className="editor-row"><span className="editor-icon"><Shield size={16} strokeWidth={2} /></span>
                      <Select className="editor-select" value={String(draft.flowControl ?? 'none')} onChange={(val) => setDraft({ ...draft, flowControl: val })} options={[{value:'none',label:'Flow: none'},{value:'xon/xoff',label:'Flow: XON/XOFF'},{value:'rts/cts',label:'Flow: RTS/CTS'}]} />
                    </div>
                    <div className="editor-row"><span className="editor-icon"><FolderTree size={16} strokeWidth={2} /></span>
                      <Select className="editor-select" value={draft.groupId ?? ''} onChange={(val) => setDraft({ ...draft, groupId: val || undefined })} options={[{value:'',label:'Group: (none)'}, ...groupsList.map((g:any)=>({value:g.id,label:`Group: ${g.name}`}))]} />
                    </div>
                    <div className="editor-row" style={{ height: 'auto', alignItems: 'flex-start', padding: '8px 0' }}><span className="editor-icon" style={{ marginTop: 6 }}><Pencil size={16} strokeWidth={2} /></span><textarea className="editor-input" style={{ minHeight: 48, resize: 'vertical' }} placeholder="Notes" value={draft.notes ?? ''} onChange={(e) => setDraft({ ...draft, notes: e.target.value || undefined })} /></div>
                    <div className="editor-actions"><button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}><Save size={16} /></button><button className="icon-btn-sm danger" title={t.common.delete} onClick={deleteCurrent}><Trash2 size={16} /></button></div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}

        {section === 'groups' ? (
          <>
            <div className="connections-header">
              <div className="connections-title">{(t.connections as any).groups ?? 'Groups'}</div>
              <div className="connections-actions"><button className="icon-btn-sm" title={t.common.add} onClick={startNewEntry}><Plus size={16} strokeWidth={2} /></button></div>
            </div>
            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header"><div className="connections-row-main header-main"><div>{t.common.name}</div><div>Parent</div></div><div className="row-icon header-icon" /></div>
                {groups.map((c) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button className="connections-row-main" onClick={() => startEdit(c)} title={t.common.edit}><div>{c.name}</div><div>{groups.find((g:any)=>g.id===c.parentId)?.name ?? '—'}</div></button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}><Pencil size={14} strokeWidth={2} /></button>
                  </div>
                ))}
                {!groups.length ? <div className="connections-empty">No groups yet. Assign connections to a group via their Group selector.</div> : null}
              </div>
              <div className="connections-editor">
                {!draft ? <div className="editor-empty">{t.common.selectOrCreate}</div> : (
                  <div className="editor-card">
                    <div className="editor-row"><span className="editor-icon"><FolderTree size={16} strokeWidth={2} /></span><input className="editor-input" placeholder={t.common.name} value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
                    <div className="editor-row"><span className="editor-icon"><FolderTree size={16} strokeWidth={2} /></span>
                      <Select className="editor-select" value={draft.parentId ?? ''} onChange={(val) => setDraft({ ...draft, parentId: val || null })} options={[{value:'',label:'Parent: (root)'}, ...groups.filter((g:any)=>g.id!==draft.id).map((g:any)=>({value:g.id,label:`Parent: ${g.name}`}))]} />
                    </div>
                    <div className="editor-actions"><button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}><Save size={16} /></button><button className="icon-btn-sm danger" title={t.common.delete} onClick={deleteCurrent}><Trash2 size={16} /></button></div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}

        {section === 'scripts' ? (
          <>
            <div className="connections-header"><div className="connections-title">{(t.connections as any).scripts ?? 'Scripts'}</div><div className="connections-actions"><button className="icon-btn-sm" title={t.common.add} onClick={startNewEntry}><Plus size={16} strokeWidth={2} /></button></div></div>
            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header"><div className="connections-row-main header-main"><div>{t.common.name}</div><div>Command</div></div><div className="row-icon header-icon" /></div>
                {scripts.map((c) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button className="connections-row-main" onClick={() => startEdit(c)} title={t.common.edit}><div>{c.name}</div><div>{(c.command||'').split('\n')[0].slice(0,40)}</div></button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}><Pencil size={14} strokeWidth={2} /></button>
                  </div>
                ))}
                {!scripts.length ? <div className="connections-empty">No scripts yet. Run a script's command on open tabs via run_fleet_command.</div> : null}
              </div>
              <div className="connections-editor">
                {!draft ? <div className="editor-empty">{t.common.selectOrCreate}</div> : (
                  <div className="editor-card">
                    <div className="editor-row"><span className="editor-icon"><Waypoints size={16} strokeWidth={2} /></span><input className="editor-input" placeholder={t.common.name} value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
                    <div className="editor-row" style={{ height: 'auto', alignItems: 'flex-start', padding: '8px 0' }}><span className="editor-icon" style={{ marginTop: 6 }}><Waypoints size={16} strokeWidth={2} /></span><textarea className="editor-input" style={{ minHeight: 72, resize: 'vertical' }} placeholder="Command(s)" value={draft.command ?? ''} onChange={(e) => setDraft({ ...draft, command: e.target.value })} /></div>
                    <div className="editor-row"><span className="editor-icon"><Pencil size={16} strokeWidth={2} /></span><input className="editor-input" placeholder="Description" value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
                    <div className="editor-actions"><button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}><Save size={16} /></button><button className="icon-btn-sm danger" title={t.common.delete} onClick={deleteCurrent}><Trash2 size={16} /></button></div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}

        {section === 'scheduledTasks' ? (
          <>
            <div className="connections-header"><div className="connections-title">{(t.connections as any).scheduledTasks ?? 'Scheduled Tasks'}</div><div className="connections-actions"><button className="icon-btn-sm" title={t.common.add} onClick={startNewEntry}><Plus size={16} strokeWidth={2} /></button></div></div>
            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header"><div className="connections-row-main header-main"><div>{t.common.name}</div><div>Cron</div><div>On</div></div><div className="row-icon header-icon" /></div>
                {scheduledTasks.map((c) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button className="connections-row-main" onClick={() => startEdit(c)} title={t.common.edit}><div>{c.name}</div><div>{c.cron}</div><div>{c.enabled ? '✓' : '✗'}</div></button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}><Pencil size={14} strokeWidth={2} /></button>
                  </div>
                ))}
                {!scheduledTasks.length ? <div className="connections-empty">No scheduled tasks yet. Use cron syntax (e.g. 0 2 * * *).</div> : null}
              </div>
              <div className="connections-editor">
                {!draft ? <div className="editor-empty">{t.common.selectOrCreate}</div> : (
                  <div className="editor-card">
                    <div className="editor-row"><span className="editor-icon"><Shield size={16} strokeWidth={2} /></span><input className="editor-input" placeholder={t.common.name} value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
                    <div className="editor-row"><span className="editor-icon"><Shield size={16} strokeWidth={2} /></span><input className="editor-input" placeholder="Cron (e.g. 0 2 * * *)" value={draft.cron ?? ''} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} /></div>
                    <div className="editor-row" style={{ height: 'auto', alignItems: 'flex-start', padding: '8px 0' }}><span className="editor-icon" style={{ marginTop: 6 }}><Waypoints size={16} strokeWidth={2} /></span><textarea className="editor-input" style={{ minHeight: 60, resize: 'vertical' }} placeholder="Command (or a saved script id via the agent)" value={draft.command ?? ''} onChange={(e) => setDraft({ ...draft, command: e.target.value })} /></div>
                    <div className="editor-row"><span className="editor-icon"><Shield size={16} strokeWidth={2} /></span>
                      <Select className="editor-select" value={draft.enabled ? 'on' : 'off'} onChange={(val) => setDraft({ ...draft, enabled: val === 'on' })} options={[{value:'on',label:'Enabled'},{value:'off',label:'Disabled'}]} />
                    </div>
                    <div className="editor-actions"><button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}><Save size={16} /></button><button className="icon-btn-sm danger" title={t.common.delete} onClick={deleteCurrent}><Trash2 size={16} /></button></div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}

        {section === 'templates' ? (
          <>
            <div className="connections-header"><div className="connections-title">{(t.connections as any).templates ?? 'Templates'}</div><div className="connections-actions"><button className="icon-btn-sm" title={t.common.add} onClick={startNewEntry}><Plus size={16} strokeWidth={2} /></button></div></div>
            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header"><div className="connections-row-main header-main"><div>{t.common.name}</div><div>Versions</div></div><div className="row-icon header-icon" /></div>
                {templates.map((c) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button className="connections-row-main" onClick={() => startEdit(c)} title={t.common.edit}><div>{c.name}</div><div>{c.versions?.length ?? 0}</div></button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}><Pencil size={14} strokeWidth={2} /></button>
                  </div>
                ))}
                {!templates.length ? <div className="connections-empty">No templates yet. Use Jinja-subset syntax ({`{{ var }}`}, {`{% for %}`}, {`{% if %}`}). Render/preview via the agent (manage_template).</div> : null}
              </div>
              <div className="connections-editor">
                {!draft ? <div className="editor-empty">{t.common.selectOrCreate}</div> : (
                  <div className="editor-card">
                    <div className="editor-row"><span className="editor-icon"><Server size={16} strokeWidth={2} /></span><input className="editor-input" placeholder={t.common.name} value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
                    <div className="editor-row" style={{ height: 'auto', alignItems: 'flex-start', padding: '8px 0' }}><span className="editor-icon" style={{ marginTop: 6 }}><Server size={16} strokeWidth={2} /></span><textarea className="editor-input" style={{ minHeight: 96, resize: 'vertical', fontFamily: 'monospace' }} placeholder="Template body (Jinja-subset)" value={draft.body ?? ''} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></div>
                    <div className="editor-actions"><button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}><Save size={16} /></button><button className="icon-btn-sm danger" title={t.common.delete} onClick={deleteCurrent}><Trash2 size={16} /></button></div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}

        {section === 'proxies' ? (
          <>
            <div className="connections-header">
              <div className="connections-title">{t.connections.proxy}</div>
              <div className="connections-actions">
                <button className="icon-btn-sm" title={t.common.add} onClick={startNewEntry}>
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
            </div>
            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header">
                  <div className="connections-row-main header-main">
                    <div>{t.common.name}</div>
                    <div>{t.common.host}</div>
                    <div>{t.common.port}</div>
                    <div>{t.connections.type}</div>
                  </div>
                  <div className="row-icon header-icon" aria-hidden="true" />
                </div>
                {proxies.map((c) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button className="connections-row-main" onClick={() => startEdit(c)} title={t.common.edit}>
                      <div>{c.name}</div>
                      <div>{c.host}</div>
                      <div>{c.port}</div>
                      <div>{c.type}</div>
                    </button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}>
                      <Pencil size={14} strokeWidth={2} />
                    </button>
                  </div>
                ))}
                {!proxies.length ? <div className="connections-empty">No Proxies defined.</div> : null}
              </div>
              <div className="connections-editor">
                {!draft ? (
                  <div className="editor-empty">{t.common.selectOrCreate}</div>
                ) : (
                  <div className="editor-card">
                    <div className="editor-row">
                      <span className="editor-icon"><Shield size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.name}
                        value={draft.name ?? ''}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <Select
                        className="editor-select"
                        value={draft.type ?? 'socks5'}
                        onChange={(val) => setDraft({ ...draft, type: val })}
                        options={[
                          { value: 'socks5', label: 'SOCKS5' },
                          { value: 'http', label: 'HTTP' }
                        ]}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.host}
                        value={draft.host ?? ''}
                        onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.port}
                        value={String(draft.port ?? 1080)}
                        onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Shield size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.connections.username}
                        value={draft.username ?? ''}
                        onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><LockKeyhole size={16} /></span>
                      <input
                        type="password"
                        className="editor-input"
                        placeholder={t.common.password}
                        autoComplete="new-password"
                        value={draft.password ?? ''}
                        onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                      />
                    </div>
                    <div className="editor-actions">
                      <button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}><Save size={16} /></button>
                      <button className="icon-btn-sm danger" title={t.common.delete} onClick={deleteCurrent}><Trash2 size={16} /></button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}

        {section === 'tunnels' ? (
          <>
            <div className="connections-header">
              <div className="connections-title">{t.connections.tunnels}</div>
              <div className="connections-actions">
                <button className="icon-btn-sm" title={t.common.add} onClick={startNewEntry}>
                  <Plus size={16} strokeWidth={2} />
                </button>
              </div>
            </div>
            <div className="connections-split">
              <div className="connections-table">
                <div className="connections-row header">
                  <div className="connections-row-main header-main is-tunnel">
                    <div>{t.common.name}</div>
                    <div>{t.connections.type}</div>
                    <div>{t.common.host}:{t.common.port}</div>
                    <div>{t.connections.targetHost}</div>
                  </div>
                  <div className="row-icon header-icon" aria-hidden="true" />
                </div>
                {tunnels.map((c: TunnelEntry) => (
                  <div key={c.id} className={editingId === c.id ? 'connections-row is-active' : 'connections-row'}>
                    <button className="connections-row-main is-tunnel" onClick={() => startEdit(c)} title={t.common.edit}>
                      <div>{c.name}</div>
                      <div>{c.type}</div>
                      <div>{c.host}:{c.port}</div>
                      <div>{c.type === PortForwardType.Dynamic ? 'SOCKS proxy' : `${c.targetAddress}:${c.targetPort}`}</div>
                    </button>
                    <button className="row-icon" title={t.common.edit} onClick={() => startEdit(c)}>
                      <Pencil size={14} strokeWidth={2} />
                    </button>
                  </div>
                ))}
                {!tunnels.length ? <div className="connections-empty">No Tunnels defined.</div> : null}
              </div>
              <div className="connections-editor">
                {!draft ? (
                  <div className="editor-empty">{t.common.selectOrCreate}</div>
                ) : (
                  <div className="editor-card">
                    <div className="editor-row">
                      <span className="editor-icon"><Waypoints size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.name}
                        value={draft.name ?? ''}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <Select
                        className="editor-select"
                        value={draft.type ?? PortForwardType.Local}
                        onChange={(val) => setDraft({ ...draft, type: val as PortForwardType })}
                        options={[
                          { value: PortForwardType.Local, label: 'Local' },
                          { value: PortForwardType.Remote, label: 'Remote' },
                          { value: PortForwardType.Dynamic, label: 'Dynamic' }
                        ]}
                      />
                    </div>

                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.host}
                        value={draft.host ?? '127.0.0.1'}
                        onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                      />
                    </div>
                    <div className="editor-row">
                      <span className="editor-icon"><Server size={16} /></span>
                      <input
                        className="editor-input"
                        placeholder={t.common.port}
                        value={String(draft.port ?? 8080)}
                        onChange={(e) => setDraft({ ...draft, port: parseInt(e.target.value) || 8080 })}
                      />
                    </div>

                    {draft.type !== PortForwardType.Dynamic && (
                      <>
                        <div className="editor-row">
                          <span className="editor-icon"><Server size={16} /></span>
                          <input
                            className="editor-input"
                            placeholder={t.connections.targetHost}
                            value={draft.targetAddress ?? '127.0.0.1'}
                            onChange={(e) => setDraft({ ...draft, targetAddress: e.target.value })}
                          />
                        </div>
                        <div className="editor-row">
                          <span className="editor-icon"><Server size={16} /></span>
                          <input
                            className="editor-input"
                            placeholder={t.connections.targetPort}
                            value={String(draft.targetPort ?? 80)}
                            onChange={(e) => setDraft({ ...draft, targetPort: parseInt(e.target.value) || 80 })}
                          />
                        </div>
                      </>
                    )}

                    {draft.type === PortForwardType.Dynamic && (
                      <div className="editor-row">
                        <span className="editor-icon"><Shield size={16} /></span>
                        <div className="editor-input" style={{ backgroundColor: 'var(--bg-secondary)', padding: '8px' }}>
                          SOCKS proxy
                        </div>
                      </div>
                    )}

                    <div className="editor-actions">
                      <button className="icon-btn-sm" title={t.common.save} onClick={saveDraft}><Save size={16} /></button>
                      <button className="icon-btn-sm danger" title={t.common.delete} onClick={deleteCurrent}><Trash2 size={16} /></button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
})

