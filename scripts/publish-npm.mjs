#!/usr/bin/env node
/**
 * Assemble and publish the standalone RTerm backend to npm under BOTH
 * published names — `rterm-backend` and `neuralos` (the same tarball; the
 * neuralos name is the distribution alias) — at the version in version.json.
 *
 * Layout mirrors the existing 3.8.x packages byte-for-byte:
 *   bin/gybackend.cjs   (apps/gybackend/dist-standalone/gybackend.cjs)
 *   plugins/            (the official RTerm plugins, specs included)
 *   README.md           (the repo README)
 *   package.json        (scripts/npm-package.template.json + name/version)
 *
 * Run from the repo root AFTER `npm run build:backend-standalone`:
 *   node scripts/publish-npm.mjs --dry-run   # assemble only, print tarball listing
 *   node scripts/publish-npm.mjs             # publish both names
 * Auth: NODE_AUTH_TOKEN (npm granular token with publish rights).
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const dryRun = process.argv.includes('--dry-run')

const VERSION = JSON.parse(readFileSync(path.join(repoRoot, 'version.json'), 'utf-8')).version

const PACKAGES = [
  {
    name: 'rterm-backend',
    description:
      'AI-native terminal & agentic-AI operations platform for Forward Deployed Engineers & SREs: AIOps closed-loop remediation, AI SRE, self-healing infrastructure, runbook automation, ChatOps; executes over SSH/WinRM/serial under policy with tamper-evident audit.',
  },
  {
    name: 'neuralos',
    description:
      'Standalone neuralOS backend (rterm-backend): AI-native terminal & agentic-AI operations platform. Ships the neuralOS plugin — on-device data agents (verified probe menus over real data sources, engine + weights auto-provisioned on first use).',
  },
]

const standalone = path.join(repoRoot, 'apps/gybackend/dist-standalone/gybackend.cjs')
if (!existsSync(standalone)) {
  console.error('standalone build missing — run `npm run build:backend-standalone` first')
  process.exit(1)
}

const template = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/npm-package.template.json'), 'utf-8'))

for (const pkg of PACKAGES) {
  const stage = path.join(repoRoot, `.npm-stage-${pkg.name}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(path.join(stage, 'bin'), { recursive: true })
  cpSync(standalone, path.join(stage, 'bin', 'gybackend.cjs'))
  cpSync(path.join(repoRoot, 'plugins'), path.join(stage, 'plugins'), { recursive: true })
  cpSync(path.join(repoRoot, 'README.md'), path.join(stage, 'README.md'))
  const manifest = { ...template, name: pkg.name, version: VERSION, description: pkg.description }
  writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`[publish-npm] ${pkg.name}@${VERSION}: staged at ${path.relative(repoRoot, stage)}`)
  if (dryRun) {
    execFileSync('npm', ['pack', '--dry-run', path.basename(stage)], { cwd: repoRoot, stdio: 'inherit' })
    continue
  }
  execFileSync('npm', ['publish', stage, '--access', 'public'], { stdio: 'inherit', env: process.env })
  console.log(`[publish-npm] published ${pkg.name}@${VERSION}`)
}

if (dryRun) console.log('[publish-npm] dry run complete — nothing published')