export interface InputImageAttachment {
  attachmentId?: string
  fileName?: string
  mimeType?: string
  sizeBytes?: number
  sha256?: string
  previewDataUrl?: string
  status?: 'ready' | 'missing'
}

export interface ComposerImageAttachment extends InputImageAttachment {
  id: string
  previewUrl: string
  localFile?: File
}

export interface UserInputPayload {
  text: string
  images?: InputImageAttachment[]
}

export interface ComposerDraft {
  text: string
  images: ComposerImageAttachment[]
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp'
])

const SUPPORTED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']

interface ClipboardItemLike {
  kind?: string
  type?: string
  getAsFile?: () => File | null
}

interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike> | null
  files?: ArrayLike<File> | null
}

export type RichInputClipboardPaste =
  | { kind: 'imageFiles'; files: File[] }
  | { kind: 'text'; text: string }

interface RichInputClipboardDataLike extends ClipboardDataLike {
  getData?: (format: string) => string
}

const toArray = <T>(input: ArrayLike<T> | null | undefined): T[] => {
  if (!input) return []
  return Array.from(input)
}

export const isRecognizedImageFile = (file: Pick<File, 'type' | 'name'>): boolean => {
  const type = String(file.type || '').toLowerCase()
  if (SUPPORTED_IMAGE_MIME_TYPES.has(type)) return true
  const name = String(file.name || '').toLowerCase()
  return SUPPORTED_IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext))
}

export const extractClipboardImageFiles = (clipboard: ClipboardDataLike | null | undefined): File[] => {
  if (!clipboard) return []
  const fromItems = toArray(clipboard.items)
    .map((item) => {
      if (!item || item.kind !== 'file' || typeof item.getAsFile !== 'function') return null
      return item.getAsFile()
    })
    .filter((file): file is File => !!file && isRecognizedImageFile(file))

  if (fromItems.length > 0) {
    return fromItems
  }

  return toArray(clipboard.files).filter((file) => !!file && isRecognizedImageFile(file))
}

export const resolveRichInputClipboardPaste = (
  clipboard: RichInputClipboardDataLike | null | undefined
): RichInputClipboardPaste => {
  const imageFiles = extractClipboardImageFiles(clipboard)
  if (imageFiles.length > 0) {
    return { kind: 'imageFiles', files: imageFiles }
  }

  const text = typeof clipboard?.getData === 'function' ? clipboard.getData('text/plain') : ''
  return { kind: 'text', text }
}

export const readFileAsDataUrl = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read image file.'))
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsDataURL(file)
  })

export const createImagePreviewDataUrl = async (file: File, maxEdge = 256): Promise<string> => {
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('Failed to decode image file.'))
      img.src = objectUrl
    })

    const longest = Math.max(image.width, image.height, 1)
    const scale = Math.min(1, maxEdge / longest)
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      return await readFileAsDataUrl(file)
    }
    context.drawImage(image, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.82)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
