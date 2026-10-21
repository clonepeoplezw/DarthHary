import { Hono } from 'hono'
import type { Env, User } from '../types'
import { runScan } from '../lib/scan'
import { discoverCompanies, parseImportedCompanies, type DiscoveryResult } from '../lib/discover'
import { verifyImported } from '../lib/verify-import'
import { enrichContact, enrichmentConfigured } from '../lib/enrich'
import { personalize } from '../lib/personalize'
import { spendCredits, refundCredits, CREDIT_COSTS, audit } from '../lib/ledger'
import { randomId } from '../lib/auth'
import { fail, rateLimit, clientIp, str, csvCell, type Ctx } from '../lib/http'
import { llmConfigured } from '../lib/llm'
import { UrlRejected } from '../lib/ssrf'

const scans = new Hono<{ Bindings: Env; Variables: { user: User } }>()

/* ---------------------------------------------------------------- *
 * POST /api/scans - run a new scan
 * ---------------------------------------------------------------- */
scans.post('/', async (c) => {
  const user = c.get('user')
  const ip = clientIp(c as Ctx)

  if (!rateLimit(`scan:${user.id}`, 8, 10 * 60_000)) {
    return fail(c as Ctx, 429, 'rate_limited', 'You are scanning very fast. Give it a minute.')
  }

  const llm = llmConfigured(c.env)
  if (!llm.ok) {
    return fail(
      c as Ctx,
      503,
      'llm_not_configured',
      'The AI provider is not configured on this server. An admin needs to set GEMINI_API_KEY.',
    )
  }

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return fail(c as Ctx, 400, 'bad_request', 'Invalid request body.')
  }

  const rawUrl = str(body?.url, 2048).trim()
  if (!rawUrl) return fail(c as Ctx, 400, 'missing_url', 'Enter your website URL.')
  const focus = str(body?.focus, 600)

  // Pay upfront, refund on failure. A scan is a bounded, predictable cost.
  const spend = await spendCredits(c.env, user.id, CREDIT_COSTS.scan, 'scan', 'scan:new', { url: rawUrl })
  if (!spend.ok) {
    return fail(c as Ctx, 402, 'insufficient_credits', `A scan costs ${CREDIT_COSTS.scan} credits and you have ${spend.balance}.`, {
      balance: spend.balance,
      required: CREDIT_COSTS.scan,
    })
  }

  const scanId = randomId('scn')
  await c.env.DB.prepare(
    'INSERT INTO scans (id, user_id, input_url, domain, status) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(scanId, user.id, rawUrl, '', 'running')
    .run()

  try {
    const result = await runScan(c.env, { url: rawUrl, focus })

    await c.env.DB.prepare(
      'UPDATE scans SET status = ?, domain = ?, profile_json = ?, pages_json = ?, completed_at = datetime(\'now\') WHERE id = ? AND user_id = ?',
    )
      .bind(
        'ready',
        result.domain,
        JSON.stringify({ ...result.profile, notes: result.notes }),
        JSON.stringify(result.pages),
        scanId,
        user.id,
      )
      .run()

    const stmt = c.env.DB.prepare(
      'INSERT INTO segments (id, scan_id, user_id, name, fit_score, rationale, buyer_titles, pain, signal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const inserts = result.segments.map((s) =>
      stmt.bind(
        randomId('seg'),
        scanId,
        user.id,
        s.name,
        s.fit_score,
        s.rationale,
        JSON.stringify(s.buyer_titles),
        s.pain,
        s.signal,
      ),
    )
    if (inserts.length) await c.env.DB.batch(inserts)

    await audit(c.env, user.id, 'scan_completed', { scanId, domain: result.domain }, ip)
    return c.json({ ok: true, scanId, balance: spend.balance })
  } catch (e: any) {
    // Refund: the user paid for an outcome we could not deliver.
    const balance = await refundCredits(c.env, user.id, CREDIT_COSTS.scan, `scan:${scanId}`, {
      reason: String(e?.message || e).slice(0, 200),
    })

    const message =
      e instanceof UrlRejected
        ? e.message
        : e?.code === 'rate_limited'
          ? 'The AI provider is busy. Your credits have been refunded — try again in a minute.'
          : e?.code === 'bad_key'
            ? 'The AI provider rejected the server key. Your credits have been refunded.'
            : 'The scan could not complete. Your credits have been refunded.'

    await c.env.DB.prepare('UPDATE scans SET status = ?, error = ?, completed_at = datetime(\'now\') WHERE id = ? AND user_id = ?')
      .bind('failed', message, scanId, user.id)
      .run()

    await audit(c.env, user.id, 'scan_failed', { scanId, error: String(e?.message || e).slice(0, 300) }, ip)
    return fail(c as Ctx, 422, e?.code || 'scan_failed', message, { balance, refunded: CREDIT_COSTS.scan })
  }
})

