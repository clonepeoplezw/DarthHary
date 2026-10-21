import type { Env, EnrichedContact } from '../types'

/**
 * Enrichment waterfall.
 *
 * Cost logic, which is the whole reason this file exists:
 *   providers are tried cheapest-first and we STOP at the first verified result.
 *   A single-provider lookup verifies maybe 40% of the time; a 3-step waterfall
 *   lands ~60-80% for not much more money, because most hits cost exactly one call.
 *
 * Honesty rule: if we cannot verify, we return the provider's status verbatim
 * ('guessed' / 'unknown'). We never upgrade a guess to 'verified' and we never
 * let the LLM write the address.
 */

export interface EnrichRequest {
  domain: string
  firstName?: string
  lastName?: string
  fullName?: string
  title?: string
  company?: string
}

export interface EnrichOutcome {
  contact: EnrichedContact | null
  /** Every provider attempt, for the audit trail. */
  attempts: { provider: string; result: string; ms: number }[]
  /** True when the only result came from the mock adapter. */
  mock: boolean
}

const TIMEOUT = 12_000

function splitName(req: EnrichRequest): { first: string; last: string } {
  if (req.firstName || req.lastName) {
    return { first: req.firstName || '', last: req.lastName || '' }
  }
  const parts = (req.fullName || '').trim().split(/\s+/)
  if (parts.length === 0) return { first: '', last: '' }
  if (parts.length === 1) return { first: parts[0], last: '' }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) && email.length < 254
}

function domainMatches(email: string, domain: string): boolean {
  const emailDomain = email.split('@')[1]?.toLowerCase().replace(/^www\./, '') || ''
  const d = domain.toLowerCase().replace(/^www\./, '')
  return emailDomain === d
}

/* ------------------------------------------------------------------ *
 * Icypeas - cheapest tier, our default first hop.
 * ------------------------------------------------------------------ */
async function tryIcypeas(env: Env, req: EnrichRequest): Promise<EnrichedContact | null> {
  if (!env.ICYPEAS_API_KEY) return null
  const { first, last } = splitName(req)
  if (!first || !last) return null

  const res = await fetch('https://app.icypeas.com/api/email-search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: env.ICYPEAS_API_KEY,
    },
    body: JSON.stringify({
      firstname: first,
      lastname: last,
      domainOrCompany: req.domain,
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  })

  if (!res.ok) throw new Error(`icypeas ${res.status}`)
  const data: any = await res.json()
  const item = data?.item ?? data?.results?.[0]
  const email = item?.email?.[0]?.email || item?.email
  if (!email || typeof email !== 'string' || !isValidEmail(email)) return null
  if (!domainMatches(email, req.domain)) return null

  const verified = String(item?.email?.[0]?.certainty || item?.certainty || '').toLowerCase()
  return {
    full_name: `${first} ${last}`.trim(),
    title: req.title || item?.job || '',
    email,
    email_status: verified === 'ultra' || verified === 'very_high' ? 'verified' : 'guessed',
    linkedin: item?.linkedin || undefined,
    provider: 'icypeas',
    confidence: verified === 'ultra' ? 95 : verified === 'very_high' ? 85 : 60,
  }
}

/* ------------------------------------------------------------------ *
 * Prospeo - stronger data quality, second hop.
 * ------------------------------------------------------------------ */
async function tryProspeo(env: Env, req: EnrichRequest): Promise<EnrichedContact | null> {
  if (!env.PROSPEO_API_KEY) return null
  const { first, last } = splitName(req)
  if (!first || !last) return null

  const res = await fetch('https://api.prospeo.io/email-finder', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-KEY': env.PROSPEO_API_KEY,
    },
    body: JSON.stringify({
      first_name: first,
      last_name: last,
      company: req.domain,
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  })

  if (!res.ok) throw new Error(`prospeo ${res.status}`)
  const data: any = await res.json()
  const email = data?.response?.email
  if (!email || typeof email !== 'string' || !isValidEmail(email)) return null
  if (!domainMatches(email, req.domain)) return null

  return {
    full_name: `${first} ${last}`.trim(),
    title: req.title || data?.response?.job_title || '',
    email,
    email_status: data?.response?.email_status === 'VERIFIED' ? 'verified' : 'guessed',
    linkedin: data?.response?.linkedin_url || undefined,
    provider: 'prospeo',
    confidence: data?.response?.email_status === 'VERIFIED' ? 90 : 60,
  }
}

/* ------------------------------------------------------------------ *
 * Hunter - the familiar fallback.
 * ------------------------------------------------------------------ */
