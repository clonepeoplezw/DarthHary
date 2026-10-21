# Nectary

**Find the companies that should already be your customers.**

Paste a website URL. Nectary reads it, works out who actually buys what you sell, finds real
companies in those segments, and verifies a human and an email before you ever see them.

- **Product stem:** `Necta` — features are named `Necta Scan`, `Necta Find`, `Necta Write`
- **Stack:** Hono + Cloudflare Pages (`_worker.js`) + D1
- **AI:** Google Gemini (primary), OpenAI-compatible fallback for local testing

---

## What is actually built and working

Verified end-to-end against a live site (`larksilk.com`) during development.

| Feature | Status | Notes |
|---|---|---|
| Email/password auth | ✅ | PBKDF2-SHA256 (210k iters), HttpOnly+Secure+SameSite=Lax session cookie, login rate limiting |
| SSRF-hardened URL scanning | ✅ | 8 defences, all tested against loopback/RFC1918/metadata/IPv6/`file://` |
| Site crawl + business profile | ✅ | Homepage + up to 3 descriptive pages; profile 96% confidence on test site |
| ICP segments with fit scores | ✅ | 3–5 scored segments, buyer titles, pain, buying trigger |
| Company discovery + verification gate | ✅ | 10 candidates → 8 confirmed live, 2 silently excluded |
| Company CSV/paste import | ✅ | Deterministic, no LLM, no credits, same verification gate |
| Waterfall enrichment | ✅ | Icypeas → Prospeo → Hunter, stops at first verified hit |
| Demo/mock enrichment | ✅ | Clearly labelled `mock`; excluded from being presented as real |
| Grounded personalisation | ✅ | Every line cites the fetched snippet; blank if nothing verifiable |
| Atomic credit ledger | ✅ | Reserve-before-spend, auto-refund on failure, user-readable |
| CSV export | ✅ | Formula-injection guarded |
| Delete/suppression for GDPR | ⚠️ | `suppression` table exists; no endpoint yet |
| Email sending / inbox / booking | ❌ | Deliberately out of scope — export to Instantly/Smartlead |

---

## API

All `/api/scans/*` routes require a session cookie.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/signup` | Create account, grants 25 credits |
| `POST` | `/api/auth/login` | Sign in |
| `POST` | `/api/auth/logout` | Destroy session |
| `GET` | `/api/auth/me` | Current user + ledger summary |
| `GET` | `/api/auth/ledger` | Last 30 ledger entries |
| `GET` | `/api/status` | Which capabilities are configured (no secrets) |
| `GET` | `/api/health` | Liveness |
| `POST` | `/api/scans` | Run a scan. Body: `{url, focus?}`. Costs 5 credits |
| `GET` | `/api/scans` | Scan history |
| `GET` | `/api/scans/:id` | Scan + profile + segments |
| `GET` | `/api/scans/:id/companies?segmentId=` | Companies for a segment (or `imported`) |
| `POST` | `/api/scans/:id/discover` | Find companies. Body: `{segmentId}` or `{importText}` |
| `POST` | `/api/scans/:id/enrich` | Verify contacts. Body: `{companyIds[]}`. Costs 2 credits each |
| `GET` | `/api/scans/:id/export` | CSV download |

**Credit costs:** scan 5, per-company enrichment 2, imports 0, re-views 0.
Failed scans and undelivered enrichments are refunded automatically.

---

## Data model (D1)

`users`, `sessions`, `scans`, `segments`, `companies`, `contacts`, `ledger`,
`suppression`, `audit_log`, `domain_cache`.

Every tenant-owned row carries `user_id`, and every query filters on it.

---

## Security decisions worth knowing

**1. SSRF on the URL scanner** (`src/lib/ssrf.ts`)
Scheme allow-list, no embedded credentials, hostname deny-list, IP-literal range
checks, DNS-over-HTTPS pre-resolution rejecting private answers, manual redirect
following with re-validation on *every* hop, 8s timeout, 2MB cap.

Known residual risk: DNS rebinding between the DoH lookup and the platform's
connect. Workers cannot pin a resolved IP, so this cannot be fully closed
in-process. Documented in the file. If you move off Workers, add an egress proxy.

**2. No Node crypto.** Workers have no `crypto` module; PBKDF2 via WebCrypto.
210k iterations is a deliberate tradeoff against the Workers CPU budget.

**3. Credits cannot be overdrawn under concurrency.** No read-then-write anywhere.
Every spend is one conditional `UPDATE ... WHERE credits >= ?`, and `meta.changes`
determines whether the reservation won the race.

**4. The model never invents a lead.**
- Profile fields must cite a URL we actually fetched, checked against the crawl set.
- Companies must survive a live HTTP fetch, or they are marked unverified and
  excluded from paid enrichment.
- Emails come only from a provider response, with the provider's own status
  (`verified`/`guessed`/`unknown`) preserved. We never upgrade a guess.
- Personalisation lines require a cited snippet; otherwise the line is blank.

**5. CSV formula-injection guarded** — leading `= + - @` are prefixed with `'`.