/* ---------------------------------------------------------------- *
 * GET /api/scans - history for this user
 * ---------------------------------------------------------------- */
scans.get('/', async (c) => {
  const user = c.get('user')
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.input_url, s.domain, s.status, s.created_at, s.completed_at,
            (SELECT COUNT(*) FROM companies c WHERE c.scan_id = s.id) AS company_count
       FROM scans s WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 30`,
  )
    .bind(user.id)
    .all()
  return c.json({ scans: results ?? [] })
})

/* ---------------------------------------------------------------- *
 * GET /api/scans/:id - full scan detail
 * ---------------------------------------------------------------- */
scans.get('/:id', async (c) => {
  const user = c.get('user')
  const scanId = c.req.param('id')

  const scan = await c.env.DB.prepare('SELECT * FROM scans WHERE id = ? AND user_id = ?')
    .bind(scanId, user.id)
    .first<any>()
  if (!scan) return fail(c as Ctx, 404, 'not_found', 'Scan not found.')

  const segs = await c.env.DB.prepare(
    'SELECT id, name, fit_score, rationale, buyer_titles, pain, signal FROM segments WHERE scan_id = ? AND user_id = ? ORDER BY fit_score DESC',
  )
    .bind(scanId, user.id)
    .all()

  const segments = (segs.results ?? []).map((s: any) => ({
    ...s,
    buyer_titles: JSON.parse(s.buyer_titles || '[]'),
    company_count: 0,
  }))

  const counts = await c.env.DB.prepare(
    'SELECT segment_id, COUNT(*) AS n FROM companies WHERE scan_id = ? AND user_id = ? GROUP BY segment_id',
  )
    .bind(scanId, user.id)
    .all<any>()
  const countMap = new Map((counts.results ?? []).map((r: any) => [r.segment_id, r.n]))
  for (const s of segments) s.company_count = countMap.get(s.id) ?? 0

  return c.json({
    scan: {
      id: scan.id,
      input_url: scan.input_url,
      domain: scan.domain,
      status: scan.status,
      error: scan.error,
      created_at: scan.created_at,
      completed_at: scan.completed_at,
      profile: scan.profile_json ? JSON.parse(scan.profile_json) : null,
      pages: scan.pages_json ? JSON.parse(scan.pages_json) : [],
    },
    segments,
    enrichmentConfigured: enrichmentConfigured(c.env),
  })
})

/* ---------------------------------------------------------------- *
 * GET /api/scans/:id/companies - companies for a segment (or imports)
 * ---------------------------------------------------------------- */
scans.get('/:id/companies', async (c) => {
  const user = c.get('user')
  const scanId = c.req.param('id')
  const segmentId = c.req.query('segmentId') || ''

  const scan = await c.env.DB.prepare('SELECT id FROM scans WHERE id = ? AND user_id = ?')
    .bind(scanId, user.id)
    .first<{ id: string }>()
  if (!scan) return fail(c as Ctx, 404, 'not_found', 'Scan not found.')

  // 'imported' is the sentinel for rows with no segment (imported lists).
  const isImported = segmentId === 'imported'
  const query = isImported
    ? `SELECT id, name, domain, website, location, fit_score, why_fit, verified, source
         FROM companies WHERE scan_id = ? AND user_id = ? AND segment_id IS NULL
        ORDER BY verified DESC, name LIMIT 200`
    : `SELECT id, name, domain, website, location, fit_score, why_fit, verified, source
         FROM companies WHERE scan_id = ? AND user_id = ? AND segment_id = ?
        ORDER BY verified DESC, fit_score DESC, name LIMIT 200`

  const { results } = isImported
    ? await c.env.DB.prepare(query).bind(scanId, user.id).all<any>()
    : await c.env.DB.prepare(query).bind(scanId, user.id, segmentId).all<any>()

  return c.json({ companies: results ?? [] })
})

/* ---------------------------------------------------------------- *
 * POST /api/scans/:id/discover - find companies for a segment
 * ---------------------------------------------------------------- */
scans.post('/:id/discover', async (c) => {
  const user = c.get('user')
  const scanId = c.req.param('id')

  if (!rateLimit(`discover:${user.id}`, 12, 10 * 60_000)) {
    return fail(c as Ctx, 429, 'rate_limited', 'Slow down a moment — discovery is rate limited.')
  }

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return fail(c as Ctx, 400, 'bad_request', 'Invalid request body.')
  }

  const segmentId = str(body?.segmentId, 64)
  const importText = str(body?.importText, 20000)

  const scan = await c.env.DB.prepare('SELECT id, profile_json FROM scans WHERE id = ? AND user_id = ?')
    .bind(scanId, user.id)
    .first<any>()
  if (!scan) return fail(c as Ctx, 404, 'not_found', 'Scan not found.')
  if (!scan.profile_json) return fail(c as Ctx, 409, 'scan_incomplete', 'That scan has not finished.')

  const profile = JSON.parse(scan.profile_json)

  let result: DiscoveryResult
  let segmentName = 'Imported list'

  if (importText.trim()) {
    // Import path: verified with the same gate as AI-proposed companies, but
    // with zero LLM involvement — fully deterministic.
    const parsed = parseImportedCompanies(importText)
    if (parsed.length === 0) {
      return fail(c as Ctx, 400, 'no_companies', 'No valid domains found in that list.')
    }
    const check = await verifyImported(parsed.slice(0, 60))
    result = { verified: check.verified, unverified: check.unverified, notes: check.notes }
  } else {
    if (!segmentId) return fail(c as Ctx, 400, 'missing_segment', 'Pick a segment first.')
    const seg = await c.env.DB.prepare('SELECT * FROM segments WHERE id = ? AND scan_id = ? AND user_id = ?')
      .bind(segmentId, scanId, user.id)
      .first<any>()
    if (!seg) return fail(c as Ctx, 404, 'not_found', 'Segment not found.')

    segmentName = seg.name
    result = await discoverCompanies(c.env, profile, {
      name: seg.name,
      fit_score: seg.fit_score,
      rationale: seg.rationale,
      buyer_titles: JSON.parse(seg.buyer_titles || '[]'),
      pain: seg.pain,
      signal: seg.signal,
      geo_hint: 'unknown',
    })
  }

  const targetSegmentId = importText.trim() ? null : segmentId

  // Upsert rather than duplicate: re-running discovery must not create doubles.
  const stmt = c.env.DB.prepare(
    `INSERT INTO companies (id, scan_id, segment_id, user_id, name, domain, website, location, fit_score, why_fit, evidence_url, source, verified, verify_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scan_id, domain) DO UPDATE SET
       segment_id = COALESCE(excluded.segment_id, companies.segment_id),
       fit_score = excluded.fit_score,
       why_fit = excluded.why_fit,
       verified = excluded.verified,
       verify_note = excluded.verify_note`,
  )

  const baseScore = 70
  const rows = [
    ...result.verified.map((x) => ({ ...x, verified: 1, note: 'live site confirmed', score: baseScore })),
    ...result.unverified.map((x) => ({ ...x, verified: 0, note: 'unverified', score: 40 })),
  ]

  if (rows.length) {
    await c.env.DB.batch(
      rows.map((r) =>
        stmt.bind(
          randomId('cmp'),
          scanId,
          targetSegmentId,
          user.id,
          r.name,
          r.domain,
          `https://${r.domain}`,
          r.location || 'unknown',
          r.score,
          r.why_fit || '',
          r.evidence_url || `https://${r.domain}`,
          importText.trim() ? 'import' : 'ai_proposed',
          r.verified,
          r.note,
        ),
      ),
    )
  }

  await audit(c.env, user.id, 'discover', {
    scanId,
    segment: segmentName,
    verified: result.verified.length,
    unverified: result.unverified.length,
  })

  return c.json({
    ok: true,
    segment: segmentName,
    verified: result.verified.length,
    unverified: result.unverified.length,
    notes: result.notes,
    companies: rows.map((r) => ({
      name: r.name,
      domain: r.domain,
      location: r.location,
      why_fit: r.why_fit,
      verified: !!r.verified,
    })),
  })
})

