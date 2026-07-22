/**
 * iam-connector plugin — IAM integration for RTerm.
 *
 * User/group management, role assignment, access review, and audit trail for
 * Active Directory, local users, and service accounts. Covers user lifecycle
 * (create, disable, offboard), group membership, and access compliance.
 * Commands are built for both Linux (id, groups, usermod) and Windows
 * (Get-LocalUser, Get-LocalGroupMember, Disable-LocalUser).
 */

// --- Pure: build user info command ---
export function buildUserInfoCommand(username, os = 'linux') {
  const o = String(os).toLowerCase()
  if (o === 'windows' || o === 'win32') {
    return `powershell -Command "Get-LocalUser -Name '${username}' | Select-Object Name,Enabled,LastLogon,PasswordExpires,LockedOut,Description | Format-List"`
  }
  return `id '${username}' 2>/dev/null && groups '${username}' 2>/dev/null && passwd -S '${username}' 2>/dev/null`
}

// --- Pure: build user groups command ---
export function buildUserGroupsCommand(username, os = 'linux') {
  const o = String(os).toLowerCase()
  if (o === 'windows' || o === 'win32') {
    return `powershell -Command "Get-LocalGroupMember -Group Administrators | Where-Object {$_.Name -like '*${username}*'} | Select-Object Name; Get-LocalUser -Name '${username}' | Select-Object Name,Enabled"`
  }
  return `groups '${username}' 2>/dev/null && id -Gn '${username}' 2>/dev/null`
}

// --- Pure: build disable user command ---
export function buildDisableUserCommand(username, os = 'linux') {
  const o = String(os).toLowerCase()
  if (o === 'windows' || o === 'win32') {
    return `powershell -Command "Disable-LocalUser -Name '${username}'; Get-LocalUser -Name '${username}' | Select-Object Name,Enabled"`
  }
  return `usermod -L '${username}' 2>/dev/null && echo "user ${username} disabled" || echo "failed to disable ${username}"`
}

// --- Pure: build access review command (list all users + groups) ---
export function buildAccessReviewCommand(os = 'linux') {
  const o = String(os).toLowerCase()
  if (o === 'windows' || o === 'win32') {
    return 'powershell -Command "Get-LocalUser | Select-Object Name,Enabled,LastLogon | Format-Table -AutoSize; Write-Host \'---\'; Get-LocalGroup | Select-Object Name | Format-Table -AutoSize"'
  }
  return 'cut -d: -f1 /etc/passwd | while read u; do echo "$u: $(id -Gn $u 2>/dev/null)"; done 2>/dev/null | head -50'
}

// --- Pure: parse user info output ---
export function parseUserInfo(output, os = 'linux') {
  const o = String(os).toLowerCase()
  const info = { username: '', groups: [], enabled: true, locked: false }

  if (o === 'windows' || o === 'win32') {
    const nameMatch = output.match(/Name\s+:\s+(\S+)/)
    const enabledMatch = output.match(/Enabled\s+:\s+(True|False)/i)
    const lockedMatch = output.match(/LockedOut\s+:\s+(True|False)/i)
    if (nameMatch) info.username = nameMatch[1]
    if (enabledMatch) info.enabled = enabledMatch[1].toLowerCase() === 'true'
    if (lockedMatch) info.locked = lockedMatch[1].toLowerCase() === 'true'
    return info
  }

  // Linux: parse id + groups + passwd -S output
  const lines = output.split(/\r?\n/)
  for (const line of lines) {
    const l = line.trim()
    const idMatch = l.match(/uid=\d+\((\S+)\)/)
    if (idMatch) info.username = idMatch[1]
    const groupsMatch = l.match(/groups=(.+)/)
    if (groupsMatch) {
      // groups=1000(john),27(sudo) — split by comma, then extract names from NNN(name) format
      info.groups = groupsMatch[1]
        .split(',')
        .map((g) => g.replace(/\d+\(([^)]+)\)/, '$1').trim())
        .filter(Boolean)
    }
    if (l.includes(' L ')) info.locked = true
  }
  return info
}

// --- Pure: parse access review output into a user list ---
export function parseAccessReview(output, os = 'linux') {
  const o = String(os).toLowerCase()
  const users = []

  if (o === 'windows' || o === 'win32') {
    const lines = output.split(/\r?\n/)
    for (const line of lines) {
      const l = line.trim()
      const match = l.match(/^(\S+)\s+(True|False)\s+/)
      if (match) {
        users.push({ username: match[1], enabled: match[2].toLowerCase() === 'true' })
      }
    }
    return users
  }

  // Linux: parse "user: group1 group2" lines
  const lines = output.split(/\r?\n/)
  for (const line of lines) {
    const l = line.trim()
    const match = l.match(/^(\S+):\s*(.*)/)
    if (match) {
      users.push({ username: match[1], groups: match[2].split(/\s+/).filter(Boolean) })
    }
  }
  return users
}

// --- Pure: check if a user has privileged access ---
export function isPrivileged(userInfo, privilegedGroups = ['sudo', 'wheel', 'admin', 'root', 'Administrators']) {
  return userInfo.groups.some((g) => privilegedGroups.some((pg) => g.toLowerCase().includes(pg.toLowerCase())))
}

