import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env } from './types'
import authRoutes from './routes/auth'
import scanRoutes from './routes/scans'
import { requireAuth, getSessionUser, fail, type Ctx } from './lib/http'
import { llmConfigured } from './lib/llm'
import { enrichmentConfigured } from './lib/enrich'

const app = new Hono<{ Bindings: Env; Variables: { user: any } }>()

app.use('*', logger())

// CORS scoped to the API only, and only same-origin by default. If you later
// host the frontend on a different origin, list it explicitly here — never '*'
// on an authenticated API.
app.use('/api/*', cors({ origin: (o) => o, credentials: true, maxAge: 600 }))

app.use('/api/*', async (c, next) => {
  c.header('x-content-type-options', 'nosniff')
  c.header('referrer-policy', 'strict-origin-when-cross-origin')
  await next()
})

// ---- public API surfaces ------------------------------------------------
app.route('/api/auth', authRoutes)

// ---- gated API surfaces -------------------------------------------------
app.use('/api/scans/*', requireAuth)
app.use('/api/scans', requireAuth)
app.use('/api/account/*', requireAuth)
app.route('/api/scans', scanRoutes)

app.get('/api/account', async (c) => {
  const user = await getSessionUser(c as Ctx)
  if (!user) return fail(c as Ctx, 401, 'unauthorized', 'Please sign in.')
  return c.json({ user })
})

/** Non-secret capability report so the UI can be honest about what is wired up. */
app.get('/api/status', async (c) => {
  const llm = llmConfigured(c.env)
  const user = await getSessionUser(c as Ctx)
  return c.json({
    ai: { configured: llm.ok, provider: llm.provider, model: llm.model },
    enrichment: { configured: enrichmentConfigured(c.env) },
    authenticated: !!user,
  })
})

app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }))

// Errors are logged in full server-side, but never echoed to the client.
app.onError((err, c) => {
  console.error('[unhandled]', c.req.method, c.req.path, err?.stack || err)
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'internal', message: 'Something went wrong on our side.' }, 500)
  }
  return c.text('Internal Server Error', 500)
})

// ---- pages --------------------------------------------------------------
app.get('/', (c) => c.html(shell(c.env)))
app.get('/app', (c) => c.html(shell(c.env)))
app.get('/app/*', (c) => c.html(shell(c.env)))

// Static assets live in public/static and are served by the Pages asset layer.
// The explicit 404 keeps unknown /api paths from falling through to HTML.
app.all('/api/*', (c) => c.json({ error: 'not_found', message: 'No such endpoint.' }, 404))

export default app

/* ------------------------------------------------------------------ *
 * The document shell. All app logic lives in /static/app.js so the
 * HTML stays cacheable and CSP-friendly.
 * ------------------------------------------------------------------ */
function shell(env: Env): string {
  const minted = Date.now().toString(36)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nectary — find the companies that should already be your customers</title>
<meta name="description" content="Paste your website. Nectary reads it, identifies the buyer segments most likely to buy from you, finds real companies in those segments, and verifies their contacts." />
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0f2e1d"/><path d="M16 7c3.5 2.4 5.2 5.6 5.2 9.3 0 3.9-2.3 7.2-5.2 8.7-2.9-1.5-5.2-4.8-5.2-8.7C10.8 12.6 12.5 9.4 16 7z" fill="#e8b23a"/><circle cx="16" cy="17" r="2.1" fill="#0f2e1d"/></svg>`,
  )}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/static/styles.css?v=${minted}" />
</head>
<body>
<div id="root"><div class="boot"><div class="boot-mark"></div><p>Nectary</p></div></div>
<script src="/static/app.js?v=${minted}" type="module"></script>
</body>
</html>`
}
