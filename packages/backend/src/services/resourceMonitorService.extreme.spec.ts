import { ResourceMonitorService } from './ResourceMonitorService'

const SECTION_MARKER = '__GYSHELL_MONITOR_SECTION__::'

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const buildSectionedOutput = (sections: Record<string, string>): string =>
  Object.entries(sections)
    .map(([key, value]) => `${SECTION_MARKER}${key}\n${value}`)
    .join('\n')

const resolveMonitorIdentity = (terminal: Record<string, unknown>): string | null => {
  const id = String(terminal.id || '').trim()
  const type = String(terminal.type || '').trim()
  if (!id) {
    return null
  }
  if (type === 'local') {
    return 'local://default'
  }
  if (type === 'ssh') {
    return `ssh://${id}`
  }
  return `terminal://${id}`
}

const createService = (
  terminal: Record<string, unknown>,
  output: string
): ResourceMonitorService =>
  new ResourceMonitorService({
    getTerminalById: (terminalId: string) =>
      terminalId === terminal.id ? terminal : undefined,
    getMonitorIdentity: () => resolveMonitorIdentity(terminal),
    execOnTerminal: async () => ({ stdout: output, stderr: '' }),
  } as any)

const run = async (): Promise<void> => {
  await runCase('linux ssh snapshot parses cpu memory processes and sockets', async () => {
    const terminal = {
      id: 'ssh-linux',
      type: 'ssh',
      title: 'linux-box',
      remoteOs: 'unix',
      systemInfo: {
        platform: 'linux',
        os: 'unknown',
        release: 'unknown',
        arch: 'unknown',
        hostname: 'unknown',
        isRemote: true,
        shell: '/bin/bash',
      },
    }
    const output = buildSectionedOutput({
      system: [
        'demo-linux',
        'Ubuntu 24.04.4 LTS',
        '6.8.0-100-generic',
        'x86_64',
        '/bin/bash',
      ].join('\n'),
      cpu: [
        'cpu  4705 0 4313 1362393 17 0 12 0 0 0',
        'cpu0 2300 0 2100 680000 9 0 6 0 0 0',
        'cpu1 2405 0 2213 682393 8 0 6 0 0 0',
      ].join('\n'),
      memory: [
        'MemTotal:        16384000 kB',
        'MemFree:          2048000 kB',
        'MemAvailable:     8192000 kB',
        'Buffers:           512000 kB',
        'Cached:           1024000 kB',
        'SReclaimable:      256000 kB',
        'SwapTotal:        2097152 kB',
        'SwapFree:         1048576 kB',
      ].join('\n'),
      disks: [
        'Filesystem     1024-blocks     Used Available Capacity Mounted on',
        '/dev/sda1        20971520 10485760  10485760      50% /',
      ].join('\n'),
      gpu: 'NVIDIA RTX 4090, 65, 4096, 24564, 38, 72',
      network: [
        'Inter-|   Receive                                                |  Transmit',
        ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
        '  lo: 1000 0 0 0 0 0 0 0 1000 0 0 0 0 0 0 0',
        'eth0: 1048576 0 0 0 0 0 0 0 524288 0 0 0 0 0 0 0',
      ].join('\n'),
      load: '0.42 0.37 0.31 1/256 1234',
      uptime: '3600.00 0.00',
      processes: [
        '9187 root Ss 12.4 11366 sshd /usr/sbin/sshd -D',
        '9131 root S 4.3 13107 frps ./frps -c /etc/frp/frps.toml',
      ].join('\n'),
      sockets: [
        'tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=9187,fd=3))',
        'tcp ESTAB 0 0 10.0.0.2:22 10.0.0.10:51822 users:(("sshd",pid=9187,fd=4))',
        'udp UNCONN 0 0 0.0.0.0:7000 0.0.0.0:* users:(("frps",pid=9131,fd=5))',
      ].join('\n'),
    })

    const service = createService(terminal, output)
    const snapshot = await service.collectSnapshot('ssh-linux')

    assertEqual(snapshot.system?.platform, 'linux', 'platform should be linux')
    assertEqual(snapshot.system?.hostname, 'demo-linux', 'linux hostname should merge from monitor output')
    assertEqual(snapshot.system?.osName, 'Ubuntu 24.04.4 LTS', 'linux os name should merge from monitor output')
    assertEqual(snapshot.cpu?.logicalCoreCount, 2, 'core count should match /proc/stat')
    assertEqual(snapshot.gpus?.[0]?.memoryUtilizationPercent, 38, 'linux gpu memory utilization should parse from nvidia-smi')
    assertEqual(snapshot.gpus?.[0]?.memoryUsagePercent, 16.7, 'linux vram usage percentage should be derived from nvidia-smi memory fields')
    assert(snapshot.memory?.cachedBytes !== undefined, 'linux cached memory should be populated')
    assertEqual(snapshot.processes?.length, 2, 'process list should parse')
    assertEqual(snapshot.networkConnections?.[0]?.localPort, 22, 'listener port should parse')
    assertEqual(snapshot.networkConnections?.[0]?.connectionCount, 1, 'listener should aggregate active connections')
  })

  await runCase('darwin ssh snapshot parses vm_stat and lsof output', async () => {
    const terminal = {
      id: 'ssh-darwin',
      type: 'ssh',
      title: 'mac-mini',
      remoteOs: 'unix',
      systemInfo: {
        platform: 'darwin',
        os: 'darwin',
        release: '24.4.0',
        arch: 'arm64',
        hostname: 'demo-mac',
        isRemote: true,
        shell: '/bin/zsh',
      },
    }
    const output = buildSectionedOutput({
      system: [
        'demo-mac',
        'macOS',
        '15.4',
        'arm64',
        '/bin/zsh',
      ].join('\n'),
      cpu: 'CPU usage: 19.8% user, 7.7% sys, 72.5% idle',
      vmStat: [
        'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
        'Pages free:                               4000.',
        'Pages active:                           280000.',
        'Pages inactive:                         270000.',
        'Pages speculative:                        1000.',
        'Pages wired down:                       290000.',
        'Pages occupied by compressor:            60000.',
      ].join('\n'),
      memorySysctl: ['25769803776', '14', '14', 'Apple M4 Pro'].join('\n'),
      swap: 'vm.swapusage: total = 2048.00M  used = 256.00M  free = 1792.00M  (encrypted)',
      disks: [
        'Filesystem     1024-blocks     Used Available Capacity Mounted on',
        '/dev/disk3s1s1  500000000 250000000 250000000      50% /',
        '/dev/disk3s5    500000000 320000000 180000000      64% /System/Volumes/Data',
        '/dev/disk3s6    500000000  10000000 490000000       2% /System/Volumes/VM',
        '/dev/disk4s1    200000000  50000000 150000000      25% /Volumes/Backup',
      ].join('\n'),
      diskList: JSON.stringify({
        AllDisksAndPartitions: [
          {
            DeviceIdentifier: 'disk3',
            Content: 'Apple_APFS_Container',
            OSInternal: false,
            APFSVolumes: [
              {
                DeviceIdentifier: 'disk3s1s1',
                MountPoint: '/',
                VolumeName: 'Macintosh HD',
                OSInternal: false,
              },
              {
                DeviceIdentifier: 'disk3s5',
                MountPoint: '/System/Volumes/Data',
                VolumeName: 'Macintosh HD - Data',
                OSInternal: false,
              },
              {
                DeviceIdentifier: 'disk3s6',
                MountPoint: '/System/Volumes/VM',
                VolumeName: 'VM',
                OSInternal: false,
              },
            ],
          },
          {
            DeviceIdentifier: 'disk4',
            Content: 'GUID_partition_scheme',
            OSInternal: false,
            Partitions: [
              {
                DeviceIdentifier: 'disk4s1',
                MountPoint: '/Volumes/Backup',
                VolumeName: 'Backup',
                Content: 'Apple_APFS',
                OSInternal: false,
              },
            ],
          },
        ],
      }),
      diskApfs: JSON.stringify({
        Containers: [
          {
            ContainerReference: 'disk3',
            Volumes: [
              {
                DeviceIdentifier: 'disk3s1',
                Name: 'Macintosh HD',
                Roles: ['System'],
              },
              {
                DeviceIdentifier: 'disk3s5',
                Name: 'Macintosh HD - Data',
                Roles: ['Data'],
              },
              {
                DeviceIdentifier: 'disk3s6',
                Name: 'VM',
                Roles: ['VM'],
              },
            ],
          },
        ],
      }),
      gpu: '',
      network: [
        'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
        'lo0        16384 <Link#1>                        299563     0  428425362   299563     0  428425362     0',
        'en0        1500  <Link#7>    ce:4b:7b:cb:52:ba   10000     0   20971520    8000     0    1048576     0',
      ].join('\n'),
      load: '{ 2.50 2.10 1.95 }',
      uptime: '{ sec = 1772088570, usec = 326253 } Thu Feb 26 01:49:30 2026',
      processes: [
        '668 tonyhuang S 18.1 224624 微信 /Applications/微信.app/Contents/MacOS/微信',
        '10910 tonyhuang R 11.4 376928 Codex /Applications/Codex.app/Contents/MacOS/Codex',
      ].join('\n'),
      sockets: [
        'p668',
        'cWeChat',
        'Ltonyhuang',
        'f24',
        'PUDP',
        'n*:*',
        'f218',
        'PTCP',
        'n127.0.0.1:14013',
        'TST=LISTEN',
        'p10910',
        'cCodex',
        'Ltonyhuang',
        'f90',
        'PTCP',
        'n10.0.0.2:51111->1.1.1.1:443',
        'TST=ESTABLISHED',
      ].join('\n'),
    })

    const service = createService(terminal, output)
    const snapshot = await service.collectSnapshot('ssh-darwin')

    assertEqual(snapshot.system?.platform, 'darwin', 'platform should be darwin')
    assertEqual(snapshot.system?.hostname, 'demo-mac', 'mac hostname should merge from monitor output')
    assert(snapshot.memory?.wiredBytes !== undefined, 'mac wired memory should be populated')
    assertEqual(snapshot.cpu?.modelName, 'Apple M4 Pro', 'mac cpu model should parse')
    assertEqual(snapshot.network?.[0]?.interface, 'en0', 'mac interface should parse from netstat')
    assertEqual(snapshot.disks?.[0]?.mountPoint, '/System/Volumes/Data', 'mac data volume should become the primary disk entry')
    assert(
      !snapshot.disks?.some((entry) => entry.mountPoint === '/' || entry.mountPoint === '/System/Volumes/VM'),
      'mac system snapshot and VM volumes should be filtered from disk summary'
    )
    assert(
      snapshot.disks?.some((entry) => entry.mountPoint === '/Volumes/Backup'),
      'mac external mounted volumes should remain visible'
    )
    assert(
      snapshot.processes?.some(
        (entry) => entry.path === '/Applications/微信.app/Contents/MacOS/微信'
      ),
      'utf-8 process paths should be preserved'
    )
    assert(snapshot.networkConnections?.some((entry) => entry.localPort === 14013), 'mac listener should parse from lsof')
  })

  await runCase('unix sectioned commands force utf-8 locale for monitor collection', async () => {
    const service = createService(
      {
        id: 'local-mac',
        type: 'local',
        title: 'local',
      },
      ''
    )

    const linuxCommand = (service as any).buildLinuxMonitorCommand() as string
    const darwinCommand = (service as any).buildDarwinMonitorCommand() as string

    assert(
      linuxCommand.includes("LC_ALL='en_US.UTF-8'; LANG='en_US.UTF-8'; export LC_ALL LANG"),
      'linux command should export utf-8 locale before sampling'
    )
    assert(
      darwinCommand.includes("LC_ALL='en_US.UTF-8'; LANG='en_US.UTF-8'; export LC_ALL LANG"),
      'darwin command should export utf-8 locale before sampling'
    )
    assert(
      darwinCommand.includes('diskutil list -plist | plutil -convert json -o - -'),
      'darwin command should collect structured disk metadata'
    )
    assert(
      darwinCommand.includes('diskutil apfs list -plist | plutil -convert json -o - -'),
      'darwin command should collect structured APFS role metadata'
    )
  })

  await runCase('windows ssh snapshot parses powershell json and aggregates sockets', async () => {
    const terminal = {
      id: 'ssh-win',
      type: 'ssh',
      title: 'win-host',
      remoteOs: 'windows',
      systemInfo: {
        platform: 'unix',
        os: 'unix',
        release: 'unknown',
        arch: 'unknown',
        hostname: 'unknown',
        isRemote: true,
        shell: '/bin/sh',
      },
    }
    const output = JSON.stringify({
      system: {
        hostname: 'demo-win',
        osName: 'Microsoft Windows 11 Pro',
        release: '10.0.26100',
        arch: '64-bit',
        shell: 'powershell.exe',
      },
      cpu: {
        usagePercent: 27.5,
        corePercents: [31, 24, 29, 26],
        logicalCoreCount: 4,
      },
      memory: {
        totalBytes: 17179869184,
        usedBytes: 8589934592,
        availableBytes: 8589934592,
        freeBytes: 8589934592,
        usagePercent: 50,
        swap: {
          totalBytes: 4294967296,
          usedBytes: 1073741824,
        },
      },
      disks: [
        {
          filesystem: 'NTFS · 系统盘',
          mountPoint: 'C:\\',
          totalBytes: 107374182400,
          usedBytes: 53687091200,
          availableBytes: 53687091200,
          usagePercent: 50,
        },
        {
          filesystem: 'NTFS · 数据盘',
          mountPoint: '\\\\?\\Volume{1234-5678}\\',
          totalBytes: 214748364800,
          usedBytes: 85899345920,
          availableBytes: 128849018880,
          usagePercent: 40,
        },
        {
          filesystem: 'NTFS · �� ?????',
          mountPoint: 'F:\\',
          totalBytes: 214748364800,
          usedBytes: 193273528320,
          availableBytes: 21474836480,
          usagePercent: 90,
        },
      ],
      network: [
        {
          interface: 'Ethernet0',
          rxBytesPerSec: 2048,
          txBytesPerSec: 1024,
        },
      ],
      processes: [
        {
          pid: 4321,
          name: 'sshd.exe',
          cpuPercent: 7.1,
          memoryBytes: 33554432,
          command: 'C:\\Windows\\System32\\OpenSSH\\sshd.exe',
          path: 'C:\\Windows\\System32\\OpenSSH\\sshd.exe',
        },
      ],
      sockets: [
        {
          protocol: 'tcp',
          state: 'Listen',
          localAddress: '0.0.0.0',
          localPort: 22,
          remoteAddress: '0.0.0.0',
          remotePort: 0,
          pid: 4321,
          processName: 'sshd',
        },
        {
          protocol: 'tcp',
          state: 'Established',
          localAddress: '10.0.0.20',
          localPort: 22,
          remoteAddress: '10.0.0.30',
          remotePort: 51422,
          pid: 4321,
          processName: 'sshd',
        },
      ],
      g: [
        {
          n: 'NVIDIA RTX 4090',
          u: 51.2,
          m: 4096,
          t: 16384,
          p: 25,
          mu: 34.5,
          tc: 61,
          s: 512,
        },
      ],
      uptimeSeconds: 7200,
    })

    const service = createService(terminal, output)
    const snapshot = await service.collectSnapshot('ssh-win')

    assertEqual(snapshot.system?.platform, 'windows', 'platform should be windows')
    assertEqual(snapshot.system?.osName, 'Microsoft Windows 11 Pro', 'windows system info should override stale terminal info')
    assertEqual(snapshot.system?.shell, 'powershell.exe', 'windows shell should merge from monitor output')
    assertEqual(snapshot.cpu?.logicalCoreCount, 4, 'windows logical cores should parse')
    assertEqual(snapshot.network?.[0]?.interface, 'Ethernet0', 'windows network interface should parse')
    assertEqual(snapshot.disks?.length, 3, 'windows should preserve multiple fixed volumes')
    assert(
      snapshot.disks?.some((entry) => entry.mountPoint === 'C:\\' && entry.filesystem === 'NTFS · 系统盘'),
      'windows utf-8 disk labels should survive parsing'
    )
    assert(
      snapshot.disks?.some((entry) => entry.mountPoint === '\\\\?\\Volume{1234-5678}\\'),
      'windows should preserve mounted volumes without drive letters'
    )
    assert(
      snapshot.disks?.some((entry) => entry.mountPoint === 'F:\\' && entry.filesystem === 'NTFS'),
      'windows corrupted labels should collapse back to the filesystem name instead of mojibake'
    )
    assertEqual(snapshot.gpus?.[0]?.name, 'NVIDIA RTX 4090', 'windows gpu name should parse from compact gpu payloads')
    assertEqual(snapshot.gpus?.[0]?.memoryUsagePercent, 25, 'windows gpu vram usage percentage should parse')
    assertEqual(snapshot.gpus?.[0]?.memoryUtilizationPercent, 34.5, 'windows gpu memory utilization should parse')
    assertEqual(snapshot.gpus?.[0]?.sharedMemoryUsedMiB, 512, 'windows shared gpu memory should parse')
    assertEqual(snapshot.networkConnections?.[0]?.localPort, 22, 'windows socket should aggregate by local port')
    assertEqual(snapshot.networkConnections?.[0]?.remoteHostCount, 1, 'windows listener should track unique remote hosts')
    assertEqual(snapshot.networkConnections?.[0]?.connectionCount, 1, 'windows listener should track connection count')
  })

  await runCase('windows monitor launcher keeps the payload plain and unobfuscated', async () => {
    const service = createService(
      {
        id: 'local-win',
        type: 'local',
        title: 'win',
      },
      ''
    )

    const windowsCommand = (service as any).buildWindowsMonitorCommand() as string
    const windowsScript = (service as any).buildWindowsMonitorScript() as string
    assertEqual(
      windowsCommand,
      'powershell.exe -NoLogo -NoProfile -NonInteractive -Command -',
      'windows monitor should launch PowerShell in stdin script mode'
    )
    assert(
      !windowsCommand.includes('EncodedCommand') &&
        !windowsCommand.includes('FromBase64String') &&
        !windowsCommand.includes('iex '),
      'windows monitor launcher should not use encoded or self-decompressing bootstrap patterns'
    )
    assert(
      windowsScript.includes('Win32_Volume'),
      'windows monitor script should enumerate Win32_Volume for multi-volume coverage'
    )
    assert(
      !windowsScript.includes('Win32_LogicalDisk'),
      'windows command should no longer rely on Win32_LogicalDisk only'
    )
    assert(
      windowsScript.includes('Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine') &&
        windowsScript.includes('Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory'),
      'windows command should query WMI GPU performance counter classes for generic GPU telemetry'
    )
    assert(
      windowsScript.includes(
        'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,utilization.memory,temperature.gpu'
      ),
      'windows command should use nvidia-smi when available for NVIDIA GPU telemetry'
    )
    assert(
      windowsScript.includes('UTF8Encoding') &&
        windowsScript.includes('OpenStandardOutput().Write($bytes,0,$bytes.Length)'),
      'windows command should write utf-8 json bytes explicitly'
    )
  })

  await runCase('remote windows monitoring sends the raw powershell script through stdin', async () => {
    const terminal = {
      id: 'ssh-win',
      type: 'ssh',
      title: 'win',
      runtimeState: 'ready',
      remoteOs: 'windows',
      capabilities: {
        supportsMonitor: true,
      },
    }
    let capturedCommand = ''
    let capturedOptions: { stdin?: string } | undefined
    const output = JSON.stringify({
      s: {
        h: 'remote-win',
        o: 'Windows',
        r: '10.0',
        a: 'x64',
        sh: 'powershell.exe',
      },
      c: {
        u: 10,
        c: [5, 15],
        l: 2,
      },
      m: {
        t: 100,
        u: 40,
        a: 60,
        f: 60,
        p: 40,
      },
      d: [],
      g: [],
      n: [],
      p: [],
      k: [],
      u: 60,
    })
    const service = new ResourceMonitorService({
      getTerminalById: (terminalId: string) =>
        terminalId === terminal.id ? terminal : undefined,
      getMonitorIdentity: () => 'ssh://shared-host:22',
      execOnTerminal: async (
        _terminalId: string,
        command: string,
        _timeoutMs: number,
        options?: { stdin?: string }
      ) => {
        capturedCommand = command
        capturedOptions = options
        return { stdout: output, stderr: '' }
      },
    } as any)

    await (service as any).collectWindowsSnapshot('ssh-win')
    const stdinPayload = capturedOptions?.stdin || ''

    assertEqual(
      capturedCommand,
      'powershell.exe -NoLogo -NoProfile -NonInteractive -Command -',
      'remote windows snapshots should launch PowerShell in stdin script mode'
    )
    assert(
      stdinPayload.includes('Win32_OperatingSystem') &&
        stdinPayload.includes('ConvertTo-Json -Depth 6 -Compress'),
      'remote windows snapshots should send the full monitor script via stdin'
    )
    assert(
      !stdinPayload.includes('FromBase64String') &&
        !stdinPayload.includes('iex '),
      'remote windows snapshots should avoid encoded bootstrap payloads'
    )
  })

  await runCase('windows snapshot parsing falls back to the final json line when stdout contains prompt noise', async () => {
    const terminal = {
      id: 'ssh-win-noisy',
      type: 'ssh',
      title: 'win',
      runtimeState: 'ready',
      remoteOs: 'windows',
      capabilities: {
        supportsMonitor: true,
      },
    }
    const noisyOutput = [
      'PS C:\\Users\\Admin>',
      '{"s":{"h":"remote-win","o":"Windows","r":"10.0","a":"x64","sh":"powershell.exe"},"c":{"u":10,"c":[5,15],"l":2},"m":{"t":100,"u":40,"a":60,"f":60,"p":40},"d":[],"g":[],"n":[],"p":[],"k":[],"u":60}',
    ].join('\r\n')
    const service = new ResourceMonitorService({
      getTerminalById: (terminalId: string) =>
        terminalId === terminal.id ? terminal : undefined,
      getMonitorIdentity: () => 'ssh://shared-host:22',
      execOnTerminal: async () => ({ stdout: noisyOutput, stderr: '' }),
    } as any)

    const snapshot = await (service as any).collectWindowsSnapshot('ssh-win-noisy')

    assertEqual(
      snapshot.system?.hostname,
      'remote-win',
      'windows parser should recover the final json line after prompt noise'
    )
    assertEqual(
      snapshot.cpu?.logicalCoreCount,
      2,
      'windows parser should still decode cpu data after recovering the json payload'
    )
  })

  await runCase('local windows monitoring executes the raw powershell script without nesting powershell -Command', async () => {
    const terminal = {
      id: 'local-win',
      type: 'local',
      title: 'win',
      runtimeState: 'ready',
      capabilities: {
        supportsMonitor: true,
      },
      systemInfo: {
        platform: 'win32',
        os: 'Windows',
        release: '10.0',
        arch: 'x64',
        hostname: 'local-win',
        isRemote: false,
        shell: 'powershell.exe',
      },
    }
    const execCalls: string[] = []
    const output = JSON.stringify({
      s: {
        h: 'local-win',
        o: 'Windows',
        r: '10.0',
        a: 'x64',
        sh: 'powershell.exe',
      },
      c: {
        u: 10,
        c: [5, 15],
        l: 2,
      },
      m: {
        t: 100,
        u: 40,
        a: 60,
        f: 60,
        p: 40,
      },
      d: [],
      n: [],
      p: [],
      k: [],
      u: 60,
    })
    const service = new ResourceMonitorService({
      getTerminalById: (terminalId: string) =>
        terminalId === terminal.id ? terminal : undefined,
      getMonitorIdentity: () => 'local://default',
      execOnTerminal: async (_terminalId: string, command: string) => {
        execCalls.push(command)
        return { stdout: output, stderr: '' }
      },
    } as any)

    await (service as any).collectWindowsSnapshot('local-win')

    assertEqual(execCalls.length, 1, 'local windows snapshots should execute one monitor command')
    assert(
      !execCalls[0].startsWith('powershell -nop -noni -c "'),
      'local windows snapshots should pass a raw powershell script to the local backend'
    )
    assert(
      execCalls[0].includes('Win32_OperatingSystem') &&
        execCalls[0].includes('ConvertTo-Json -Depth 6 -Compress'),
      'local windows snapshots should still execute the full windows monitor script'
    )
  })

  await runCase('shared monitor sources collect once and fan snapshots out to every retained terminal id', async () => {
    const terminals = new Map(
      ['ssh-a', 'ssh-b'].map((id) => [
        id,
        {
          id,
          type: 'ssh',
          title: id,
          runtimeState: 'ready',
          remoteOs: 'unix',
          systemInfo: {
            platform: 'linux',
            os: 'linux',
            release: '6.8.0',
            arch: 'x86_64',
            hostname: 'shared-box',
            isRemote: true,
            shell: '/bin/bash',
          },
        },
      ])
    )
    const output = buildSectionedOutput({
      system: ['shared-box', 'Ubuntu', '6.8.0', 'x86_64', '/bin/bash'].join('\n'),
      cpu: [
        'cpu  4705 0 4313 1362393 17 0 12 0 0 0',
        'cpu0 2300 0 2100 680000 9 0 6 0 0 0',
        'cpu1 2405 0 2213 682393 8 0 6 0 0 0',
      ].join('\n'),
      memory: [
        'MemTotal:        16384000 kB',
        'MemFree:          2048000 kB',
        'MemAvailable:     8192000 kB',
      ].join('\n'),
      disks: [
        'Filesystem     1024-blocks     Used Available Capacity Mounted on',
        '/dev/sda1        20971520 10485760  10485760      50% /',
      ].join('\n'),
      gpu: '',
      network: [
        'Inter-|   Receive                                                |  Transmit',
        ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
        'eth0: 1048576 0 0 0 0 0 0 0 524288 0 0 0 0 0 0 0',
      ].join('\n'),
      load: '0.42 0.37 0.31 1/256 1234',
      uptime: '3600.00 0.00',
      processes: '',
      sockets: '',
    })
    const execCalls: string[] = []
    const published: Array<{ terminalId: string; cpu?: { usagePercent: number } }> = []
    const service = new ResourceMonitorService({
      getTerminalById: (terminalId: string) => terminals.get(terminalId),
      getMonitorIdentity: (terminalId: string) =>
        terminalId === 'ssh-a' || terminalId === 'ssh-b'
          ? 'ssh://shared-host:22'
          : null,
      execOnTerminal: async (terminalId: string) => {
        execCalls.push(terminalId)
        return { stdout: output, stderr: '' }
      },
    } as any)
    service.setPublisher((_channel, snapshot) => {
      published.push(snapshot as any)
    })

    ;(service as any).collectAndPublish = async () => {}

    service.start('ssh-a', 'window:1')
    service.start('ssh-b', 'window:1')

    await (ResourceMonitorService.prototype as any).collectAndPublish.call(
      service,
      'ssh://shared-host:22'
    )

    assertEqual(execCalls.length, 1, 'shared source should execute only one monitor command')
    assertEqual(
      JSON.stringify(published.map((entry) => entry.terminalId).sort()),
      JSON.stringify(['ssh-a', 'ssh-b']),
      'one collected snapshot should fan out to every retained terminal id'
    )

    const exitedSource = terminals.get('ssh-a')
    assert(exitedSource, 'shared source test should keep the original source terminal')
    ;(exitedSource as any).runtimeState = 'exited'

    await service.collectSnapshot('ssh-b')

    const session = (service as any).sessions.get('ssh://shared-host:22')
    assert(session, 'shared session should remain while another terminal retains the same source')
    assertEqual(
      session.sourceTerminalId,
      'ssh-b',
      'source execution should move to another retained terminal when the current source exits'
    )
    assertEqual(
      execCalls[1],
      'ssh-b',
      'shared source collection should fail over to a ready retained terminal instead of reusing an exited one'
    )

    service.stop('ssh-a', 'window:1')
    assertEqual(service.isMonitoring('ssh-a'), false, 'released terminal should no longer report monitoring')
    assertEqual(service.isMonitoring('ssh-b'), true, 'remaining shared terminal should keep the source active')

    service.stop('ssh-b', 'window:1')
    assertEqual(
      (service as any).sessions.has('ssh://shared-host:22'),
      false,
      'shared source should stop after the last retained terminal releases it'
    )
  })

  await runCase('monitor sessions are idempotent per owner and release only after the last owner stops', async () => {
    const service = createService(
      {
        id: 'local-linux',
        type: 'local',
        title: 'linux',
      },
      ''
    )

    ;(service as any).collectAndPublish = async () => {}

    service.start('local-linux', 'win-main')
    service.start('local-linux', 'win-main')
    let session = (service as any).sessions.get('local://default')
    assert(session, 'session should be created on first start')
    assertEqual(
      session.ownerIdsByTerminalId.get('local-linux')?.size,
      1,
      'duplicate starts from the same owner should not leak owners'
    )

    service.start('local-linux', 'win-detached')
    session = (service as any).sessions.get('local://default')
    assertEqual(
      session.ownerIdsByTerminalId.get('local-linux')?.size,
      2,
      'distinct owners should both retain the session'
    )

    service.stop('local-linux', 'win-main')
    assertEqual(service.isMonitoring('local-linux'), true, 'session should remain while another owner is active')

    service.stop('local-linux', 'win-detached')
    assertEqual(service.isMonitoring('local-linux'), false, 'session should stop after the last owner releases it')
  })
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})