// --- Plugin entry ---
export function register(ctx) {
  const { registerTool, registerTrigger, registerPanel, exec, readLedger, log } = ctx

  // Tool: iam_user_info — get user info
  registerTool({
    name: 'iam_user_info',
    description: 'Get user information (username, groups, enabled status, locked status) for a user on a host.',
    params: {
      username: { type: 'string', description: 'Username to query' },
      host: { type: 'string', description: 'Host to query' },
      os: { type: 'string', description: 'OS type: linux, windows' },
    },
    handler: async (params) => {
      const { username, host, os = 'linux' } = params ?? {}
      if (!username || !host) return { error: 'username and host are required' }
      const cmd = buildUserInfoCommand(username, os)
      log(`[iam-connector] querying user ${username} on ${host}`)
      const output = await exec(cmd, { host })
      const info = parseUserInfo(output, os)
      return { username, host, os, ...info, privileged: isPrivileged(info) }
    },
  })

  // Tool: iam_user_groups — get user group memberships
  registerTool({
    name: 'iam_user_groups',
    description: 'Get group memberships for a user on a host.',
    params: {
      username: { type: 'string', description: 'Username to query' },
      host: { type: 'string', description: 'Host to query' },
      os: { type: 'string', description: 'OS type' },
    },
    handler: async (params) => {
      const { username, host, os = 'linux' } = params ?? {}
      if (!username || !host) return { error: 'username and host are required' }
      const cmd = buildUserGroupsCommand(username, os)
      const output = await exec(cmd, { host })
      const info = parseUserInfo(output, os)
      return { username, host, groups: info.groups, privileged: isPrivileged(info) }
    },
  })

  // Tool: iam_disable_user — disable a user account (requires approval)
  registerTool({
    name: 'iam_disable_user',
    description: 'Disable a user account on a host. This is a destructive operation — requires approval. Returns the result.',
    params: {
      username: { type: 'string', description: 'Username to disable' },
      host: { type: 'string', description: 'Host to disable on' },
      os: { type: 'string', description: 'OS type' },
    },
    handler: async (params) => {
      const { username, host, os = 'linux' } = params ?? {}
      if (!username || !host) return { error: 'username and host are required' }
      const cmd = buildDisableUserCommand(username, os)
      log(`[iam-connector] disabling user ${username} on ${host}`)
      const output = await exec(cmd, { host })
      const info = parseUserInfo(output, os)
      return { username, host, disabled: !info.enabled, output: output.slice(0, 500) }
    },
  })

  // Tool: iam_access_review — review all user access on a host
  registerTool({
    name: 'iam_access_review',
    description: 'Review all user accounts and group memberships on a host. Identifies privileged users.',
    params: {
      host: { type: 'string', description: 'Host to review' },
      os: { type: 'string', description: 'OS type' },
    },
    handler: async (params) => {
      const { host, os = 'linux' } = params ?? {}
      if (!host) return { error: 'host is required' }
      const cmd = buildAccessReviewCommand(os)
      const output = await exec(cmd, { host })
      const users = parseAccessReview(output, os)
      const privilegedUsers = users.filter((u) => isPrivileged({ groups: u.groups ?? [] }))
      return { host, totalUsers: users.length, privilegedUsers: privilegedUsers.length, users: users.slice(0, 50), privilegedUsers: privilegedUsers.map((u) => u.username) }
    },
  })

  // Trigger: iam_privileged_change — fires when a privileged user's access changes
  registerTrigger({
    name: 'iam_privileged_change',
    description: 'Fires when a privileged user account is modified (disabled, group change). Use for compliance monitoring.',
    match: (event) => {
      if (event?.source !== 'iam-connector') return false
      return event.labels?.privileged === true
    },
    action: 'propose-change',
  })

  // Panel: iam-access-dashboard — IAM access dashboard
  registerPanel({
    name: 'iam-access-dashboard',
    title: 'IAM Access Dashboard',
    render: (data) => {
      const users = Array.isArray(data) ? data : []
      const privileged = users.filter((u) => isPrivileged({ groups: u.groups ?? [] }))
      const rows = users.map((u) =>
        `<tr><td>${u.username}</td><td>${(u.groups ?? []).join(', ')}</td><td>${u.enabled !== false ? '✅' : '❌'}</td><td>${isPrivileged({ groups: u.groups ?? [] }) ? '🔐' : ''}</td></tr>`
      ).join('')
      return `<div class="iam-access-dashboard"><h3>IAM Access Dashboard</h3><p>Total users: ${users.length} | Privileged: ${privileged.length}</p><table><thead><tr><th>User</th><th>Groups</th><th>Enabled</th><th>Privileged</th></tr></thead><tbody>${rows}</tbody></table></div>`
    },
  })

  log('[iam-connector] registered: 4 tools, 1 trigger, 1 panel')
}

export default { register, buildUserInfoCommand, buildUserGroupsCommand, buildDisableUserCommand, buildAccessReviewCommand, parseUserInfo, parseAccessReview, isPrivileged }
