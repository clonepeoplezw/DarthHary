import type { BusinessProfile, IcpSegment, CandidateCompany, Env } from '../types'
import { llmJson, S, LlmError, debugShape } from './llm'
import { crawlSite, clip } from './crawl'
import { asStr, asStrArray, asInt, pickArray } from './coerce'

/**
 * The scan pipeline: site -> business profile -> ICP segments.
 *
 * Anti-hallucination rule enforced here:
 *   The model may only describe the business using the text we fetched.
 *   Every profile field must be traceable to a page we actually read, and we
 *   check its `evidence_urls` against the crawl set before storing.
 */

const PROFILE_SYSTEM = `You are a B2B market analyst. You are given the text of pages scraped from a company's own website.

Your job is to describe what this business sells, to whom, and at what price point - using ONLY the supplied text.

Hard rules:
- Do not invent facts. If the text does not say something, leave it out rather than guessing.
- Do not guess revenue, headcount, or founding year unless explicitly written.
- "what_they_sell" must be one sentence, concrete, and in the company's own words where possible.
- "business_model" is one of: b2b_saas, b2b_services, agency, wholesale, manufacturing, marketplace, ecommerce_dtc, nonprofit, other.
- "price_band" is one of: budget, mid, premium, enterprise, unknown.
- evidence_urls: list only URLs from the provided page list that support your description.
- confidence is 0-100 and reflects how much usable text you actually had. A thin or JS-only page should score low.`

const PROFILE_SCHEMA = S.obj({
  company_name: S.str('The business name as written on the site'),
  what_they_sell: S.str('One concrete sentence describing the core offering'),
  category: S.str('Short category label, e.g. "wholesale silk florals", "B2B payroll software"'),
  business_model: S.str('One of the allowed business_model values'),
  price_band: S.str('One of: budget, mid, premium, enterprise, unknown'),
  geographies: S.arrOfStr('Markets or regions they serve, as stated on the site'),
  differentiators: S.arrOfStr('Specific claims that differentiate them, taken from the text'),
  keywords: S.arrOfStr('6-12 search terms a buyer would use to find this kind of supplier'),
  evidence_urls: S.arrOfStr('URLs from the provided page list that support the above'),
  confidence: S.int('0-100, how well the fetched text supported this description'),
})

const SEGMENTS_SYSTEM = `You are a B2B demand strategist. Given a supplier's business profile, identify the customer segments most likely to buy from them.

Rules:
- Each segment must be a coherent group of BUYERS, not a list of individual companies.
- fit_score is 0-100: how strong the commercial fit is given the supplier's actual offering and price band.
- buyer_titles must be real job titles that exist at that kind of buyer (e.g. "Head of Procurement", "Owner", "Events Director"). Never invent a person's name.
- pain must name a concrete operational or financial pain that this supplier's offer relieves.
- signal must be an observable, checkable trigger that indicates the buyer is in-market now (e.g. "opened a second location", "hiring a procurement lead"). Do not invent company-specific news.
- Return between 3 and 5 segments, ordered by fit_score descending.
- Be specific. "SMBs" is a useless segment; "Boutique hotels running 50-200 rooms with in-house event spaces" is useful.`

const SEGMENTS_SCHEMA = S.obj({
  segments: S.arrOfObj({
    name: S.str('Segment name, specific enough to target'),
    fit_score: S.int('0-100'),
    rationale: S.str('Two sentences on why this segment buys from this supplier'),
    buyer_titles: S.arrOfStr('3-6 real job titles'),
    pain: S.str('The concrete pain this supplier relieves'),
    signal: S.str('An observable buying trigger'),
    geo_hint: S.str('Where these buyers are concentrated, if inferable; otherwise "unknown"'),
  }),
})

export interface ScanInput {
  url: string
  /** Optional user refinement, e.g. "I only want US customers" */
  focus?: string
}

export interface ScanResult {
  profile: BusinessProfile
  segments: IcpSegment[]
  pages: { url: string; title: string }[]
  notes: string[]
  domain: string
}

