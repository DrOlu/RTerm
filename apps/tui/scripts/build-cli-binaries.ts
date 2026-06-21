#!/usr/bin/env bun

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { $ } from 'bun'
import solidPlugin from '@opentui/solid/bun-plugin'
import pkg from '../package.json'

type Target = {
  id: string
  platform: 'darwin' | 'linux' | 'win32'
  arch: 'arm64' | 'x64'
  bunTarget: string
}

const TARGETS: Target[] = [
  { id: 'darwin-arm64', platform: 'darwin', arch: 'arm64', bunTarget: 'bun-darwin-arm64' },
  { id: 'darwin-x64', platform: 'darwin', arch: 'x64', bunTarget: 'bun-darwin-x64' },
  { id: 'linux-arm64', platform: 'linux', arch: 'arm64', bunTarget: 'bun-linux-arm64' },
  { id: 'linux-x64', platform: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64' },
  { id: 'windows-x64', platform: 'win32', arch: 'x64', bunTarget: 'bun-windows-x64' },
]

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const workspaceRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(workspaceRoot, '../..')
const corePackageRoot = path.join(repoRoot, 'packages', 'tui')

type Layout = 'npm' | 'electron'

type BuildOptions = {
  target?: string
  layout: Layout
  outputRoot: string
  withInstall: boolean
}

function parseArgs(argv: string[]): BuildOptions {
  const options: BuildOptions = {
    layout: 'npm',
    outputRoot: path.join(workspaceRoot, 'dist', 'cli-binaries'),
    withInstall: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = argv[i + 1]

    if (token === '--target' && next) {
      options.target = next
      i += 1
      continue
    }
    if (token === '--layout' && next && (next === 'npm' || next === 'electron')) {
      options.layout = next
      i += 1
      continue
    }
    if (token === '--output-root' && next) {
      options.outputRoot = path.resolve(next)
      i += 1
      continue
    }
    if (token === '--with-install') {
      options.withInstall = true
      continue
    }
  }

  return options
}

function resolveSelectedTargets(targetId?: string): Target[] {
  if (!targetId) return TARGETS
  const match = TARGETS.find((item) => item.id === targetId)
  if (!match) {
    throw new Error(`Unknown --target "${targetId}". Supported: ${TARGETS.map((item) => item.id).join(', ')}`)
  }
  return [match]
}

function getBinaryName(target: Target): string {
  return target.platform === 'win32' ? 'gyll.exe' : 'gyll'
}

function getPackageName(target: Target): string {
  const platformLabel = target.platform === 'win32' ? 'windows' : target.platform
  return `@gyshell/tui-${platformLabel}-${target.arch}`
}

function toPosixPath(input: string): string {
  return input.replaceAll('\\', '/')
}

function resolveParserWorker(): string {
  const candidates = [
    path.join(workspaceRoot, 'node_modules', '@opentui', 'core', 'parser.worker.js'),
    path.join(corePackageRoot, 'node_modules', '@opentui', 'core', 'parser.worker.js'),
    path.join(repoRoot, 'node_modules', '@opentui', 'core', 'parser.worker.js'),
    path.join(workspaceRoot, 'node_modules', '@opentui', 'solid', 'node_modules', '@opentui', 'core', 'parser.worker.js'),
    path.join(corePackageRoot, 'node_modules', '@opentui', 'solid', 'node_modules', '@opentui', 'core', 'parser.worker.js'),
    path.join(repoRoot, 'node_modules', '@opentui', 'solid', 'node_modules', '@opentui', 'core', 'parser.worker.js'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate)
  }

  throw new Error('Cannot locate @opentui/core/parser.worker.js. Run install step first.')
}

type BuildDiagnostic = {
  level?: string
  message?: string
  position?: {
    file?: string
    line?: number
    column?: number
    lineText?: string
  }
}

function asBuildDiagnostic(value: unknown): BuildDiagnostic | null {
  if (!value || typeof value !== 'object') return null
  if (!('message' in value)) return null
  return value as BuildDiagnostic
}

function formatBuildDiagnostic(diagnostic: BuildDiagnostic): string {
  const file = diagnostic.position?.file
  const line = diagnostic.position?.line
  const column = diagnostic.position?.column
  const location =
    typeof file === 'string' && typeof line === 'number' && typeof column === 'number'
      ? `${file}:${line + 1}:${column + 1}`
      : typeof file === 'string'
        ? file
        : ''
  const level = diagnostic.level ? `${diagnostic.level}: ` : ''
  const message = diagnostic.message || 'Unknown build error'
  const lineText = diagnostic.position?.lineText ? `\n  ${diagnostic.position.lineText}` : ''
  return `${location ? `${location}: ` : ''}${level}${message}${lineText}`
}

function collectBuildFailureDetails(error: unknown): string[] {
  if (error && typeof error === 'object' && 'logs' in error && Array.isArray((error as { logs?: unknown[] }).logs)) {
    const diagnostics = ((error as { logs?: unknown[] }).logs ?? [])
      .map((item) => asBuildDiagnostic(item))
      .filter((item): item is BuildDiagnostic => item !== null)
      .map((item) => formatBuildDiagnostic(item))
    if (diagnostics.length > 0) return diagnostics
  }

  if (error instanceof AggregateError) {
    const diagnostics = error.errors
      .map((item) => asBuildDiagnostic(item))
      .filter((item): item is BuildDiagnostic => item !== null)
      .map((item) => formatBuildDiagnostic(item))
    if (diagnostics.length > 0) return diagnostics
  }

  if (error instanceof Error && error.message) {
    return [error.message]
  }

  return [String(error)]
}

async function ensureCrossPlatformOpenTui(withInstall: boolean): Promise<void> {
  if (!withInstall) return
  const version = pkg.devDependencies['@opentui/core'] || pkg.dependencies['@opentui/core']
  if (!version) {
    throw new Error('Missing @opentui/core version in package.json')
  }
  await $`bun install --ignore-scripts --os="*" --cpu="*" @opentui/core@${version}`.cwd(workspaceRoot)
}

async function compileTarget(target: Target, options: BuildOptions, parserWorker: string): Promise<void> {
  const binaryName = getBinaryName(target)
  const outputDir =
    options.layout === 'electron'
      ? path.join(options.outputRoot, 'bin')
      : path.join(options.outputRoot, getPackageName(target), 'bin')
  const outputFile = path.join(outputDir, binaryName)
  fs.mkdirSync(outputDir, { recursive: true })

  const workerRelativePath = toPosixPath(path.relative(workspaceRoot, parserWorker))
  const bunfsRoot = target.platform === 'win32' ? 'B:/~BUN/root/' : '/$bunfs/root/'

  try {
    const result = await Bun.build({
      conditions: ['browser'],
      tsconfig: path.join(workspaceRoot, 'tsconfig.json'),
      plugins: [solidPlugin],
      sourcemap: 'external',
      compile: {
        target: target.bunTarget as any,
        outfile: outputFile,
        windows: {},
      },
      entrypoints: [path.join(workspaceRoot, 'src', 'index.tsx'), parserWorker],
      define: {
        OTUI_TREE_SITTER_WORKER_PATH: `'${bunfsRoot + workerRelativePath}'`,
      },
    })

    if (!result.success) {
      const diagnostics = result.logs.map((item) => formatBuildDiagnostic(item))
      throw new Error(diagnostics.join('\n'))
    }
  } catch (error) {
    const details = collectBuildFailureDetails(error)
    throw new Error(`Failed to compile CLI target "${target.id}".\n${details.join('\n')}`)
  }

  if (options.layout === 'npm') {
    const packageDir = path.join(options.outputRoot, getPackageName(target))
    const packageJson = {
      name: getPackageName(target),
      version: pkg.version,
      os: [target.platform],
      cpu: [target.arch],
      bin: {
        gyll: `./bin/${binaryName}`,
      },
    }
    fs.writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
  }
}

async function main(): Promise<void> {
  process.chdir(workspaceRoot)
  const options = parseArgs(process.argv.slice(2))
  const targets = resolveSelectedTargets(options.target)

  if (options.layout === 'electron' && targets.length !== 1) {
    throw new Error('Electron layout requires exactly one --target.')
  }

  fs.rmSync(options.outputRoot, { recursive: true, force: true })
  fs.mkdirSync(options.outputRoot, { recursive: true })

  await ensureCrossPlatformOpenTui(options.withInstall)
  const parserWorker = resolveParserWorker()

  for (const target of targets) {
    await compileTarget(target, options, parserWorker)
  }

  if (options.layout === 'electron') {
    const target = targets[0]
    fs.writeFileSync(
      path.join(options.outputRoot, 'metadata.json'),
      `${JSON.stringify({ target: target.id, binary: getBinaryName(target) }, null, 2)}\n`,
      'utf8',
    )
  } else {
    const optionalDependencies: Record<string, string> = {}
    for (const target of targets) {
      optionalDependencies[getPackageName(target)] = pkg.version
    }
    fs.writeFileSync(
      path.join(options.outputRoot, 'optional-dependencies.json'),
      `${JSON.stringify(optionalDependencies, null, 2)}\n`,
      'utf8',
    )
  }

  console.log(`[build-cli-binaries] layout=${options.layout} output=${options.outputRoot}`)
  console.log(`[build-cli-binaries] targets=${targets.map((item) => item.id).join(', ')}`)
}

void main().catch((error) => {
  const message = collectBuildFailureDetails(error).join('\n')
  console.error(`[build-cli-binaries] failed: ${message}`)
  process.exit(1)
})
