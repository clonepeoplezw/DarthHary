import type { Env } from '../types'

/**
 * Provider-agnostic structured-JSON call.
 *
 * Gemini is the primary provider (as requested). An OpenAI-compatible path is
 * included for two practical reasons:
 *   1. the app can be exercised in CI/local dev without a Gemini key
 *   2. switching model vendors later is a config change, not a rewrite
 *
 * Both credentials are server-side only. Nothing here is ever reachable from
 * the browser bundle — every call is proxied through a Hono route.
 */

export class LlmError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message)
  }
}

export interface LlmOptions {
  system: string
  user: string
  schema: Record<string, unknown>
  maxOutputTokens?: number
  temperature?: number
  /** Deterministic-ish output helps with repeat scans of the same site. */
  seed?: number
}

export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash'

/**
 * Which provider and model a request will actually use. The model name is not
 * a secret, so it is safe to surface on /api/status — it lets you confirm that
 * a GEMINI_MODEL change took effect without reading CI logs.
 */
export function llmConfigured(env: Env): {
  ok: boolean
  provider: 'gemini' | 'openai' | 'none'
  model: string | null
} {
  if (env.GEMINI_API_KEY && env.GEMINI_API_KEY.length > 10) {
    return { ok: true, provider: 'gemini', model: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL }
  }
  if (env.LLM_API_KEY && env.LLM_BASE_URL) {
    return { ok: true, provider: 'openai', model: env.LLM_MODEL?.trim() || null }
  }
  return { ok: false, provider: 'none', model: null }
}

function stripFences(text: string): string {
  const t = text.trim()
  if (!t.startsWith('```')) return t
  return t.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
}

function parseJsonLoose(text: string): any {
  const cleaned = stripFences(text)
  try {
    return JSON.parse(cleaned)
  } catch {
    // Models occasionally prepend a sentence. Grab the outermost object.
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1))
      } catch {
        /* fall through */
      }
    }
    // Sometimes a bare array is returned instead of the requested object.
    const aStart = cleaned.indexOf('[')
    const aEnd = cleaned.lastIndexOf(']')
    if (aStart >= 0 && aEnd > aStart) {
      try {
        return JSON.parse(cleaned.slice(aStart, aEnd + 1))
      } catch {
        /* fall through */
      }
    }
    throw new LlmError('bad_json', 'The model returned something we could not parse.', true)
  }
}

/** Logs the shape (never the content) of a model response when DEBUG_LLM is on. */
export function debugShape(label: string, value: any): void {
  try {
    if (typeof console === 'undefined') return
    const kind = Array.isArray(value) ? `array(${value.length})` : typeof value
    const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 12) : []
    console.log(`[llm] ${label} -> ${kind} keys=${JSON.stringify(keys)}`)
  } catch {
    /* diagnostics must never throw */
  }
}

/**
 * Render a schema as a compact, human-readable key listing.
 *
 * Gemini enforces `responseSchema` natively, but OpenAI-compatible endpoints
 * only honour `response_format: json_object` — which guarantees valid JSON and
 * nothing about the shape. Without this block the model invents its own keys.
 * Emitting the contract in the prompt makes both providers behave the same.
 */
export function describeSchema(schema: any, indent = 0): string {
  const pad = '  '.repeat(indent)
  const t = String(schema?.type || '').toUpperCase()

  if (t === 'OBJECT' && schema.properties) {
    return Object.entries(schema.properties)
      .map(([k, v]: [string, any]) => {
        const inner = describeSchema(v, indent + 1)
        const desc = v?.description ? `  // ${v.description}` : ''
        if (inner) return `${pad}${k}: {\n${inner}\n${pad}}${desc}`
        return `${pad}${k}: ${String(v?.type || 'STRING').toLowerCase()}${desc}`
      })
      .join('\n')
  }

  if (t === 'ARRAY' && schema.items) {
    const inner = describeSchema(schema.items, indent + 1)
    if (inner) return `${pad}[\n${inner}\n${pad}]`
    return `${pad}${String(schema.items?.type || 'string').toLowerCase()}[]`
  }

  return ''
}

/** Appended to every provider call so the response contract is unambiguous. */
function schemaContract(schema: any): string {
  const body = describeSchema(schema, 1)
  if (!body) return ''
  return `\n\nRESPONSE FORMAT
Return a single JSON object. Use exactly these keys, with these types. Do not add
extra keys, do not wrap it in prose, and do not return a bare array.

{
${body}
}`
}

const GEMINI_TIMEOUT_MS = 45_000

