/**
 * URL validation + safe outbound fetch.
 *
 * Threat model: a user pastes a URL and we fetch it server-side. Without guards
 * this is a free internal-network proxy / cloud-metadata reader (SSRF).
 *
 * Layers here:
 *   1. scheme allow-list (http/https only)
 *   2. no embedded credentials
 *   3. hostname deny-list (localhost, .local, .internal, metadata hosts)
 *   4. IP-literal private/reserved range rejection
 *   5. DNS pre-resolution via DoH, rejecting any private/reserved answer
 *   6. manual redirect following with re-validation on EVERY hop
 *   7. timeout + response size cap + content-type sanity
 *
 * Residual risk (documented honestly): DNS rebinding between our DoH lookup and
 * the platform's actual connect. Cloudflare Workers cannot pin a resolved IP, so
 * this cannot be fully closed in-process. Mitigations that do apply: Workers
 * cannot reach RFC1918 space on the platform edge, redirects are re-checked,
 * and bodies are size-capped. If you later run this off-Workers, put it behind
 * an egress proxy that also enforces the same deny-list.
 */

const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home', '.corp']
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  '169.254.169.254',
])

export class UrlRejected extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10/8
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 192 && b === 0) return true // 192.0.0/24 + 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

function isPrivateIPv6(raw: string): boolean {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, '')
  if (ip === '::' || ip === '::1') return true
  if (ip.startsWith('fe80') || ip.startsWith('fc') || ip.startsWith('fd')) return true // link-local + ULA
  if (ip.startsWith('ff')) return true // multicast
  // IPv4-mapped (::ffff:127.0.0.1)
  const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIPv4(mapped[1])
  return false
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

/** Validate syntax + hostname policy. Does NOT resolve DNS. */
export function validateUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new UrlRejected('invalid_url', 'That does not look like a valid URL.')
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UrlRejected('bad_scheme', 'Only http and https URLs are supported.')
  }
  if (u.username || u.password) {
    throw new UrlRejected('credentials_in_url', 'URLs with embedded credentials are not allowed.')
  }

  const host = u.hostname.toLowerCase()
  if (!host) throw new UrlRejected('no_host', 'URL has no hostname.')
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new UrlRejected('blocked_host', 'That host is not allowed.')
  }
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UrlRejected('blocked_host', 'Internal hosts are not allowed.')
  }
  if (host === '0.0.0.0' || host === '[::]') {
    throw new UrlRejected('blocked_host', 'That host is not allowed.')
  }

  if (IPV4_RE.test(host) && isPrivateIPv4(host)) {
    throw new UrlRejected('private_ip', 'Private and reserved IP ranges are not allowed.')
  }
  if (host.includes(':') && isPrivateIPv6(host)) {
    throw new UrlRejected('private_ip', 'Private and reserved IP ranges are not allowed.')
  }

  return u
}

/** Resolve via DNS-over-HTTPS and reject if any answer is private/reserved. */
async function assertPublicDns(hostname: string): Promise<void> {
  if (IPV4_RE.test(hostname)) return
  if (hostname.startsWith('[') || hostname.includes(':')) return // IPv6 literal already checked

  const kinds = ['A', 'AAAA']
  for (const type of kinds) {
    let res: Response
    try {
      res = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
        { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) },
      )
    } catch {
      // Do not fail open on a resolver outage for the *first* hop only; caller decides.
      throw new UrlRejected('dns_unavailable', 'Could not resolve that domain right now.')
    }
    if (!res.ok) continue
    const data: any = await res.json().catch(() => null)
    const answers: any[] = data?.Answer || []
    for (const a of answers) {
      // Only inspect answers of the family we asked for. A type=A response can
      // also carry CNAME records (e.g. "x.cdn.cloudflare.net"), and those are
      // hostnames, not addresses — checking them as IPs wrongly rejects every
      // CDN-fronted domain.
      const answerType = Number(a.type)
      if (answerType !== 1 && answerType !== 28) continue

      const value = String(a.data || '').trim()
      if (type === 'A' && IPV4_RE.test(value) && isPrivateIPv4(value)) {
        throw new UrlRejected('private_ip', 'That domain resolves to a private address.')
      }
      if (type === 'AAAA' && value.includes(':') && isPrivateIPv6(value)) {
        throw new UrlRejected('private_ip', 'That domain resolves to a private address.')
      }
    }
    if (answers.some((a) => Number(a.type) === 1 || Number(a.type) === 28)) return
  }
}

const MAX_BYTES = 2_000_000
const MAX_REDIRECTS = 3

async function readCapped(res: Response, cap = MAX_BYTES): Promise<string> {
  const len = Number(res.headers.get('content-length') || 0)
  if (len && len > cap) throw new UrlRejected('too_large', 'That page is too large to read.')
  if (!res.body) return ''

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < cap) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.byteLength
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
  }

  const buf = new Uint8Array(Math.min(total, cap))
  let off = 0
  for (const c of chunks) {
    const take = Math.min(c.byteLength, buf.byteLength - off)
    if (take <= 0) break
    buf.set(c.subarray(0, take), off)
    off += take
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf)
}

export interface SafeFetchResult {
  url: string
  status: number
  body: string
  contentType: string
  bytes: number
}

/** Fetch a user-supplied URL with SSRF guards, manual redirects, timeout, size cap. */
export async function safeFetch(rawUrl: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 8000
  const maxBytes = opts.maxBytes ?? MAX_BYTES

  let current = validateUrl(rawUrl)
  await assertPublicDns(current.hostname)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': 'NectaryBot/0.1 (+https://nectary.app/bot)',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'accept-language': 'en',
      },
    })

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new UrlRejected('bad_redirect', 'Redirect without a location.')
      const next = new URL(loc, current)
      validateUrl(next.toString()) // scheme/host policy on every hop
      await assertPublicDns(next.hostname) // and re-resolve, defeats naive redirect SSRF
      current = next
      continue
    }

    const contentType = res.headers.get('content-type') || ''
    const textual = /text\/html|application\/xhtml|text\/plain|application\/json/i.test(contentType)
    if (!textual) {
      return { url: current.toString(), status: res.status, body: '', contentType, bytes: 0 }
    }

    const body = await readCapped(res, maxBytes)
    return {
      url: current.toString(),
      status: res.status,
      body,
      contentType,
      bytes: new TextEncoder().encode(body).byteLength,
    }
  }

  throw new UrlRejected('too_many_redirects', 'That URL redirects too many times.')
}
