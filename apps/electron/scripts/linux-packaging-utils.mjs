import path from 'node:path'

const CANONICAL_LINUX_ARCH_BY_ALIAS = new Map([
  ['x86_64', 'x64'],
  ['amd64', 'x64'],
  ['aarch64', 'arm64'],
])

const LINUX_PACKAGE_EXTENSIONS = new Set(['.AppImage', '.deb', '.pacman', '.rpm'])

export function normalizeLinuxArtifactName(fileName) {
  return fileName.replace(/(^|[-_.])(x86_64|amd64|aarch64)(?=[-_.]|$)/g, (match, prefix, archAlias) => {
    const canonicalArch = CANONICAL_LINUX_ARCH_BY_ALIAS.get(archAlias)
    return canonicalArch ? `${prefix}${canonicalArch}` : match
  })
}

export function normalizeLinuxArtifactPath(filePath) {
  const extension = path.extname(filePath)
  if (!LINUX_PACKAGE_EXTENSIONS.has(extension)) {
    return filePath
  }

  const normalizedName = normalizeLinuxArtifactName(path.basename(filePath))
  if (normalizedName === path.basename(filePath)) {
    return filePath
  }

  return path.join(path.dirname(filePath), normalizedName)
}
