import type { Env } from '../types'
import { randomId } from './auth'

/**
 * Credit ledger.
 *
 * The rule that matters: nobody can spend credits they do not have, even under
 * concurrency. We never read-then-write. Every spend is a single conditional
 * UPDATE whose WHERE clause enforces the balance, and we inspect D1's
 * `meta.changes` to learn whether we actually won the race.
 *
 *   UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?
 *
 * If changes === 0 the reservation failed and the caller must not call the paid
 * provider. Refunds are unconditional additive writes with their own ledger row.
 */

export const CREDIT_COSTS = {
  scan: 5,
  enrichCompany: 2,
  reScan: 0, // cached domain reads are free by design
} as const

export interface SpendResult {
  ok: boolean
  balance: number
  ledgerId?: string
}

async function currentBalance(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(userId).first<{ credits: number }>()
  return row?.credits ?? 0
}

/** Reserve credits atomically. Returns ok:false if the balance is insufficient. */
export async function spendCredits(
  env: Env,
  userId: string,
  amount: number,
  kind: 'scan' | 'enrich' | 'adjust',
  ref: string,
  meta: Record<string, unknown> = {},
): Promise<SpendResult> {
  if (amount <= 0) return { ok: true, balance: await currentBalance(env, userId) }

  const res = await env.DB.prepare('UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?')
    .bind(amount, userId, amount)
    .run()

  const changed = res.meta?.changes ?? 0
  if (!changed) {
    return { ok: false, balance: await currentBalance(env, userId) }
  }

  const balance = await currentBalance(env, userId)
  const ledgerId = randomId('lg')
  await env.DB.prepare(
    'INSERT INTO ledger (id, user_id, delta, balance_after, kind, ref, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(ledgerId, userId, -amount, balance, kind, ref, JSON.stringify(meta))
    .run()

  return { ok: true, balance, ledgerId }
}

/** Give credits back (failed provider call, aborted enrichment). */
export async function refundCredits(
  env: Env,
  userId: string,
  amount: number,
  ref: string,
  meta: Record<string, unknown> = {},
): Promise<number> {
  if (amount <= 0) return currentBalance(env, userId)
  await env.DB.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').bind(amount, userId).run()
  const balance = await currentBalance(env, userId)
  await env.DB.prepare(
    'INSERT INTO ledger (id, user_id, delta, balance_after, kind, ref, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(randomId('lg'), userId, amount, balance, 'refund', ref, JSON.stringify(meta))
    .run()
  return balance
}

export async function grantCredits(
  env: Env,
  userId: string,
  amount: number,
  kind: 'grant' | 'adjust',
  ref = 'signup',
): Promise<number> {
  await env.DB.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').bind(amount, userId).run()
  const balance = await currentBalance(env, userId)
  await env.DB.prepare(
    'INSERT INTO ledger (id, user_id, delta, balance_after, kind, ref, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(randomId('lg'), userId, amount, balance, kind, ref, '{}')
    .run()
  return balance
}

export async function recentLedger(env: Env, userId: string, limit = 25) {
  const { results } = await env.DB.prepare(
    'SELECT id, delta, balance_after, kind, ref, created_at FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
  )
    .bind(userId, limit)
    .all()
  return results ?? []
}

export async function ledgerSummary(env: Env, userId: string) {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS spent,
       COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS granted,
       COUNT(*) AS entries
     FROM ledger WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ spent: number; granted: number; entries: number }>()
  return row ?? { spent: 0, granted: 0, entries: 0 }
}

export async function audit(
  env: Env,
  userId: string | null,
  action: string,
  meta: Record<string, unknown> = {},
  ip?: string,
) {
  try {
    await env.DB.prepare('INSERT INTO audit_log (id, user_id, action, meta, ip) VALUES (?, ?, ?, ?, ?)')
      .bind(randomId('au'), userId, action, JSON.stringify(meta), ip ?? null)
      .run()
  } catch {
    // Audit must never break a request path, but it should be visible in logs.
    console.error('audit write failed', action)
  }
}
