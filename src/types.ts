export interface Env {
  DB: D1Database

  // LLM: Gemini is primary. The OpenAI-compatible path exists so the app can be
  // exercised locally/in tests without a Gemini key. Both are server-side only.
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  GEMINI_THINKING_BUDGET?: string
  GEMINI_THINKING_LEVEL?: string
  LLM_BASE_URL?: string
  LLM_API_KEY?: string
  LLM_MODEL?: string

  // Enrichment waterfall (all optional; mock is used when none are set)
  ICYPEAS_API_KEY?: string
  PROSPEO_API_KEY?: string
  HUNTER_API_KEY?: string

  SESSION_SECRET?: string
  DEMO_MODE?: string
  DEFAULT_SCAN_CREDITS?: string
  DEFAULT_CONTACT_CREDITS?: string
}

export interface User {
  id: string
  email: string
  plan: string
  credits: number
  is_admin: number
}

export interface BusinessProfile {
  company_name: string
  what_they_sell: string
  category: string
  business_model: string
  price_band: string
  geographies: string[]
  differentiators: string[]
  keywords: string[]
  evidence_urls: string[]
  confidence: number
}

export interface IcpSegment {
  name: string
  fit_score: number
  rationale: string
  buyer_titles: string[]
  pain: string
  signal: string
  geo_hint?: string
}

export interface CandidateCompany {
  name: string
  domain: string
  location?: string
  why_fit?: string
  evidence_url?: string
}

export interface EnrichedContact {
  full_name: string
  title: string
  email: string
  email_status: 'verified' | 'guessed' | 'unknown' | 'mock'
  linkedin?: string
  provider: string
  confidence: number
}

export interface PageRead {
  url: string
  status: number
  bytes: number
  title: string
}
