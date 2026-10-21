import { safeFetch, validateUrl, UrlRejected } from './ssrf'
import type { PageRead } from '../types'

/**
 * HTML -> usable text. No DOM parser is available in Workers, so this is a
 * deliberate, conservative regex pass. It is only ever used to feed an LLM
 * (never to render), so the failure mode of "slightly messy text" is fine.
 */

const BLOCK_TAGS = /<\/(p|div|section|article|li|tr|h[1-6]|header|footer|blockquote|br)>/gi

export function htmlToText(html: string): string {
  let s = html
  // Drop content that never helps and often hurts: scripts, styles, svg, forms, noscript.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')

  s = s.replace(BLOCK_TAGS, '\n')
  s = s.replace(/<[^>]+>/g, ' ')

  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '-')
    .replace(/&ndash;/gi, '-')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))

  s = s.replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

export function pageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? htmlToText(m[1]).slice(0, 200) : ''
}

export function metaDescription(html: string): string {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)
  return m ? m[1].trim().slice(0, 500) : ''
}

/** Trim to a character budget on a word boundary so prompts stay bounded. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max * 0.8 ? cut.slice(0, lastSpace) : cut) + ' ...'
}

const CANDIDATE_PATHS = [
  '/',
  '/about',
  '/about-us',
  '/services',
  '/what-we-do',
  '/solutions',
  '/products',
  '/pricing',
  '/clients',
  '/case-studies',
  '/industries',
]

/** Pull internal same-origin links that look like they describe the business. */
export function discoverInternalLinks(html: string, base: URL): string[] {
  const wanted = /(about|service|solution|product|pricing|industr|client|case-stud|who-we|what-is)/i
  const found = new Set<string>()
  const re = /<a\b[^>]+href=["']([^"'#]+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const href = m[1]
    try {
      const u = new URL(href, base)
      if (u.hostname !== base.hostname) continue
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
      if (!wanted.test(u.pathname)) continue
      if (/\.(pdf|jpg|jpeg|png|gif|svg|webp|zip|docx?|xlsx?)$/i.test(u.pathname)) continue
      u.hash = ''
      u.search = ''
      found.add(u.toString())
    } catch {
      /* ignore malformed hrefs */
    }
  }
  return [...found].slice(0, 6)
}

export interface CrawlResult {
  domain: string
  baseUrl: string
  pages: { url: string; title: string; text: string; description: string }[]
  reads: PageRead[]
  notes: string[]
}

/**
 * Read the homepage, then up to `maxExtra` business-descriptive pages.
 * Sequential rather than parallel: keeps us a polite crawler and keeps the
 * subrequest count predictable on Workers.
 */
export async function crawlSite(inputUrl: string, maxExtra = 3): Promise<CrawlResult> {
  const base = validateUrl(inputUrl)
  const notes: string[] = []
  const reads: PageRead[] = []
  const pages: CrawlResult['pages'] = []

  const home = await safeFetch(base.toString(), { timeoutMs: 9000 })
  reads.push({ url: home.url, status: home.status, bytes: home.bytes, title: pageTitle(home.body) })

  if (home.status >= 400) {
    throw new UrlRejected('unreachable', `The site returned HTTP ${home.status}.`)
  }
  if (!home.body) {
    throw new UrlRejected('no_html', 'That URL did not return a readable HTML page.')
  }

  const homeText = htmlToText(home.body)
  if (homeText.length < 120) {
    notes.push('The homepage had almost no readable text (likely a JavaScript-only app).')
  }

  pages.push({
    url: home.url,
    title: pageTitle(home.body),
    description: metaDescription(home.body),
    text: clip(homeText, 9000),
  })

  // Prefer links actually present on the page; fall back to conventional paths.
  const linked = discoverInternalLinks(home.body, new URL(home.url))
  const fallback = CANDIDATE_PATHS.slice(1).map((p) => new URL(p, home.url).toString())
  const targets = [...new Set([...linked, ...fallback])].slice(0, maxExtra)

  for (const target of targets) {
    if (pages.length >= maxExtra + 1) break
    try {
      const r = await safeFetch(target, { timeoutMs: 7000 })
      if (r.status >= 400 || !r.body) continue
      const title = pageTitle(r.body)
      const text = htmlToText(r.body)
      // Skip near-duplicate pages (404 pages that return 200, JS shells, etc.)
      if (text.length < 200) continue
      if (pages.some((p) => p.text.slice(0, 400) === text.slice(0, 400))) continue
      reads.push({ url: r.url, status: r.status, bytes: r.bytes, title })
      pages.push({ url: r.url, title, description: metaDescription(r.body), text: clip(text, 6000) })
    } catch {
      notes.push(`Could not read ${target.split('/').slice(3).join('/') || '/'}`)
    }
  }

  return { domain: base.hostname.replace(/^www\./, ''), baseUrl: home.url, pages, reads, notes }
}
