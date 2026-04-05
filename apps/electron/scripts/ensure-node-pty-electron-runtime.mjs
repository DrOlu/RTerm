import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..', '..', '..')
const nodePtyRoot = path.join(repoRoot, 'node_modules', 'node-pty')
const nodePtyPackageJsonPath = path.join(nodePtyRoot, 'package.json')
const windowsConoutConnectionPath = path.join(nodePtyRoot, 'lib', 'windowsConoutConnection.js')
const supportedVersions = new Set(['1.2.0-beta.3'])

const currentScript = "var scriptPath = __dirname.replace('node_modules.asar', 'node_modules.asar.unpacked');"
const patchedScript = [
  'var scriptPath = __dirname',
  "            .replace('node_modules.asar', 'node_modules.asar.unpacked')",
  "            .replace('app.asar', 'app.asar.unpacked');",
].join('\n')

const ensureFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required file was not found: ${filePath}`)
  }
}

const readJsonFile = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'))

ensureFile(nodePtyPackageJsonPath)
ensureFile(windowsConoutConnectionPath)

const nodePtyPackage = readJsonFile(nodePtyPackageJsonPath)
const nodePtyVersion = String(nodePtyPackage?.version || '').trim()
if (!supportedVersions.has(nodePtyVersion)) {
  throw new Error(
    `Unsupported node-pty version "${nodePtyVersion}". Update ${path.basename(
      fileURLToPath(import.meta.url)
    )} before building.`
  )
}

const source = fs.readFileSync(windowsConoutConnectionPath, 'utf8')
if (source.includes("app.asar.unpacked")) {
  console.log('[ensure-node-pty-electron-runtime] node-pty already patched for app.asar')
  process.exit(0)
}

if (!source.includes(currentScript)) {
  throw new Error(
    `Could not find the expected node-pty worker path snippet in ${windowsConoutConnectionPath}`
  )
}

fs.writeFileSync(windowsConoutConnectionPath, source.replace(currentScript, patchedScript), 'utf8')
console.log('[ensure-node-pty-electron-runtime] patched node-pty for Electron app.asar packaging')
