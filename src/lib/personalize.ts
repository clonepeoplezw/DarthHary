import type { Env } from '../types'
import { llmJson, S } from './llm'
import { safeFetch } from './ssrf'
import { htmlToText, clip } from './crawl'

/**
 * Personalisation.
 *
 * The rule: every generated line must be grounded in a fact we fetched from the
 * prospect's own site. The model is given that text and told to cite which
 * snippet it used. If it cannot cite one, we do not produce a line at all
 * (better to send a generic email than a confidently wrong one).
 */

const SYSTEM = `You write the opening line of a cold B2B email. You are given (a) what the sender sells and (b) text scraped from the recipient company's own website.

Rules:
- Exactly one or two sentences. No greeting, no sign-off, no "I hope this finds you well".
- Reference something SPECIFIC and verifiable from the supplied text - a service they offer, a market they serve, a stated detail.
- Never invent a fact, customer name, award, statistic, or event that is not in the supplied text.
- Never mention that you scraped their website or used AI.
- No flattery, no generic compliments ("I love your website").
- If the supplied text does not contain anything specific enough to reference, return an empty string for the line and set grounded to false.
- Write like a peer, not a vendor. Plain, concrete, short.`

const SCHEMA = S.obj({
  line: S.str('The opening line, or empty string if nothing specific could be grounded'),
  evidence: S.str('The exact snippet from the supplied text that the line is based on'),
  grounded: S.bool('True only if the line is fully supported by the supplied text'),
})

export interface PersonalizationResult {
  line: string
  evidence: string
  grounded: boolean
}

export async function personalize(
  env: Env,
  opts: {
    whatTheySell: string
    companyName: string
    domain: string
    contactTitle?: string
  },
): Promise<PersonalizationResult> {
  let siteText = ''
  try {
    const res = await safeFetch(`https://${opts.domain}`, { timeoutMs: 6000, maxBytes: 300_000 })
    if (res.body) {
      const text = htmlToText(res.body)
      // Keep the head of the page plus a slice of the middle: the "what we do"
      // line is usually near the top, specifics often live further down.
      siteText = clip(text, 4500)
    }
  } catch {
    return { line: '', evidence: '', grounded: false }
  }

  if (siteText.length < 200) {
    return { line: '', evidence: '', grounded: false }
  }

  try {
    const raw: any = await llmJson(env, {
      system: SYSTEM,
      user: [
        `THE SENDER SELLS: ${opts.whatTheySell}`,
        `THE RECIPIENT COMPANY: ${opts.companyName} (${opts.domain})`,
        opts.contactTitle ? `THE RECIPIENT'S ROLE: ${opts.contactTitle}` : '',
        ``,
        `TEXT FROM THE RECIPIENT'S WEBSITE:`,
        siteText,
      ].join('\n'),
      schema: SCHEMA,
      maxOutputTokens: 500,
      temperature: 0.6,
    })

    const line = String(raw?.line || '').trim()
    const evidence = String(raw?.evidence || '').trim()
    const grounded = Boolean(raw?.grounded)

    // Refuse to store a line with no evidence, even if the model claims it is grounded.
    if (!line || !grounded || evidence.length < 12) {
      return { line: '', evidence: '', grounded: false }
    }
    // Guard against the model echoing the source verbatim.
    if (siteText.toLowerCase().includes(line.toLowerCase()) && line.length > 80) {
      return { line: '', evidence: '', grounded: false }
    }
    return { line: clip(line, 400), evidence: clip(evidence, 400), grounded: true }
  } catch {
    return { line: '', evidence: '', grounded: false }
  }
}
