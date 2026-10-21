import { Hono } from 'hono'
import type { Env } from '../types'
import {
  hashPassword,
  verifyPassword,
  randomSalt,
  randomId,
  passwordIssues,
  sessionExpiry,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  readCookie,
} from '../lib/auth'
import { grantCredits, audit, recentLedger, ledgerSummary } from '../lib/ledger'
import { fail, getSessionUser, rateLimit, clientIp, str, type Ctx } from '../lib/http'

const auth = new Hono<{ Bindings: Env }>()

const SIGNUP_CREDITS = 25

function cookieHeader(sid: string, maxAge = SESSION_TTL_SECONDS): string {
  // SameSite=Lax blocks cross-site POSTs; HttpOnly keeps it away from JS.
  // Secure is applied because this always runs behind HTTPS in deployment.
  return `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

auth.post('/signup', async (c) => {
  const ip = clientIp(c as Ctx)
  if (!rateLimit(`signup:${ip}`, 5, 10 * 60_000)) {
    return fail(c as Ctx, 429, 'rate_limited', 'Too many attempts. Try again in a few minutes.')
  }

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return fail(c as Ctx, 400, 'bad_request', 'Invalid request body.')
  }

  const email = str(body?.email, 320).trim().toLowerCase()
  const password = str(body?.password, 200)

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return fail(c as Ctx, 400, 'bad_email', 'That email address looks invalid.')
  }
  const issues = passwordIssues(password)
  if (issues.length) {
    return fail(c as Ctx, 400, 'weak_password', issues[0], { issues })
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>()
  if (existing) {
    // Do not confirm account existence beyond what signup inherently reveals.
    return fail(c as Ctx, 409, 'email_taken', 'An account with that email already exists. Try signing in.')
  }

  const salt = randomSalt()
  const hash = await hashPassword(password, salt)
  const userId = randomId('usr')

  try {
    await c.env.DB.prepare(
      'INSERT INTO users (id, email, password_hash, password_salt, plan, credits) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(userId, email, hash, salt, 'trial', 0)
      .run()
  } catch {
    return fail(c as Ctx, 500, 'signup_failed', 'Could not create the account. Please try again.')
  }

  await grantCredits(c.env, userId, SIGNUP_CREDITS, 'grant', 'signup')
  await audit(c.env, userId, 'signup', { email }, ip)

  const sid = randomId('ses')
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(sid, userId, sessionExpiry())
    .run()

  c.header('Set-Cookie', cookieHeader(sid))
  return c.json({ ok: true, user: { id: userId, email, plan: 'trial', credits: SIGNUP_CREDITS } })
})

auth.post('/login', async (c) => {
  const ip = clientIp(c as Ctx)
  // Tighter limit on login than signup: this is the credential-stuffing target.
  if (!rateLimit(`login:${ip}`, 10, 10 * 60_000)) {
    return fail(c as Ctx, 429, 'rate_limited', 'Too many attempts. Try again in a few minutes.')
  }

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return fail(c as Ctx, 400, 'bad_request', 'Invalid request body.')
  }

  const email = str(body?.email, 320).trim().toLowerCase()
  const password = str(body?.password, 200)
  if (!email || !password) {
    return fail(c as Ctx, 400, 'missing_fields', 'Email and password are required.')
  }

  const row = await c.env.DB.prepare(
    'SELECT id, email, password_hash, password_salt, plan, credits FROM users WHERE email = ?',
  )
    .bind(email)
    .first<any>()

  // Run the hash even when the user does not exist, so response time does not
  // reveal whether an account exists (user enumeration).
  const salt = row?.password_salt || randomSalt()
  const expected = row?.password_hash || '0'.repeat(64)
  const ok = await verifyPassword(password, salt, expected)

  if (!row || !ok) {
    await audit(c.env, row?.id ?? null, 'login_failed', { email }, ip)
    return fail(c as Ctx, 401, 'bad_credentials', 'Email or password is incorrect.')
  }

  const sid = randomId('ses')
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(sid, row.id, sessionExpiry())
    .run()

  await audit(c.env, row.id, 'login', {}, ip)
  c.header('Set-Cookie', cookieHeader(sid))
  return c.json({
    ok: true,
    user: { id: row.id, email: row.email, plan: row.plan, credits: row.credits },
  })
})

auth.post('/logout', async (c) => {
  const sid = readCookie(c.req.header('cookie'), SESSION_COOKIE)
  if (sid) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run()
  }
  c.header('Set-Cookie', cookieHeader('', 0))
  return c.json({ ok: true })
})

auth.get('/me', async (c) => {
  const user = await getSessionUser(c as Ctx)
  if (!user) return c.json({ user: null }, 200)
  const summary = await ledgerSummary(c.env, user.id)
  return c.json({ user, summary })
})

auth.get('/ledger', async (c) => {
  const user = await getSessionUser(c as Ctx)
  if (!user) return fail(c as Ctx, 401, 'unauthorized', 'Please sign in.')
  const entries = await recentLedger(c.env, user.id, 30)
  const summary = await ledgerSummary(c.env, user.id)
  return c.json({ entries, summary, balance: user.credits })
})

export default auth
