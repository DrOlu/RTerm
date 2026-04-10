import fs from 'node:fs'

const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c
const EM_X86_64 = 62
const EM_AARCH64 = 183
const IMAGE_FILE_MACHINE_AMD64 = 0x8664
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64

const MACHO_THIN_BIG_ENDIAN = new Set(['feedface', 'feedfacf'])
const MACHO_THIN_LITTLE_ENDIAN = new Set(['cefaedfe', 'cffaedfe'])
const MACHO_FAT_BIG_ENDIAN = new Set(['cafebabe', 'cafebabf'])
const MACHO_FAT_LITTLE_ENDIAN = new Set(['bebafeca', 'bfbafeca'])

function mapMachCpuTypeToArch(cpuType) {
  const normalized = cpuType >>> 0
  if (normalized === CPU_TYPE_X86_64) return 'x64'
  if (normalized === CPU_TYPE_ARM64) return 'arm64'
  return null
}

function mapElfMachineToArch(machine) {
  if (machine === EM_X86_64) return 'x64'
  if (machine === EM_AARCH64) return 'arm64'
  return null
}

function mapPeMachineToArch(machine) {
  if (machine === IMAGE_FILE_MACHINE_AMD64) return 'x64'
  if (machine === IMAGE_FILE_MACHINE_ARM64) return 'arm64'
  return null
}

function uniqueArches(arches) {
  return Array.from(new Set(arches.filter(Boolean)))
}

function buildIdentity(platform, arches, format) {
  return {
    platform,
    arches: uniqueArches(arches),
    format,
  }
}

function readMachArch(buffer) {
  const magicHex = buffer.subarray(0, 4).toString('hex')

  if (MACHO_THIN_BIG_ENDIAN.has(magicHex)) {
    return buildIdentity('darwin', [mapMachCpuTypeToArch(buffer.readInt32BE(4))], 'mach-o')
  }

  if (MACHO_THIN_LITTLE_ENDIAN.has(magicHex)) {
    return buildIdentity('darwin', [mapMachCpuTypeToArch(buffer.readInt32LE(4))], 'mach-o')
  }

  if (MACHO_FAT_BIG_ENDIAN.has(magicHex) || MACHO_FAT_LITTLE_ENDIAN.has(magicHex)) {
    const littleEndian = MACHO_FAT_LITTLE_ENDIAN.has(magicHex)
    const readUInt32 = littleEndian ? buffer.readUInt32LE.bind(buffer) : buffer.readUInt32BE.bind(buffer)
    const archEntrySize = magicHex === 'cafebabf' || magicHex === 'bfbafeca' ? 32 : 20
    const archCount = readUInt32(4)
    const arches = []

    for (let index = 0; index < archCount; index += 1) {
      const offset = 8 + index * archEntrySize
      if (offset + 4 > buffer.length) {
        break
      }
      arches.push(mapMachCpuTypeToArch(readUInt32(offset)))
    }

    return buildIdentity('darwin', arches, 'mach-o-fat')
  }

  return null
}

function readElfArch(buffer) {
  if (buffer.length < 20) {
    return buildIdentity('linux', [], 'elf')
  }
  const littleEndian = buffer[5] !== 2
  const machine = littleEndian ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18)
  return buildIdentity('linux', [mapElfMachineToArch(machine)], 'elf')
}

function readPeArch(buffer) {
  if (buffer.length < 0x40) {
    return buildIdentity('win32', [], 'pe')
  }

  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset + 6 > buffer.length) {
    return buildIdentity('win32', [], 'pe')
  }

  const signature = buffer.subarray(peOffset, peOffset + 4)
  if (signature.toString('hex') !== '50450000') {
    return buildIdentity('win32', [], 'pe')
  }

  const machine = buffer.readUInt16LE(peOffset + 4)
  return buildIdentity('win32', [mapPeMachineToArch(machine)], 'pe')
}

export function inspectNativeBinary(filePath) {
  if (!fs.existsSync(filePath)) {
    return buildIdentity('missing', [], 'missing')
  }

  const buffer = fs.readFileSync(filePath)
  if (buffer.length < 4) {
    return buildIdentity('unknown', [], 'unknown')
  }

  if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return readPeArch(buffer)
  }

  const machIdentity = readMachArch(buffer)
  if (machIdentity) {
    return machIdentity
  }

  if (
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46
  ) {
    return readElfArch(buffer)
  }

  return buildIdentity('unknown', [], 'unknown')
}

export function matchesNativeBinaryTarget(identity, targetPlatform, targetArch) {
  return (
    identity.platform === targetPlatform &&
    Array.isArray(identity.arches) &&
    identity.arches.includes(targetArch)
  )
}

export function formatNativeBinaryIdentity(identity) {
  if (!identity || identity.platform === 'missing') {
    return 'missing'
  }

  const arches = Array.isArray(identity.arches) && identity.arches.length > 0
    ? identity.arches.join('+')
    : 'unknown-arch'

  return `${identity.platform}/${arches} (${identity.format})`
}
