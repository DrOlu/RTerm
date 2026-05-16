import {
  MEDIA_PREVIEW_MAX_BYTES,
  resolveFilePreviewKindForPath,
  resolveFilePreviewSupport,
  TEXT_PREVIEW_MAX_BYTES,
} from './filePreviewSupport'
import type { FileSystemEntry } from './ipcTypes'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const entry = (name: string, size: number): FileSystemEntry => ({
  name,
  path: `/tmp/${name}`,
  isDirectory: false,
  isSymbolicLink: false,
  size,
})

const run = async (): Promise<void> => {
  await runCase('known text files resolve to editable text previews', () => {
    const decision = resolveFilePreviewSupport(entry('notes.md', 1024))
    assertEqual(decision.supported, true, 'markdown should be supported')
    assertEqual(decision.kind, 'text', 'markdown should use text preview')
    assertEqual(resolveFilePreviewKindForPath('/tmp/Makefile'), 'text', 'Makefile should resolve as text')
  })

  await runCase('common image files resolve to read-only image previews', () => {
    for (const name of ['sample.png', 'photo.jpg', 'icon.svg', 'frame.avif']) {
      const decision = resolveFilePreviewSupport(entry(name, 2048))
      assertEqual(decision.supported, true, `${name} should be supported`)
      assertEqual(decision.kind, 'image', `${name} should use image preview`)
      assertEqual(resolveFilePreviewKindForPath(`/tmp/${name}`), 'image', `${name} path should resolve as image`)
    }
  })

  await runCase('pdf files resolve to read-only PDF previews', () => {
    const decision = resolveFilePreviewSupport(entry('paper.pdf', 4096))
    assertEqual(decision.supported, true, 'pdf should be supported')
    assertEqual(decision.kind, 'pdf', 'pdf should use pdf preview')
    assertEqual(resolveFilePreviewKindForPath('/tmp/paper.pdf'), 'pdf', 'pdf path should resolve as pdf')
  })

  await runCase('size limits are enforced per preview class', () => {
    const largeText = resolveFilePreviewSupport(entry('large.txt', TEXT_PREVIEW_MAX_BYTES + 1))
    assertEqual(largeText.supported, false, 'oversized text should be rejected')
    assertEqual(largeText.kind, 'text', 'oversized text should keep text kind')
    assertEqual(largeText.reason, 'fileTooLarge', 'oversized text should report fileTooLarge')

    const largeImage = resolveFilePreviewSupport(entry('large.png', MEDIA_PREVIEW_MAX_BYTES + 1))
    assertEqual(largeImage.supported, false, 'oversized image should be rejected')
    assertEqual(largeImage.kind, 'image', 'oversized image should keep image kind')
    assertEqual(largeImage.reason, 'fileTooLarge', 'oversized image should report fileTooLarge')
  })

  await runCase('unsupported binary files stay blocked', () => {
    const decision = resolveFilePreviewSupport(entry('archive.zip', 1024))
    assertEqual(decision.supported, false, 'zip should be unsupported')
    assertEqual(decision.reason, 'unsupportedType', 'zip should report unsupportedType')
  })
}

void run()
  .then(() => {
    console.log('All filePreviewSupport extreme tests passed.')
  })
  .catch((error) => {
    console.error(error)
    throw error
  })
