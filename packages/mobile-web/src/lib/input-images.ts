const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

const SUPPORTED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

interface ClipboardItemLike {
  kind?: string;
  type?: string;
  getAsFile?: () => File | null;
}

interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike> | null;
  files?: ArrayLike<File> | null;
}

const toArray = <T>(input: ArrayLike<T> | null | undefined): T[] => {
  if (!input) return [];
  return Array.from(input);
};

export function isSupportedImageFile(file: Pick<File, "type" | "name">): boolean {
  const type = String(file.type || "").toLowerCase();
  if (SUPPORTED_IMAGE_MIME_TYPES.has(type)) return true;
  const name = String(file.name || "").toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function buildClipboardImageKey(file: File): string {
  const name = String(file.name || "").toLowerCase();
  const type = String(file.type || "").toLowerCase();
  const size = Number.isFinite(file.size) ? String(file.size) : "";
  const lastModified = Number.isFinite(file.lastModified)
    ? String(file.lastModified)
    : "";
  return `${name}|${type}|${size}|${lastModified}`;
}

export function extractClipboardImageFiles(
  clipboard: ClipboardDataLike | null | undefined,
): File[] {
  if (!clipboard) return [];
  const out: File[] = [];
  const seenKeys = new Set<string>();

  const pushIfImage = (file: File | null | undefined) => {
    if (!file || !isSupportedImageFile(file)) return;
    const key = buildClipboardImageKey(file);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    out.push(file);
  };

  toArray(clipboard.items).forEach((item) => {
    if (!item || item.kind !== "file" || typeof item.getAsFile !== "function") return;
    pushIfImage(item.getAsFile());
  });

  toArray(clipboard.files).forEach((file) => {
    pushIfImage(file);
  });

  return out;
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

export async function createImagePreviewDataUrl(file: File, maxEdge = 256): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to decode image file."));
      img.src = objectUrl;
    });

    const longest = Math.max(image.width, image.height, 1);
    const scale = Math.min(1, maxEdge / longest);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return await readFileAsDataUrl(file);
    }
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