async function tryHunter(env: Env, req: EnrichRequest): Promise<EnrichedContact | null> {
  if (!env.HUNTER_API_KEY) return null
  const { first, last } = splitName(req)
  const params = new URLSearchParams({ domain: req.domain, api_key: env.HUNTER_API_KEY })
  if (first) params.set('first_name', first)
  if (last) params.set('last_name', last)

  const res = await fetch(`https://api.hunter.io/v2/email-finder?${params.toString()}`, {
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`hunter ${res.status}`)

  const data: any = await res.json()
  const d = data?.data
  if (!d?.email || !isValidEmail(d.email)) return null
  if (!domainMatches(d.email, req.domain)) return null

  return {
    full_name: [d.first_name, d.last_name].filter(Boolean).join(' ') || `${first} ${last}`.trim(),
    title: req.title || d.position || '',
    email: d.email,
    email_status: d.verification?.status === 'valid' ? 'verified' : 'guessed',
    linkedin: d.linkedin || undefined,
    provider: 'hunter',
    confidence: d.score ?? 50,
  }
}

/* ------------------------------------------------------------------ *
 * Mock adapter - so the product is demoable with zero provider keys,
 * and so the UI/tests never depend on live third-party state.
 * Every mock result is labelled as such and can never be exported as real.
 * ------------------------------------------------------------------ */
const MOCK_TITLES = [
  'Head of Procurement',
  'Operations Director',
  'Owner',
  'Marketing Manager',
  'Events Director',
]

// Varied so demo output doesn't look like one repeated placeholder person.
const MOCK_PEOPLE = [
  { first: 'Rachel', last: 'Whitfield' },
  { first: 'Dana', last: 'Okafor' },
  { first: 'Mia', last: 'Castellanos' },
  { first: 'Julian', last: 'Delaney' },
  { first: 'Priya', last: 'Raman' },
  { first: 'Tomas', last: 'Berger' },
  { first: 'Nadia', last: 'Haddad' },
  { first: 'Elliot', last: 'Park' },
]

function mockContact(req: EnrichRequest, seedIndex: number): EnrichedContact {
  const given = splitName(req)
  const person = MOCK_PEOPLE[seedIndex % MOCK_PEOPLE.length]
  const fn = given.first || person.first
  const ln = given.last || person.last
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
  return {
    full_name: `${fn} ${ln}`,
    title: req.title || MOCK_TITLES[seedIndex % MOCK_TITLES.length],
    email: `${slug(fn)}.${slug(ln)}@${req.domain.replace(/^www\./, '')}`,
    email_status: 'mock',
    provider: 'mock',
    confidence: 0,
  }
}

export async function enrichContact(env: Env, req: EnrichRequest, mockIndex = 0): Promise<EnrichOutcome> {
  const attempts: { provider: string; result: string; ms: number }[] = []
  const waterfall: { name: string; fn: (e: Env, r: EnrichRequest) => Promise<EnrichedContact | null> }[] = [
    { name: 'icypeas', fn: tryIcypeas },
    { name: 'prospeo', fn: tryProspeo },
    { name: 'hunter', fn: tryHunter },
  ]

  const anyConfigured = waterfall.some((w) => {
    if (w.name === 'icypeas') return !!env.ICYPEAS_API_KEY
    if (w.name === 'prospeo') return !!env.PROSPEO_API_KEY
    return !!env.HUNTER_API_KEY
  })

  if (!anyConfigured) {
    return { contact: mockContact(req, mockIndex), attempts: [{ provider: 'mock', result: 'demo', ms: 0 }], mock: true }
  }

  for (const { name, fn } of waterfall) {
    const t0 = Date.now()
    try {
      const contact = await fn(env, req)
      const ms = Date.now() - t0
      if (contact) {
        attempts.push({ provider: name, result: contact.email_status, ms })
        // Stop at the first VERIFIED hit. A 'guessed' result is a weak reason to
        // stop, but a stronger provider later may still verify — so we continue
        // and prefer verified over guessed at the end.
        if (contact.email_status === 'verified') {
          return { contact, attempts, mock: false }
        }
        // Remember the guess but keep walking the waterfall for a verification.
        const rest = await continueAfterGuess(env, waterfall.slice(waterfall.findIndex((w) => w.name === name) + 1), req, contact, attempts)
        return { contact: rest, attempts, mock: false }
      }
      attempts.push({ provider: name, result: 'no_match', ms })
    } catch (e: any) {
      attempts.push({ provider: name, result: `error: ${String(e?.message || e).slice(0, 80)}`, ms: Date.now() - t0 })
      // Provider failure must not abort the waterfall - that's the point of a waterfall.
    }
  }

  return { contact: null, attempts, mock: false }
}

async function continueAfterGuess(
  env: Env,
  remaining: { name: string; fn: (e: Env, r: EnrichRequest) => Promise<EnrichedContact | null> }[],
  req: EnrichRequest,
  guess: EnrichedContact,
  attempts: { provider: string; result: string; ms: number }[],
): Promise<EnrichedContact> {
  for (const { name, fn } of remaining) {
    const t0 = Date.now()
    try {
      const c = await fn(env, req)
      const ms = Date.now() - t0
      if (c) {
        attempts.push({ provider: name, result: c.email_status, ms })
        if (c.email_status === 'verified') return c
        return c.confidence > guess.confidence ? c : guess
      }
      attempts.push({ provider: name, result: 'no_match', ms })
    } catch (e: any) {
      attempts.push({ provider: name, result: `error: ${String(e?.message || e).slice(0, 80)}`, ms: Date.now() - t0 })
    }
  }
  return guess
}

export function enrichmentConfigured(env: Env): boolean {
  return !!(env.ICYPEAS_API_KEY || env.PROSPEO_API_KEY || env.HUNTER_API_KEY)
}
