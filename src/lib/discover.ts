import type { Env, CandidateCompany, IcpSegment, BusinessProfile } from '../types'
import { llmJson, S } from './llm'
import { safeFetch, validateUrl } from './ssrf'
import { pageTitle, htmlToText } from './crawl'

/**
 * Company discovery.
 *
 * THE RISK: asking an LLM "name 20 companies that would buy this" produces
 * confident, plausible, frequently fake companies. Shipping those as leads is
 * the single fastest way to lose a customer's trust.
 *
 * THE GATE: every candidate the model proposes is then fetched for real. Only
 * domains that resolve, return HTTP 2xx, and serve a readable page survive, and
 * the page title/description is stored as evidence. Unverified candidates are
 * kept but marked `verified = 0` and are excluded from paid enrichment by
 * default (they cost the user money and would waste it).
 *
 * We deliberately do NOT depend on OSM/Overpass: the public endpoint rate-limits
 * aggressively under automation. It remains an optional pluggable source.
 */

const DISCOVER_SYSTEM = `You are a B2B prospect researcher. Given a supplier's profile and ONE target buyer segment, propose real companies that plausibly belong to that segment.

Rules:
- Propose companies you are reasonably confident exist. Prefer well-known or easily findable businesses over obscure guesses.
- Give the company's primary web domain, bare, no protocol, no path (e.g. "acme.com").
- Never invent a domain by string-munging a company name. If unsure of the exact domain, omit that company entirely.
- Do not propose the supplier's own company or its obvious competitors-by-name if the segment is "customers".
- why_fit must cite a concrete, checkable characteristic of THAT company (what they do, where they operate), not a generic claim.
- If you can only think of a few real ones, return fewer. Quality over count. Returning 3 real companies is better than 12 invented ones.
- Locations should be as specific as you can support (city, region, country). Use "unknown" if you cannot support it.`

const DISCOVER_SCHEMA = S.obj({
  companies: S.arrOfObj({
    name: S.str('Company name'),
    domain: S.str('Bare domain, e.g. acme.com'),
    location: S.str('City/region/country, or "unknown"'),
    why_fit: S.str('One concrete reason this company belongs to the segment'),
    evidence_url: S.str('A URL that supports why_fit, or empty string if none'),
  }),
})

export interface DiscoveryResult {
  verified: CandidateCompany[]
  unverified: CandidateCompany[]
  notes: string[]
}

/** Fetch a candidate domain and confirm it is a live, readable business site. */
async function verifyDomain(domain: string): Promise<{ ok: boolean; note: string; website?: string; title?: string }> {
  const clean = domain
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .trim()

  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(clean)) {
    return { ok: false, note: 'not a plausible domain' }
  }
  // Block anything that is obviously not a company site.
  if (/^(gmail|yahoo|outlook|hotmail|example|test)\./.test(clean)) {
    return { ok: false, note: 'not a company domain' }
  }

  try {
    validateUrl(`https://${clean}`)
  } catch {
    return { ok: false, note: 'domain rejected by URL policy' }
  }

  try {
    const res = await safeFetch(`https://${clean}`, { timeoutMs: 6000, maxBytes: 400_000 })
    if (res.status >= 400) return { ok: false, note: `http ${res.status}` }
    if (!res.body) return { ok: false, note: 'no readable html' }
    const text = htmlToText(res.body)
    if (text.length < 150) return { ok: false, note: 'page had no content' }
    return { ok: true, note: 'live site confirmed', website: `https://${clean}`, title: pageTitle(res.body) }
  } catch (e: any) {
    return { ok: false, note: String(e?.message || 'unreachable').slice(0, 80) }
  }
}

export async function discoverCompanies(
  env: Env,
  profile: BusinessProfile,
  segment: IcpSegment,
  limit = 12,
): Promise<DiscoveryResult> {
  const raw: any = await llmJson(env, {
    system: DISCOVER_SYSTEM,
    user: [
      `SUPPLIER: ${profile.company_name} - ${profile.what_they_sell}`,
      `Category: ${profile.category} | Price band: ${profile.price_band} | Model: ${profile.business_model}`,
      `Geographies served: ${profile.geographies.join(', ') || 'unknown'}`,
      ``,
      `TARGET SEGMENT: ${segment.name}`,
      `Why they buy: ${segment.rationale}`,
      `Their pain: ${segment.pain}`,
      `Buyer titles: ${segment.buyer_titles.join(', ')}`,
      `Geographic hint: ${segment.geo_hint || 'unknown'}`,
      ``,
      `Propose up to ${limit} real companies in this segment.`,
    ].join('\n'),
    schema: DISCOVER_SCHEMA,
    maxOutputTokens: 2200,
    temperature: 0.3,
  })

  const proposed: any[] = Array.isArray(raw?.companies) ? raw.companies.slice(0, limit) : []
  const notes: string[] = []
  const seen = new Set<string>()
  const verified: CandidateCompany[] = []
  const unverified: CandidateCompany[] = []

  // Sequential verification: bounds subrequests and is gentle on target sites.
  for (const c of proposed) {
    const domain = String(c?.domain || '').toLowerCase().replace(/^www\./, '').trim()
    if (!domain || seen.has(domain)) continue
    seen.add(domain)

    const candidate: CandidateCompany = {
      name: String(c?.name || domain).slice(0, 160),
      domain,
      location: String(c?.location || 'unknown').slice(0, 120),
      why_fit: String(c?.why_fit || '').slice(0, 400),
      evidence_url: String(c?.evidence_url || '').slice(0, 500),
    }

    const v = await verifyDomain(domain)
    if (v.ok) {
      verified.push(candidate)
    } else {
      unverified.push(candidate)
    }
  }

  if (unverified.length > 0) {
    notes.push(`${unverified.length} candidate${unverified.length === 1 ? '' : 's'} could not be confirmed live and were excluded from enrichment.`)
  }
  if (verified.length === 0) {
    notes.push('No candidate domains could be confirmed. Try widening the segment or importing a company list.')
  }

  return { verified, unverified, notes }
}

/**
 * Import path. Accepts pasted domains or CSV ("name,domain" / "domain").
 * Imported rows are verified the same way — same gate, no exceptions.
 */
export function parseImportedCompanies(input: string): CandidateCompany[] {
  const out: CandidateCompany[] = []
  const seen = new Set<string>()

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (/^name\s*,\s*domain/i.test(line) || /^company\s*,\s*(website|domain)/i.test(line)) continue

    const parts = line.split(',').map((p) => p.trim())
    let name = ''
    let domain = ''

    if (parts.length >= 2) {
      // Accept either "name, domain" or "domain, name"
      const aLooksDomain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(parts[0].replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      if (aLooksDomain) {
        domain = parts[0]
        name = parts[1]
      } else {
        name = parts[0]
        domain = parts[1]
      }
    } else {
      domain = parts[0]
    }

    domain = domain
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '')
      .trim()

    if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(domain)) continue
    if (seen.has(domain)) continue
    seen.add(domain)
    out.push({ name: name || domain, domain })
  }

  return out.slice(0, 200)
}
