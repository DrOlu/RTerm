import { NodePtyBackend } from './NodePtyBackend'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const run = async (): Promise<void> => {
  await runCase('windows monitor exec uses powershell instead of cmd.exe', async () => {
    const backend = new NodePtyBackend()
    const invocation = (backend as any).buildExecInvocation(
      "powershell -nop -noni -c '$d=1'",
      'win32'
    ) as {
      shell: string
      args: string[]
    }

    assertEqual(
      invocation.shell,
      'powershell.exe',
      'windows monitor exec should bypass cmd.exe quoting rules'
    )
    assertEqual(
      invocation.args[3],
      '-Command',
      'windows exec should pass monitor commands as a powershell command string'
    )
    assertEqual(
      invocation.args[4],
      "powershell -nop -noni -c '$d=1'",
      'windows exec should preserve the original command payload'
    )
  })

  await runCase('unix monitor exec continues to use /bin/sh -c', async () => {
    const backend = new NodePtyBackend()
    const invocation = (backend as any).buildExecInvocation(
      'printf test',
      'linux'
    ) as {
      shell: string
      args: string[]
    }

    assertEqual(invocation.shell, '/bin/sh', 'unix exec should keep using /bin/sh')
    assertEqual(invocation.args[0], '-c', 'unix exec should invoke the shell with -c')
    assertEqual(invocation.args[1], 'printf test', 'unix exec should preserve the shell command')
  })

  await runCase('windows exec still preserves cmd.exe fallbacks inside powershell', async () => {
    const backend = new NodePtyBackend()
    const invocation = (backend as any).buildExecInvocation(
      'cmd.exe /c ver 2>&1',
      'win32'
    ) as {
      shell: string
      args: string[]
    }

    assertCondition(
      invocation.args.includes('cmd.exe /c ver 2>&1'),
      'windows exec should keep cmd.exe-based fallback commands intact under powershell'
    )
  })
}

void run()