/**
 * Thinking configuration differs by model family — this is not cosmetic:
 *
 *   Gemini 2.5.x  -> generationConfig.thinkingConfig.thinkingBudget
 *                    (0 fully disables thinking)
 *   Gemini 3.x/4.x -> generationConfig.thinkingConfig.thinkingLevel
 *                    ("minimal" | "low" | "medium" | "high")
 *
 * Sending thinkingBudget to a 3.x model is rejected by the API, and sending
 * thinkingLevel to a 2.5 model is likewise rejected. Gemini 3.x also CANNOT
 * fully disable thinking — "minimal" is the floor and "does not guarantee
 * thinking is off". That matters because thinking tokens are billed against
 * maxOutputTokens and can starve a structured-output response into
 * finishReason MAX_TOKENS with empty text.
 *
 * Default is "minimal": this is schema-constrained extraction, not reasoning.
 */
function thinkingConfig(env: Env, model: string): { fields: Record<string, unknown>; canDisable: boolean } | null {
  const isV3Plus = /^gemini-(3|4)/i.test(model)
  const isV25 = /^gemini-2\.5/i.test(model)

  if (isV3Plus) {
    const raw = (env.GEMINI_THINKING_LEVEL ?? '').trim().toLowerCase()
    const allowed = ['minimal', 'low', 'medium', 'high']
    const level = allowed.includes(raw) ? raw : 'minimal'
    return { fields: { thinkingLevel: level }, canDisable: false }
  }

  if (isV25) {
    const raw = (env.GEMINI_THINKING_BUDGET ?? '').trim()
    const budget = raw === '' ? 0 : Number(raw)
    return { fields: { thinkingBudget: Number.isFinite(budget) ? budget : 0 }, canDisable: true }
  }

  return null
}

