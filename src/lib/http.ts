import type { Context } from 'hono'
import type { Env, User } from '../types'
import { readCookie, SESSION_COOKIE } from './auth'

export type Ctx = Context<{ Bindings: Env; Variables: { user: User } }>

export interface ApiError {
  error: string
  message: string
  code?: string
  details?: unknown
}

export function fail(c: Ctx, status: number, code: string, message: string, details?: unknown) {
  const payload: ApiError = { error: code, message, ...(details ? { details } : {}) }
  return c.json(payload, status as any)
}

/** Resolve the signed-in user from the session cookie. */
export async function getSessionUser(c: Ctx): Promise<User | null> {
  const sid = readCookie(c.req.header('cookie'), SESSION_COOKIE)
  if (!sid) return null

  const now = Math.floor(Date.now() / 1000)
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.plan, u.credits, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(sid, now)
    .first<User>()

  return row ?? null
}

/** Middleware: require a valid session for /api/* (except the auth endpoints). */
export async function requireAuth(c: Ctx, next: () => Promise<void>) {
  const user = await getSessionUser(c)
  if (!user) {
    return c.json({ error: 'unauthorized', message: 'Please sign in.' }, 401)
  }
  c.set('user', user)
  await next()
}

/** Very small fixed-window limiter, keyed by IP. Best-effort, per-isolate. */
const buckets = new Map<string, { count: number; reset: number }>()

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs })
    return true
  }
  if (b.count >= limit) return false
  b.count++
  return true
}

export function clientIp(c: Ctx): string {
  return c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

export function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  // Neutralise spreadsheet formula injection. Excel/Sheets execute leading = + - @.
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return `"${guarded.replace(/"/g, '""')}"`
}