function normaliseHost(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

export async function runScan(env: Env, input: ScanInput): Promise<ScanResult> {
  const crawl = await crawlSite(input.url, 3)
  const notes = [...crawl.notes]

  if (crawl.pages.length === 0) {
    throw new LlmError('no_content', 'We could not read any content from that site.', false)
  }

  const corpus = crawl.pages
    .map((p, i) => `--- PAGE ${i + 1}: ${p.url}\nTITLE: ${p.title}\nDESCRIPTION: ${p.description}\n\n${p.text}`)
    .join('\n\n')
    .slice(0, 24000)

  const profileRaw: any = await llmJson(env, {
    system: PROFILE_SYSTEM,
    user: `PAGES FETCHED:\n${crawl.pages.map((p) => p.url).join('\n')}\n\nSITE CONTENT:\n${corpus}`,
    schema: PROFILE_SCHEMA,
    maxOutputTokens: 1600,
    temperature: 0.1,
  })

  debugShape('profile', profileRaw)

  // Evidence check: only keep URLs we actually fetched.
  const fetchedHosts = new Set(crawl.pages.map((p) => normaliseHost(p.url)))
  const evidence = asStrArray(profileRaw?.evidence_urls, 8, 500).filter((u) => fetchedHosts.has(normaliseHost(u)))
  if (evidence.length === 0) {
    notes.push('The model cited no verifiable page, so the profile is marked lower confidence.')
  }

  const profile: BusinessProfile = {
    company_name: asStr(profileRaw?.company_name, 200, crawl.domain),
    what_they_sell: asStr(profileRaw?.what_they_sell, 600),
    category: asStr(profileRaw?.category, 160, 'unknown'),
    business_model: asStr(profileRaw?.business_model, 40, 'other'),
    price_band: asStr(profileRaw?.price_band, 40, 'unknown'),
    geographies: asStrArray(profileRaw?.geographies, 8, 80),
    differentiators: asStrArray(profileRaw?.differentiators, 8, 240),
    keywords: asStrArray(profileRaw?.keywords, 12, 80),
    evidence_urls: evidence.slice(0, 6),
    confidence: asInt(profileRaw?.confidence, 0, 100, 0),
  }

  const segRaw: any = await llmJson(env, {
    system: SEGMENTS_SYSTEM,
    user: [
      `SUPPLIER PROFILE`,
      `Name: ${profile.company_name}`,
      `Sells: ${profile.what_they_sell}`,
      `Category: ${profile.category}`,
      `Model: ${profile.business_model}`,
      `Price band: ${profile.price_band}`,
      `Geographies: ${profile.geographies.join(', ') || 'unknown'}`,
      `Differentiators: ${profile.differentiators.join('; ') || 'none stated'}`,
      `Keywords: ${profile.keywords.join(', ')}`,
      input.focus ? `\nUSER FOCUS / CONSTRAINT: ${clip(input.focus, 600)}` : '',
    ].join('\n'),
    schema: SEGMENTS_SCHEMA,
    maxOutputTokens: 2400,
    temperature: 0.35,
  })

  debugShape('segments', segRaw)

  // Tolerate shape drift: a bare array, or a single alternative wrapper key.
  const rawList = pickArray(segRaw, ['segments', 'buyer_segments', 'data', 'results'])

  const segments: IcpSegment[] = rawList
    .slice(0, 5)
    .map((s: any) => ({
      name: asStr(s?.name, 200, 'Untitled segment'),
      fit_score: asInt(s?.fit_score, 0, 100, 0),
      rationale: asStr(s?.rationale, 800),
      buyer_titles: asStrArray(s?.buyer_titles, 8, 120),
      pain: asStr(s?.pain, 500),
      signal: asStr(s?.signal, 500),
      geo_hint: asStr(s?.geo_hint, 120, 'unknown'),
    }))
    .sort((a, b) => b.fit_score - a.fit_score)

  if (segments.length === 0) {
    throw new LlmError('no_segments', 'The model could not identify any buyer segments for this site.', true)
  }

  return {
    profile,
    segments,
    pages: crawl.pages.map((p) => ({ url: p.url, title: p.title })),
    notes,
    domain: crawl.domain,
  }
}