async function callGemini(env: Env, opts: LlmOptions): Promise<any> {
  const model = env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`

  const think = thinkingConfig(env, model)

  // When thinking cannot be disabled (Gemini 3.x), reserve headroom for the
  // thought tokens that share the maxOutputTokens budget.
  const requested = opts.maxOutputTokens ?? 4096
  const baseBudget = think && !think.canDisable ? Math.min(requested * 2, 8192) : requested

  // Thinking controls are model-family specific and a wrong one is a hard 400.
  // Downgrade gracefully instead of failing the user's scan.
  let levelFallback: string | null = null
  let dropThinking = false

  for (let attempt = 0; attempt < 3; attempt++) {
    const budget = attempt === 0 ? baseBudget : Math.min(baseBudget * 2, 8192)

    const generationConfig: Record<string, unknown> = {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: budget,
      responseMimeType: 'application/json',
      responseSchema: opts.schema,
    }

    if (think && !dropThinking) {
      generationConfig.thinkingConfig = levelFallback ? { thinkingLevel: levelFallback } : think.fields
    }

    const body = {
      systemInstruction: { parts: [{ text: opts.system + schemaContract(opts.schema) }] },
      contents: [{ role: 'user', parts: [{ text: opts.user }] }],
      generationConfig,
    }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY as string,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      })
    } catch (e: any) {
      throw new LlmError('gemini_unreachable', `Could not reach the model provider (${e?.name || 'network'}).`, true)
    }

    if (res.status === 429) {
      throw new LlmError('rate_limited', 'The model provider is rate limiting us. Try again shortly.', true)
    }
    if (res.status === 401 || res.status === 403) {
      throw new LlmError('bad_key', 'The Gemini API key was rejected. Check the secret on the server.', false)
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 400)

      // Gemini reports an invalid key as 400, not 401.
      if (/API key not valid|API_KEY_INVALID|invalid api key/i.test(detail)) {
        throw new LlmError('bad_key', 'The Gemini API key was rejected. Check the secret on the server.', false)
      }

      // Unsupported thinking level: step down and retry instead of failing.
      if (/thinkingLevel|thinking_level/i.test(detail) && !levelFallback && think && !think.canDisable) {
        levelFallback = 'low'
        console.log(`[llm] ${model} rejected thinkingLevel, retrying with "low"`)
        continue
      }

      // Older/newer models may reject thinkingConfig entirely — drop it and retry.
      if (/thinkingConfig|thinking_config/i.test(detail) && attempt === 0) {
        console.log(`[llm] ${model} rejected thinkingConfig, retrying without it`)
        dropThinking = true
        continue
      }

      if (/responseSchema|response_schema/i.test(detail)) {
        throw new LlmError(
          'bad_schema',
          `Gemini rejected the response schema for ${model}. Try a different GEMINI_MODEL. ${detail}`,
          false,
        )
      }
      if (/not found|is not supported|does not exist/i.test(detail) && /model/i.test(detail)) {
        throw new LlmError(
          'bad_model',
          `The model "${model}" is not available on this API key. Check GEMINI_MODEL — known good: gemini-3.6-flash, gemini-2.5-flash. ${detail}`,
          false,
        )
      }
      throw new LlmError('gemini_error', `Model provider error ${res.status}. ${detail}`, res.status >= 500)
    }

    const data: any = await res.json()
    const candidate = data?.candidates?.[0]
    const finish = candidate?.finishReason

    if (finish === 'SAFETY' || finish === 'BLOCKED' || finish === 'PROHIBITED_CONTENT') {
      throw new LlmError('blocked', 'The model refused to answer for this page.', false)
    }
    if (finish === 'RECITATION') {
      throw new LlmError('blocked', 'The model declined to quote this page.', false)
    }

    // Gemini 3.x may include thought parts in the response. Never treat those
    // as the answer — they are reasoning, not JSON.
    const parts: any[] = candidate?.content?.parts || []
    const text = parts
      .filter((p) => p && !p.thought)
      .map((p) => p?.text || '')
      .join('')
      .trim()

    if (finish === 'MAX_TOKENS') {
      if (attempt < 2) {
        console.log(`[llm] MAX_TOKENS with budget ${budget} on ${model}, retrying larger`)
        continue
      }
      throw new LlmError(
        'truncated',
        'The model ran out of output tokens. Try again, or raise GEMINI_THINKING_LEVEL budget.',
        true,
      )
    }

    if (!text) throw new LlmError('empty', 'The model returned an empty response.', true)
    return parseJsonLoose(text)
  }

  throw new LlmError('truncated', 'The model could not finish within the token budget.', true)
}

async function callOpenAiCompatible(env: Env, opts: LlmOptions): Promise<any> {
  const base = (env.LLM_BASE_URL || '').replace(/\/+$/, '')
  const model = env.LLM_MODEL?.trim() || 'gpt-4.1-mini'

  const body = {
    model,
    messages: [
      { role: 'system', content: opts.system + schemaContract(opts.schema) },
      { role: 'user', content: opts.user },
    ],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxOutputTokens ?? 4096,
    response_format: { type: 'json_object' },
  }

  let res: Response
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.LLM_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    })
  } catch {
    throw new LlmError('llm_unreachable', 'Could not reach the model provider.', true)
  }

  if (res.status === 429) throw new LlmError('rate_limited', 'The model provider is rate limiting us.', true)
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    throw new LlmError('llm_error', `Model provider error ${res.status}. ${detail}`, res.status >= 500)
  }

  const data: any = await res.json()
  const text = data?.choices?.[0]?.message?.content
  if (!text) throw new LlmError('empty', 'The model returned an empty response.', true)
  return parseJsonLoose(text)
}

export async function llmJson(env: Env, opts: LlmOptions): Promise<any> {
  const cfg = llmConfigured(env)
  if (!cfg.ok) {
    throw new LlmError(
      'not_configured',
      'No model provider is configured. Set GEMINI_API_KEY on the server.',
      false,
    )
  }
  return cfg.provider === 'gemini' ? callGemini(env, opts) : callOpenAiCompatible(env, opts)
}

/* ------------------------------------------------------------------ *
 * Schema helpers. Gemini accepts a JSON-schema-ish subset; we keep the
 * definitions inside that subset so the same object works for both
 * providers (OpenAI ignores it, Gemini enforces it).
 * ------------------------------------------------------------------ */

export const S = {
  str: (description?: string) => ({ type: 'STRING', ...(description ? { description } : {}) }),
  num: (description?: string) => ({ type: 'NUMBER', ...(description ? { description } : {}) }),
  int: (description?: string) => ({ type: 'INTEGER', ...(description ? { description } : {}) }),
  bool: (description?: string) => ({ type: 'BOOLEAN', ...(description ? { description } : {}) }),
  arrOfStr: (description?: string) => ({ type: 'ARRAY', items: { type: 'STRING' }, ...(description ? { description } : {}) }),
  arrOfObj: (properties: Record<string, unknown>, description?: string) => ({
    type: 'ARRAY',
    items: { type: 'OBJECT', properties, required: Object.keys(properties) },
    ...(description ? { description } : {}),
  }),
  obj: (properties: Record<string, unknown>) => ({
    type: 'OBJECT',
    properties,
    required: Object.keys(properties),
  }),
} as const
