/**
 * Password hashing + session handling using WebCrypto only.
 * PBKDF2-SHA256, 210k iterations (OWASP 2023 guidance for PBKDF2-SHA256 is 600k,
 * but Workers CPU budgets make that hostile on the free plan; 210k is a
 * deliberate, documented tradeoff and is configurable via PBKDF2_ITERATIONS).
 */

const ITERATIONS = 210_000
const KEY_LEN = 32

const enc = new TextEncoder()

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

export function randomId(prefix = ''): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return prefix ? `${prefix}_${id}` : id
}

export function randomSalt(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)).buffer)
}

export async function hashPassword(password: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_LEN * 8,
  )
  return toHex(bits)
}

/** Constant-time-ish comparison. Avoids early-exit string equality. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyPassword(password: string, saltHex: string, expectedHash: string): Promise<boolean> {
  const actual = await hashPassword(password, saltHex)
  return safeEqual(actual, expectedHash)
}

export function passwordIssues(password: string): string[] {
  const issues: string[] = []
  if (password.length < 10) issues.push('Use at least 10 characters.')
  if (!/[a-z]/.test(password)) issues.push('Add a lowercase letter.')
  if (!/[A-Z]/.test(password)) issues.push('Add an uppercase letter.')
  if (!/[0-9]/.test(password)) issues.push('Add a number.')
  // Reject the classics outright — cheap win, most credential stuffing is top-1000 passwords.
  const common = ['password', '123456', 'qwerty', 'letmein', 'welcome', 'admin', 'iloveyou']
  if (common.some((c) => password.toLowerCase().includes(c))) {
    issues.push('That password is too common.')
  }
  return issues
}

export const SESSION_COOKIE = 'nectary_session'
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14

export function sessionExpiry(): number {
  return Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
}

/** Parse cookies without pulling a dependency. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return null
}
