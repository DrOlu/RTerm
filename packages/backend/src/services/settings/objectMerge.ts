function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (!isObject(base) || !isObject(patch)) {
    return { ...(base as any), ...(patch as any) }
  }

  const out: any = { ...(base as any) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (isObject(value) && isObject(out[key])) {
      out[key] = deepMerge(out[key], value)
      continue
    }
    out[key] = value
  }
  return out
}

export { isObject, deepMerge }