**6. Errors log server-side in full, return generic text to the client.**

**7. Audit log:** signup, login, login_failed, scan_completed, scan_failed,
discover, enrich, export_csv.

---

## Configuration

Secrets are server-side only. The browser never receives a key.

```bash
# Production (Cloudflare secret)
npx wrangler pages secret put GEMINI_API_KEY

# Local development (.dev.vars, gitignored)
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
GEMINI_THINKING_BUDGET=0     # see note below
ICYPEAS_API_KEY=      # optional: leave blank for demo mode
PROSPEO_API_KEY=      # optional
HUNTER_API_KEY=       # optional
```

Get a Gemini key at https://aistudio.google.com/apikey — the free tier is enough
to validate ICP quality before spending anything on enrichment.

**Gemini is the primary provider.** `llmConfigured()` checks `GEMINI_API_KEY`
first, so once that key is set the OpenAI fallback is ignored entirely. You do
not need to change code to switch — just add the key.

### Why `GEMINI_THINKING_BUDGET=0`

Gemini 2.5+ Flash models think by default, and thinking tokens are billed
against `maxOutputTokens`. With a structured-output call capped at ~1600 tokens,
the thinking pass can consume the whole budget and return `finishReason:
MAX_TOKENS` with **empty text**. For schema-constrained extraction there is
nothing to reason about, so thinking is disabled by default.

The client also retries once with a doubled token budget on `MAX_TOKENS` before
failing, so a large page degrades into a slower success rather than an error.

Set `GEMINI_THINKING_BUDGET=-1` to re-enable dynamic thinking if you want it.

### Enrichment providers

Add any one to leave demo mode. Cheapest first:

| Provider | Approx. cost | Notes |
|---|---|---|
| Icypeas | ~$0.019/email | Cheapest; default first hop |
| Prospeo | ~$49.99/mo, 2k credits | Better quality, Clay favourite |
| Hunter | ~$34–49/mo | Familiar fallback |

**Apollo avoided deliberately:** expensive, and its ToS restricts storing and
reselling API data — real legal exposure for a product like this. Verify every
provider's storage clause before launch.

**Unit economics:** 100 enriched, verified contacts ≈ $3–6. Waterfall hit rate
~60–80% vs ~40% for any single provider, at similar cost because most hits
resolve on the first call.

---

## Local development

```bash
npm install
npm run db:migrate:local          # apply D1 schema
npm run build
pm2 start ecosystem.config.cjs    # http://localhost:3000
curl http://localhost:3000/api/health
```

Note: do **not** add `--d1=DB` to the wrangler command. It creates a second,
empty local database instead of using the one migrations were applied to.

### Testing without a Gemini key

Set the OpenAI-compatible fallback in `.dev.vars`:

```
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4.1-mini
```

Leave those blank in production.

---

## Deployment

`wrangler.jsonc` is deliberately compatible with both deploy paths:

- no `kv_namespaces` (hosted deploy rejects them — use a D1 table for KV)
- no `triggers` (hosted deploy rejects cron — do periodic work lazily on request)

Before deploying:

```bash
npx wrangler d1 create nectary-production
# paste the returned database_id into wrangler.jsonc
npx wrangler d1 migrations apply nectary-production   # remote
npx wrangler pages deploy dist
```

Ask me which path you want when you're ready — your own Cloudflare account
(`wrangler pages deploy`, ~free at this scale) vs Genspark-hosted. Both work
with this config; they're different flows.

---

## Known gaps / next steps

1. **No email sending.** Intentional. Export to Instantly/Smartlead.
2. **No GDPR delete endpoint.** `suppression` table exists but is unwired.
   Work emails are personal data in the EU — add legitimate-interest basis,
   suppression, and deletion before selling there.
3. **Retention policy not enforced.** Add a sweep for old scans/contacts.
4. **Company discovery leans on model knowledge.** The verification gate stops
   fake companies, but coverage varies by vertical. A paid source (Google Places,
   Apollo/Clearbit company search) would improve recall.
5. **Pick one vertical for launch.** Generic "any website" produces weak ICPs at
   the edges. One vertical with tuned prompts beats ten mediocre ones.
6. **No test suite.** Security logic (SSRF, ledger, coercion) deserves unit tests
   — that's the highest-value next engineering task.
7. **Rate limiting is per-isolate**, best-effort. Move to D1 or Durable Objects
   for hard global limits before scaling.
