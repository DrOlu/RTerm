#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')
const mobileWebDistPath = path.join(repoRoot, 'apps', 'mobile-web', 'dist')
const mobileWebRuntimeRoot = path.join(repoRoot, 'apps', 'electron', 'mobile-web-runtime')

function buildMobileWeb() {
  console.log('[prepare-mobile-web] Building mobile-web...')
  const result = spawnSync('npm', ['--workspace', '@gyshell/mobile-web', 'run', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Mobile web build failed with exit code ${result.status}`)
  }
}

function copyToRuntime() {
  if (!fs.existsSync(mobileWebDistPath)) {
    throw new Error(`Mobile web dist not found at: ${mobileWebDistPath}`)
  }
  fs.rmSync(mobileWebRuntimeRoot, { recursive: true, force: true })
  fs.mkdirSync(mobileWebRuntimeRoot, { recursive: true })
  fs.cpSync(mobileWebDistPath, mobileWebRuntimeRoot, { recursive: true })
}

function main() {
  buildMobileWeb()
  copyToRuntime()
  console.log(`[prepare-mobile-web] Mobile web runtime prepared at: ${mobileWebRuntimeRoot}`)
}

main()
