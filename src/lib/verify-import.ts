import type { CandidateCompany } from '../types'
import { safeFetch, validateUrl } from './ssrf'
import { pageTitle, htmlToText } from './crawl'

/**
 * Import verification.
 *
 * Imported company lists get exactly the same gate as AI-proposed ones: the
 * domain must be reachable, return a readable page, and be a real site. No LLM
 * is involved in this path at all, which makes it fully deterministic.
 */

export interface ImportVerifyResult {
  verified: CandidateCompany[]
  unverified: CandidateCompany[]
  notes: string[]
}

const CONCURRENCY = 4

async function verifyOne(c: CandidateCompany): Promise<{ ok: boolean; website?: string; note: string }> {
  try {
    validateUrl(`https://${c.domain}`)
  } catch {
    return { ok: false, note: 'rejected by URL policy' }
  }
  try {
    const res = await safeFetch(`https://${c.domain}`, { timeoutMs: 6000, maxBytes: 400_000 })
    if (res.status >= 400) return { ok: false, note: `http ${res.status}` }
    if (!res.body) return { ok: false, note: 'no readable html' }
    const text = htmlToText(res.body)
    if (text.length < 150) return { ok: false, note: 'page had no content' }
    return { ok: true, note: pageTitle(res.body) || 'live site confirmed' }
  } catch (e: any) {
    return { ok: false, note: String(e?.message || 'unreachable').slice(0, 80) }
  }
}

export async function verifyImported(candidates: CandidateCompany[]): Promise<ImportVerifyResult> {
  const verified: CandidateCompany[] = []
  const unverified: CandidateCompany[] = []

  // Small parallel batches: fast enough for a 40-row import, still polite.
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY)
    const checks = await Promise.all(batch.map((c) => verifyOne(c)))
    checks.forEach((check, idx) => {
      const cand = batch[idx]
      if (check.ok) verified.push(cand)
      else unverified.push(cand)
    })
  }

  const notes: string[] = []
  if (unverified.length) {
    notes.push(`${unverified.length} imported domain${unverified.length === 1 ? '' : 's'} could not be confirmed and will not be enriched.`)
  }
  if (verified.length === 0) {
    notes.push('None of the imported domains could be confirmed live. Check the list format: one domain per line, or "name, domain".')
  }

  return { verified, unverified, notes }
}