/* ---------------------------------------------------------------- *
 * POST /api/scans/:id/enrich - paid contact lookup for chosen companies
 * ---------------------------------------------------------------- */
scans.post('/:id/enrich', async (c) => {
  const user = c.get('user')
  const ip = clientIp(c as Ctx)
  const scanId = c.req.param('id')

  if (!rateLimit(`enrich:${user.id}`, 20, 10 * 60_000)) {
    return fail(c as Ctx, 429, 'rate_limited', 'Enrichment is rate limited. Try again shortly.')
  }

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return fail(c as Ctx, 400, 'bad_request', 'Invalid request body.')
  }

  const ids: string[] = Array.isArray(body?.companyIds) ? body.companyIds.slice(0, 25).map((x: any) => str(x, 64)) : []
  const titles: string[] = Array.isArray(body?.titles) ? body.titles.slice(0, 5).map((x: any) => str(x, 120)) : []
  if (ids.length === 0) return fail(c as Ctx, 400, 'no_companies', 'Select at least one company.')

  const scan = await c.env.DB.prepare('SELECT id, profile_json FROM scans WHERE id = ? AND user_id = ?')
    .bind(scanId, user.id)
    .first<any>()
  if (!scan?.profile_json) return fail(c as Ctx, 404, 'not_found', 'Scan not found.')
  const profile = JSON.parse(scan.profile_json)

  const placeholders = ids.map(() => '?').join(',')
  const found = await c.env.DB.prepare(
    `SELECT id, name, domain FROM companies WHERE scan_id = ? AND user_id = ? AND id IN (${placeholders})`,
  )
    .bind(scanId, user.id, ...ids)
    .all<any>()

  const targets = found.results ?? []
  if (targets.length === 0) return fail(c as Ctx, 404, 'not_found', 'None of those companies belong to this scan.')

  const perCompany = CREDIT_COSTS.enrichCompany
  const total = perCompany * targets.length

  const spend = await spendCredits(c.env, user.id, total, 'enrich', `enrich:${scanId}`, {
    companies: targets.length,
  })
  if (!spend.ok) {
    return fail(
      c as Ctx,
      402,
      'insufficient_credits',
      `Enriching ${targets.length} companies costs ${total} credits and you have ${spend.balance}.`,
      { balance: spend.balance, required: total },
    )
  }

  const results: any[] = []
  let failures = 0

  for (const [i, company] of targets.entries()) {
    // Skip companies we never verified — enriching them wastes the user's money.
    const row = await c.env.DB.prepare('SELECT verified, name, domain FROM companies WHERE id = ? AND user_id = ?')
      .bind(company.id, user.id)
      .first<any>()
    if (row && !row.verified) {
      results.push({ company: row.name, domain: row.domain, skipped: 'unverified company', contacts: [] })
      continue
    }

    try {
      const outcome = await enrichContact(
        c.env,
        {
          domain: row?.domain || company.domain,
          title: titles[i % Math.max(1, titles.length)] || undefined,
          company: row?.name || company.name,
          // Providers need a human to look up; without a name we ask the provider
          // for a domain-level match by passing an empty name (handled per-adapter).
        },
        i,
      )

      if (!outcome.contact) {
        results.push({ company: row?.name, domain: row?.domain, contacts: [], note: 'no verified contact found' })
        continue
      }

      const contact = outcome.contact
      const pers = outcome.mock
        ? { line: '', evidence: '', grounded: false }
        : await personalize(c.env, {
            whatTheySell: profile.what_they_sell,
            companyName: row?.name || company.name,
            domain: row?.domain || company.domain,
            contactTitle: contact.title,
          }).catch(() => ({ line: '', evidence: '', grounded: false }))

      const contactId = randomId('ctc')
      await c.env.DB.prepare(
        `INSERT INTO contacts (id, company_id, user_id, full_name, title, email, email_status, linkedin, provider, confidence, personal_line, personal_evidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          contactId,
          company.id,
          user.id,
          contact.full_name,
          contact.title,
          contact.email,
          contact.email_status,
          contact.linkedin ?? null,
          contact.provider,
          contact.confidence,
          pers.line || null,
          pers.evidence || null,
        )
        .run()

      results.push({
        company: row?.name || company.name,
        domain: row?.domain || company.domain,
        contacts: [{ ...contact, personal_line: pers.line, personal_evidence: pers.evidence, grounded: pers.grounded }],
        attempts: outcome.attempts,
        mock: outcome.mock,
      })
    } catch (e: any) {
      failures++
      results.push({
        company: row?.name || company.name,
        domain: row?.domain || company.domain,
        contacts: [],
        error: String(e?.message || e).slice(0, 200),
      })
    }
  }

  // Refund the companies that produced nothing — charge only for delivered work.
  const delivered = results.filter((r) => r.contacts && r.contacts.length > 0).length
  const undelivered = targets.length - delivered
  let balance = spend.balance
  if (undelivered > 0) {
    balance = await refundCredits(c.env, user.id, undelivered * perCompany, `enrich:${scanId}`, {
      reason: 'no contact delivered',
      count: undelivered,
    })
  }

  await audit(c.env, user.id, 'enrich', { scanId, delivered, undelivered, failures }, ip)
  return c.json({ ok: true, results, delivered, balance, mock: results.some((r) => r.mock) })
})

/* ---------------------------------------------------------------- *
 * GET /api/scans/:id/export - CSV of contacts
 * ---------------------------------------------------------------- */
scans.get('/:id/export', async (c) => {
  const user = c.get('user')
  const scanId = c.req.param('id')

  const rows = await c.env.DB.prepare(
    `SELECT c.name AS company, c.domain, c.location, ct.full_name, ct.title, ct.email,
            ct.email_status, ct.provider, ct.confidence, ct.personal_line, ct.personal_evidence
       FROM companies c JOIN contacts ct ON ct.company_id = c.id
      WHERE c.scan_id = ? AND c.user_id = ? AND ct.user_id = ?
      ORDER BY c.name`,
  )
    .bind(scanId, user.id, user.id)
    .all<any>()

  const data = rows.results ?? []
  const header = [
    'company',
    'domain',
    'location',
    'full_name',
    'title',
    'email',
    'email_status',
    'provider',
    'confidence',
    'personal_line',
    'personal_evidence',
  ]

  const lines = [header.join(',')]
  for (const r of data) {
    lines.push(
      [
        r.company,
        r.domain,
        r.location,
        r.full_name,
        r.title,
        r.email,
        r.email_status,
        r.provider,
        r.confidence,
        r.personal_line,
        r.personal_evidence,
      ]
        .map(csvCell)
        .join(','),
    )
  }

  await audit(c.env, user.id, 'export_csv', { scanId, rows: data.length })

  c.header('content-type', 'text/csv; charset=utf-8')
  c.header('content-disposition', `attachment; filename="nectary-${scanId}.csv"`)
  return c.body(lines.join('\r\n'))
})

export default scans
