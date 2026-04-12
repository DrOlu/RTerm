import {
  resolveRichInputClipboardPaste,
  type RichInputClipboardPaste,
} from './userInput'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const runCase = (name: string, fn: () => void): void => {
  fn()
  console.log(`PASS ${name}`)
}

const makeFile = (name: string, type = '', size = 1): File =>
  ({ name, type, size } as File)

const textClipboard = (text: string) => ({
  getData: (format: string) => {
    assertEqual(format, 'text/plain', 'text paste should request plain text')
    return text
  },
  items: [],
  files: [],
})

const assertTextPaste = (
  paste: RichInputClipboardPaste,
  expectedText: string,
  message: string,
): void => {
  assertEqual(paste.kind, 'text', `${message}: paste kind`)
  if (paste.kind !== 'text') return
  assertEqual(paste.text.length, expectedText.length, `${message}: text length`)
  assertEqual(paste.text, expectedText, `${message}: text content`)
}

runCase('empty clipboard resolves to direct empty text insertion', () => {
  assertTextPaste(resolveRichInputClipboardPaste(undefined), '', 'missing clipboard')
  assertTextPaste(resolveRichInputClipboardPaste(textClipboard('')), '', 'empty text clipboard')
})

runCase('former paste thresholds all remain direct full text insertions', () => {
  const cases = [
    'x'.repeat(499),
    'x'.repeat(500),
    'x'.repeat(501),
    'x'.repeat(3999),
    'x'.repeat(4000),
    'x'.repeat(4001),
    `prefix\n${'0123456789'.repeat(20000)}\nsuffix`,
  ]

  cases.forEach((text, index) => {
    assertTextPaste(
      resolveRichInputClipboardPaste(textClipboard(text)),
      text,
      `threshold case ${index}`,
    )
  })
})

runCase('plain text preserves multiline punctuation and mention-like content verbatim', () => {
  const text = [
    'first line',
    '[MENTION_USER_PASTE:#/tmp/paste.txt##preview#]',
    '[MENTION_FILE:#/tmp/file.txt#]',
    'punctuation-like text: <>[]{}#_!',
    'last line',
  ].join('\n')

  assertTextPaste(resolveRichInputClipboardPaste(textClipboard(text)), text, 'verbatim text paste')
})

runCase('recognized clipboard image item wins over even huge text without reading text data', () => {
  const image = makeFile('screenshot.png', 'image/png')
  const paste = resolveRichInputClipboardPaste({
    items: [
      {
        kind: 'file',
        type: 'image/png',
        getAsFile: () => image,
      },
    ],
    files: [],
    getData: () => {
      throw new Error('text data should not be read when an image is present')
    },
  })

  assertEqual(paste.kind, 'imageFiles', 'image item should produce imageFiles paste')
  if (paste.kind !== 'imageFiles') return
  assertEqual(paste.files.length, 1, 'one image should be attached')
  assertEqual(paste.files[0], image, 'image file identity should be preserved')
})

runCase('image detection accepts extension fallback and ignores non-image files', () => {
  const imageByName = makeFile('capture.WEBP', '')
  const textFile = makeFile('notes.txt', 'text/plain')
  const paste = resolveRichInputClipboardPaste({
    items: [
      {
        kind: 'file',
        type: '',
        getAsFile: () => imageByName,
      },
      {
        kind: 'file',
        type: 'text/plain',
        getAsFile: () => textFile,
      },
    ],
    files: [],
    getData: () => 'not used',
  })

  assertEqual(paste.kind, 'imageFiles', 'image extension should be enough for image paste')
  if (paste.kind !== 'imageFiles') return
  assertEqual(paste.files.length, 1, 'non-image clipboard files should be ignored')
  assertEqual(paste.files[0], imageByName, 'recognized image should be kept')
})

runCase('non-image file clipboard falls back to direct text paste', () => {
  const text = 'clipboard text next to a non-image file'
  const paste = resolveRichInputClipboardPaste({
    items: [
      {
        kind: 'file',
        type: 'text/plain',
        getAsFile: () => makeFile('notes.txt', 'text/plain'),
      },
    ],
    files: [],
    getData: () => text,
  })

  assertTextPaste(paste, text, 'non-image file clipboard')
})

runCase('files fallback still attaches images when clipboard items do not expose image files', () => {
  const image = makeFile('fallback.jpg', 'image/jpeg')
  const paste = resolveRichInputClipboardPaste({
    items: [
      {
        kind: 'string',
        type: 'text/plain',
      },
    ],
    files: [image, makeFile('readme.md', 'text/markdown')] as unknown as FileList,
    getData: () => {
      throw new Error('text data should not be read when files fallback has an image')
    },
  })

  assertEqual(paste.kind, 'imageFiles', 'files fallback should attach image')
  if (paste.kind !== 'imageFiles') return
  assertEqual(paste.files.length, 1, 'files fallback should ignore non-images')
  assertEqual(paste.files[0], image, 'fallback image should be preserved')
})
