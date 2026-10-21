/**
 * Coercion helpers for model output.
 *
 * LLMs drift. A field declared as an array comes back as a comma-joined string,
 * a single object, or a number often enough that trusting `|| []` is a bug:
 * `|| []` only guards null/undefined, so a non-empty string passes through and
 * the next `.map` throws and takes the whole request down.
 *
 * These helpers make field-level drift a non-event instead of a 500.
 */

/** Always an array of strings, whatever the model actually sent. */
export function asStrArray(value: unknown, max = 12, maxLen = 300): string[] {
  if (value === null || value === undefined) return []

  if (Array.isArray(value)) {
    return value
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      .map((v) => toStr(v))
      .filter((v) => v.length > 0)
      .slice(0, max)
  }

  if (typeof value === 'string') {
    // "a, b, c" / "a; b" / newline lists
    return value
      .split(/\r?\n|;|,(?![^(]*\))/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
      .slice(0, max)
      .map((v) => v.slice(0, maxLen))
  }

  if (typeof value === 'object') {
    // {"0": "a", "1": "b"} or {title: "..."} style drift
    return Object.values(value as Record<string, unknown>)
      .map((v) => toStr(v))
      .filter((v) => v.length > 0)
      .slice(0, max)
  }

  return [toStr(value)].filter((v) => v.length > 0).slice(0, max)
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const key of ['name', 'title', 'value', 'text', 'label']) {
      if (typeof o[key] === 'string') return String(o[key]).trim()
    }
    return ''
  }
  return ''
}

/** Always a finite number within a range. */
export function asInt(value: unknown, lo = 0, hi = 100, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.-]/g, ''))
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

/** Always a trimmed, length-capped string. */
export function asStr(value: unknown, max = 500, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') return value.trim().slice(0, max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    const s = toStr(value)
    return s ? s.slice(0, max) : fallback
  }
  return fallback
}

/** Pull the first array out of several possible wrapper keys. */
export function pickArray(obj: any, keys: string[]): any[] {
  if (Array.isArray(obj)) return obj
  if (!obj || typeof obj !== 'object') return []
  for (const k of keys) {
    if (Array.isArray(obj[k])) return obj[k]
  }
  // Last resort: if the object has exactly one array-valued property, use it.
  const arrays = Object.values(obj).filter((v) => Array.isArray(v)) as any[][]
  if (arrays.length === 1) return arrays[0]
  return []
}
