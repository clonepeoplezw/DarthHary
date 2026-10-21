/* ==========================================================================
   Nectary frontend
   Vanilla ES module. No framework, no build step beyond Vite copying it.
   Security notes:
     - never stores tokens; the session is an HttpOnly cookie set by the server
     - never receives provider keys; all AI/enrichment calls are proxied
     - all user/model-derived strings are escaped before going into innerHTML
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const root = document.getElementById('root');

const state = {
  user: null,
  status: { ai: { configured: false, provider: 'none' }, enrichment: { configured: false } },
  view: 'landing', // landing | app
  scan: null,
  segments: [],
  companies: [],
  selected: new Set(),
  contacts: [],
  busy: null,
  notes: [],
  authMode: 'signup',
};

/* ------------------------------ utils ---------------------------------- */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const pct = (n) => Math.max(0, Math.min(100, Number(n) || 0));

function fitClass(n) {
  const v = pct(n);
  if (v >= 80) return 'fit-hi';
  if (v >= 60) return 'fit-mid';
  return 'fit-lo';
}

function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0] || '')
    .join('')
    .toUpperCase();
}

function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

function normalizeUrl(raw) {
  let v = String(raw || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  return v;
}

/* ------------------------------ api ------------------------------------ */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });

  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();

  if (!res.ok) {
    const err = new Error((body && body.message) || `Request failed (${res.status})`);
    err.code = (body && body.error) || 'http_' + res.status;
    err.status = res.status;
    err.detail = body;
    throw err;
  }
  return body;
}

/* ------------------------------ toast ---------------------------------- */

let toastTimer = null;
function toast(message, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:28px',
      'transform:translateX(-50%) translateY(8px)',
      'background:#0f2e1d',
      'color:#faf7f0',
      'padding:12px 20px',
      'border-radius:999px',
      'font-size:13.5px',
      'font-weight:500',
      'box-shadow:0 10px 30px rgba(15,46,29,.28)',
      'z-index:200',
      'opacity:0',
      'transition:opacity .18s ease, transform .18s ease',
      'max-width:88vw',
      'text-align:center',
    ].join(';');
    document.body.appendChild(el);
  }
  if (kind === 'error') el.style.background = '#8d2f22';
  else if (kind === 'ok') el.style.background = '#1f6b45';
  else el.style.background = '#0f2e1d';

  el.textContent = message;
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';
  });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(8px)';
  }, 3800);
}

/* ------------------------------ brand mark ------------------------------ */

const leafSvg = (size = 26) => `
<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <rect width="32" height="32" rx="9" fill="#0f2e1d"/>
  <path d="M16 6.5c3.6 2.5 5.4 5.8 5.4 9.6 0 4-2.4 7.4-5.4 9-3-1.6-5.4-5-5.4-9 0-3.8 1.8-7.1 5.4-9.6z" fill="#e8b23a"/>
  <circle cx="16" cy="17.2" r="2.2" fill="#0f2e1d"/>
</svg>`;

const icons = {
  globe: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/></svg>`,
  arrow: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  spark: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>`,
  check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 12.5l5.2 5.2L20 6.8"/></svg>`,
  alert: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>`,
  info: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 11v6M12 7.5v.5"/><circle cx="12" cy="12" r="9"/></svg>`,
  download: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M7 11l5 5 5-5M4 20h16"/></svg>`,
  pin: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>`,
  copy: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/></svg>`,
  x: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  target: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/></svg>`,
};

/* ------------------------------ header --------------------------------- */

function header() {
  const credits = state.user ? `<span class="credit-pill"><span class="dot"></span><b>${state.user.credits}</b> credits</span>` : '';

  const actions = state.user
    ? `<button class="btn btn-quiet btn-sm" data-act="history">History</button>
       <button class="btn btn-ghost btn-sm" data-act="logout">Sign out</button>${credits}`
    : `<button class="btn btn-quiet btn-sm" data-act="open-login">Sign in</button>
       <button class="btn btn-primary btn-sm" data-act="open-signup">Start free</button>`;

  return `
  <header class="topbar">
    <div class="topbar-in">
      <a class="brand" href="/" data-act="home">${leafSvg(27)} <span>Nectary</span></a>
      <span class="brand-sub">Necta Scan</span>
      <div class="spacer"></div>
      ${actions}
    </div>
  </header>`;
}

/* ------------------------------ landing -------------------------------- */

function landing() {
  return `
  ${header()}
  <main class="landing">
    <div class="wrap">
      <span class="eyebrow"><span class="pulse"></span> Built for people who hate lead lists</span>

      <div class="hero-grid">
        <section id="hero-section">
          <h1 class="hero-title">Paste your website.<br/>Meet the companies that<br/><em>should already be buying.</em></h1>
          <p class="hero-lede">
            Nectary reads your site, works out who actually buys what you sell, and finds real
            companies in those segments — then verifies a human and an email before you ever
            see them. No contact database to wade through. No guessed addresses.
          </p>

          <div class="scan-box">
            <div class="field-row">
              <label class="input-shell">
                ${icons.globe}
                <input id="hero-url" type="text" placeholder="yourcompany.com" autocomplete="url" spellcheck="false" />
              </label>
              <button class="btn btn-gold btn-primary btn-block-sm" data-act="hero-scan">
                Scan my site ${icons.arrow}
              </button>
            </div>
            <div class="scan-hint">
              <span class="cost">25 free credits</span>
              <span>·</span>
              <span>a scan costs 5</span>
              <span>·</span>
              <span>refunded automatically if we can't read the page</span>
            </div>
          </div>
        </section>

        <aside class="hero-aside" aria-label="How it works">
          <div class="mini-steps">
            <div class="mini-step">
              <span class="n">1</span>
              <div>
                <h4>It reads, not guesses</h4>
                <p>We fetch your homepage, about, services and pricing pages, then extract what you sell using only that text.</p>
              </div>
            </div>
            <div class="mini-step">
              <span class="n">2</span>
              <div>
                <h4>You get scored segments</h4>
                <p>Buyer groups with a fit score, the pain you relieve, a buying trigger, and the job titles worth contacting.</p>
              </div>
            </div>
            <div class="mini-step">
              <span class="n">3</span>
              <div>
                <h4>Companies get verified</h4>
                <p>Every candidate domain is fetched for real. If it doesn't resolve to a live site, it doesn't reach your list.</p>
              </div>
            </div>
            <div class="mini-step">
              <span class="n">4</span>
              <div>
                <h4>Contacts are sourced, not invented</h4>
                <p>Emails come from an enrichment provider with its verification status attached. The AI never writes an address.</p>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <div class="trust-strip">
        <div class="trust-item">
          <h5>Verified, not vibes</h5>
          <p>Every company is fetched live before it is shown. Unverified candidates are marked and excluded from paid enrichment by default.</p>
        </div>
        <div class="trust-item">
          <h5>Honest confidence</h5>
          <p>Emails carry the provider's own status — verified, guessed, or unknown. We never upgrade a guess to make the list look better.</p>
        </div>
        <div class="trust-item">
          <h5>Costs you can see</h5>
          <p>Credits are reserved before a paid call and refunded when nothing is delivered. Every movement is written to a ledger you can read.</p>
        </div>
      </div>
    </div>
  </main>`;
}

function authModal() {
  const isSignup = state.authMode === 'signup';
  return `
  <div class="overlay" data-act="overlay-close">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="auth-title" data-stop="1">
      <button class="modal-close" data-act="overlay-close" aria-label="Close">${icons.x}</button>
      <h3 id="auth-title">${isSignup ? 'Start with 25 credits' : 'Welcome back'}</h3>
      <p class="lede">${isSignup ? 'No card. A scan costs 5 credits, refunded if we cannot read your site.' : 'Sign in to pick up where you left off.'}</p>
      <div class="form-err hidden" id="auth-err"></div>
      <form id="auth-form" autocomplete="on">
        <div class="field">
          <label for="auth-email">Work email</label>
          <input id="auth-email" name="email" type="email" autocomplete="email" required placeholder="you@company.com" />
        </div>
        <div class="field">
          <label for="auth-password">Password</label>
          <input id="auth-password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" required placeholder="${isSignup ? 'At least 10 characters' : '••••••••••'}" />
        </div>
        <button class="btn btn-primary btn-block mt-16" type="submit" id="auth-submit">
          ${isSignup ? 'Create account' : 'Sign in'}
        </button>
      </form>
      <div class="switch-line">
        ${isSignup ? 'Already have an account?' : 'New to Nectary?'}
        <button class="link-btn" data-act="switch-auth">${isSignup ? 'Sign in' : 'Create one'}</button>
      </div>
    </div>
  </div>`;
}

/* ------------------------------ stepper -------------------------------- */

const STEPS = [
  { key: 'scan', label: 'Scan site' },
  { key: 'segments', label: 'Buyer segments' },
  { key: 'companies', label: 'Companies' },
  { key: 'contacts', label: 'Contacts' },
];

function stepper(activeIndex) {
  return `<nav class="stepper" aria-label="Progress">${STEPS.map((s, i) => {
    const cls = i < activeIndex ? 'done' : i === activeIndex ? 'active' : '';
    return `${i > 0 ? '<span class="step-line"></span>' : ''}
      <span class="step ${cls}"><span class="bubble">${i < activeIndex ? icons.check : i + 1}</span><span class="lbl">${s.label}</span></span>`;
  }).join('')}</nav>`;
}

function notice(kind, html) {
  const ico = kind === 'err' ? icons.alert : kind === 'warn' ? icons.alert : icons.info;
  return `<div class="notice notice-${kind}">${ico}<div>${html}</div></div>`;
}

function working(title, sub) {
  return `<div class="card mt-16"><div class="working"><div class="spinner"></div>
    <div class="working-txt"><strong>${esc(title)}</strong><span>${esc(sub)}</span></div></div></div>`;
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

function render() {
  if (state.view === 'landing') {
    root.innerHTML = landing() + (state.authMode && state.showAuth ? authModal() : '');
    return;
  }

  const idx = state.contacts.length ? 3 : state.companies.length ? 2 : state.segments.length ? 1 : 0;
  root.innerHTML = `
    ${header()}
    <main class="app"><div class="wrap">
      ${stepper(state.busy === 'scan' ? 0 : idx)}
      <div id="app-body">${appBody()}</div>
    </div></main>
    ${state.showAuth ? authModal() : ''}`;
}

function appBody() {
  if (state.busy === 'scan') {
    return `
      <div class="card card-pad">
        <div class="card-head"><h2>Reading ${esc(state.scanDomain || 'your site')}</h2></div>
        <div class="sk-line skeleton" style="width:70%"></div>
        <div class="sk-line skeleton" style="width:92%"></div>
        <div class="sk-line skeleton" style="width:55%"></div>
      </div>
      ${working('Fetching pages and extracting what you sell', 'Usually 10–25 seconds. We read your homepage plus up to three descriptive pages.')}`;
  }

  if (state.busy === 'discover') {
    return `${profileCard()}
      ${working('Finding companies in this segment', 'Proposing candidates, then fetching each domain to confirm it is a real, live site.')}`;
  }

  if (state.busy === 'enrich') {
    return `${working('Verifying contacts', 'Walking the enrichment waterfall cheapest-first and stopping at the first verified address.')}`;
  }

  if (state.contacts.length) return contactsView();
  if (state.companies.length) return companiesView();
  if (state.segments.length) return segmentsView();
  if (state.scan) return profileCard() + scanPrompt();
  return scanForm();
}

function scanForm() {
  return `
  <div class="card card-pad">
    <div class="card-head">
      <h2>Scan a website</h2>
      <span class="sub">Reads the site, then proposes buyer segments</span>
    </div>
    ${state.notes.length ? state.notes.map((n) => notice('warn', esc(n))).join('') : ''}
    <div class="field-row">
      <label class="input-shell">${icons.globe}
        <input id="app-url" type="text" placeholder="yourcompany.com" spellcheck="false" />
      </label>
      <button class="btn btn-gold" data-act="scan">Scan site ${icons.arrow}</button>
    </div>
    <div class="field mt-16">
      <label for="app-focus">Optional: who do you actually want? (sharpens the result)</label>
      <input id="app-focus" type="text" placeholder="e.g. only US buyers, or agencies not end clients" />
    </div>
    <p class="tiny muted mt-16">Costs 5 credits. Refunded automatically if we cannot read the page.</p>
  </div>`;
}

function profileCard() {
  const p = state.scan?.profile;
  if (!p) return '';
  const conf = pct(p.confidence);
  return `
  <div class="card card-pad">
    <div class="card-head">
      <h2>${esc(p.company_name || state.scan.domain)}</h2>
      <span class="sub">${esc(state.scan.domain)}</span>
    </div>
    <div class="profile-grid">
      <div>
        <div class="section-label">What they sell</div>
        <p class="profile-sell">${esc(p.what_they_sell || 'Not enough text on the site to describe the offer.')}</p>
        <div class="chip-row">
          ${p.category ? `<span class="chip solid">${esc(p.category)}</span>` : ''}
          ${p.business_model ? `<span class="chip">${esc(p.business_model.replace(/_/g, ' '))}</span>` : ''}
          ${p.price_band && p.price_band !== 'unknown' ? `<span class="chip">${esc(p.price_band)} price band</span>` : ''}
          ${(p.geographies || []).slice(0, 4).map((g) => `<span class="chip">${esc(g)}</span>`).join('')}
        </div>
        ${
          (p.differentiators || []).length
            ? `<div class="mt-24"><div class="section-label">Stated differentiators</div>
               <ul style="margin:0;padding-left:18px;color:var(--ink-2);font-size:13.5px;line-height:1.65">
               ${p.differentiators.slice(0, 4).map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>`
            : ''
        }
      </div>
      <div>
        <div class="section-label">Evidence</div>
        <dl class="kv">
          <dt>Pages read</dt><dd>${(state.scan.pages || []).length}</dd>
          <dt>Domain</dt><dd>${esc(state.scan.domain)}</dd>
          <dt>Segments</dt><dd>${state.segments.length}</dd>
        </dl>
        <div class="conf">
          <div class="conf-top"><span>Profile confidence</span><span>${conf}%</span></div>
          <div class="bar"><i style="width:${conf}%"></i></div>
          <p class="tiny muted mt-16">${
            conf >= 70
              ? 'The site gave us plenty of concrete text.'
              : 'The site gave us thin text, so treat these segments as starting hypotheses.'
          }</p>
        </div>
        ${
          (state.scan.pages || []).length
            ? `<details class="mt-16"><summary class="tiny muted" style="cursor:pointer">Pages we actually read</summary>
               <ul style="margin:8px 0 0;padding-left:16px;font-size:11.5px;color:var(--ink-4);word-break:break-all">
               ${state.scan.pages.map((pg) => `<li>${esc(pg.url)}</li>`).join('')}</ul></details>`
            : ''
        }
      </div>
    </div>
  </div>`;
}

function scanPrompt() {
  return `<div class="card card-pad mt-24">
    <div class="empty">
      <div class="empty-mark">${icons.target}</div>
      <h4>Now pick a buyer segment</h4>
      <p>Each segment is a group of buyers with a fit score. Choose one and we'll find real companies inside it.</p>
    </div>
  </div>`;
}

/* ------------------------------ segments -------------------------------- */

function segmentsView() {
  return `
  ${profileCard()}
  <div class="card mt-24">
    <div class="card-pad" style="padding-bottom:10px">
      <div class="card-head">
        <h2>Who buys this</h2>
        <span class="sub">Scored on commercial fit, not search volume</span>
      </div>
    </div>
    <div style="overflow-x:auto">
      <table class="seg-table">
        <thead>
          <tr>
            <th style="padding-left:28px">Segment</th>
            <th class="fit-cell">Fit</th>
            <th>Buyer titles</th>
            <th style="padding-right:28px"></th>
          </tr>
        </thead>
        <tbody>
          ${state.segments
            .map(
              (s) => `
            <tr>
              <td style="padding-left:28px">
                <div class="seg-name">${esc(s.name)}</div>
                <div class="seg-why">${esc(s.pain || s.rationale)}</div>
              </td>
              <td class="fit-cell">
                <div class="fit-num">${pct(s.fit_score)}<span>%</span></div>
                <div class="fit-bar ${fitClass(s.fit_score)}"><i style="width:${pct(s.fit_score)}%"></i></div>
              </td>
              <td>
                <div class="chip-row">
                  ${(s.buyer_titles || []).slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
                  ${(s.buyer_titles || []).length > 3 ? `<span class="chip">+${s.buyer_titles.length - 3}</span>` : ''}
                </div>
              </td>
              <td class="text-r" style="padding-right:28px">
                <button class="btn btn-primary btn-sm" data-act="discover" data-seg="${esc(s.id)}">Find companies ${icons.arrow}</button>
              </td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <div class="card-pad" style="padding-top:0">
      <div class="divider"></div>
      <div class="flex flex-wrap">
        <button class="btn btn-ghost btn-sm" data-act="show-import">Import a company list instead</button>
        <span class="tiny muted">Already know who you want? Paste domains and we'll verify them the same way.</span>
      </div>
      <div id="import-area" class="hidden mt-16">
        <div class="field">
          <label for="import-text">One domain per line, or <code>name, domain</code></label>
          <textarea id="import-text" rows="6" style="width:100%;padding:12px 14px;border:1px solid var(--line-2);border-radius:8px;background:#fff;font-family:ui-monospace,monospace;font-size:12.5px" placeholder="acme.com&#10;globex.com&#10;Initech, initech.io"></textarea>
        </div>
        <button class="btn btn-primary btn-sm" data-act="do-import">Verify and add</button>
        <span class="tiny muted">Free — no AI call, no credits.</span>
      </div>
    </div>
  </div>`;
}

/* ------------------------------ companies ------------------------------- */

function companiesView() {
  const sel = state.selected.size;
  return `
  ${profileCard()}
  <div class="card card-pad mt-24">
    <div class="card-head">
      <h2>Companies in "${esc(state.activeSegment || 'segment')}"</h2>
      <span class="sub">${state.companies.length} found</span>
    </div>
    ${state.notes.map((n) => notice('warn', esc(n))).join('')}
    ${
      !state.status.enrichment.configured
        ? notice(
            'info',
            `<b>Demo enrichment is active.</b> No provider key is configured, so contacts will be clearly marked as mock data. Add an Icypeas, Prospeo or Hunter key on the server to get real, verified addresses.`,
          )
        : ''
    }
    <div class="co-toolbar">
      <span class="count"><b>${sel}</b> of ${state.companies.length} selected</span>
      <div class="spacer"></div>
      <button class="btn btn-ghost btn-sm" data-act="select-all">${sel === state.companies.filter((c) => c.verified).length ? 'Clear' : 'Select all verified'}</button>
      <button class="btn btn-primary btn-sm" data-act="enrich" ${sel === 0 ? 'disabled' : ''}>
        Verify contacts · ${sel * 2} credits
      </button>
    </div>
    <div class="co-grid">
      ${state.companies
        .map((co) => {
          const isSel = state.selected.has(co.id);
          return `
        <label class="co-card ${isSel ? 'sel' : ''} ${co.verified ? '' : 'unverified'}" data-co="${esc(co.id)}">
          <input type="checkbox" data-act="toggle-co" data-id="${esc(co.id)}" ${isSel ? 'checked' : ''} ${co.verified ? '' : 'disabled'} />
          <div>
            <div class="co-name">${esc(co.name)}</div>
            <div class="co-domain">${esc(co.domain)}</div>
            ${co.why_fit ? `<div class="co-why">${esc(co.why_fit)}</div>` : ''}
            ${co.location && co.location !== 'unknown' ? `<div class="co-loc">${icons.pin}${esc(co.location)}</div>` : ''}
          </div>
          <div>${co.verified ? `<span class="badge badge-ok">${icons.check} live</span>` : `<span class="badge badge-mute">unverified</span>`}</div>
        </label>`;
        })
        .join('')}
    </div>
    <button class="btn btn-quiet btn-sm mt-24" data-act="back-segments">← Change segment</button>
  </div>`;
}

/* ------------------------------ contacts -------------------------------- */

function contactsView() {
  const real = state.contacts.filter((c) => c.email_status !== 'mock');
  const anyMock = state.contacts.some((c) => c.email_status === 'mock');
  return `
  <div class="card card-pad">
    <div class="card-head">
      <h2>Verified contacts</h2>
      <span class="sub">${state.contacts.length} contact${state.contacts.length === 1 ? '' : 's'} across ${new Set(state.contacts.map((c) => c.company)).size} companies</span>
    </div>
    ${anyMock ? notice('warn', 'Some contacts are <b>mock data</b> because no enrichment provider key is configured. They are labelled and must not be exported as real leads.') : ''}
    ${
      state.contacts.length
        ? `<div class="flex flex-wrap mt-16">
             <button class="btn btn-primary btn-sm" data-act="export">${icons.download} Export CSV</button>
             <button class="btn btn-ghost btn-sm" data-act="copy-all">Copy emails</button>
             <button class="btn btn-ghost btn-sm" data-act="restart">New scan</button>
           </div>`
        : ''
    }
  </div>

  <div class="mt-24">
    ${state.contacts
      .map(
        (ct) => `
      <article class="contact-card">
        <div class="contact-top">
          <div class="avatar">${esc(initials(ct.full_name))}</div>
          <div class="contact-id">
            <div class="contact-name">${esc(ct.full_name || 'Unknown name')}</div>
            <div class="contact-role">${esc(ct.title || 'Role not stated')} · ${esc(ct.company)}</div>
            <button class="contact-email" data-act="copy-email" data-email="${esc(ct.email)}" title="Click to copy">
              ${esc(ct.email)} ${icons.copy}
            </button>
          </div>
          <div class="flex" style="gap:6px;flex-wrap:wrap;justify-content:flex-end">
            ${
              ct.email_status === 'verified'
                ? `<span class="badge badge-ok">${icons.check} verified</span>`
                : ct.email_status === 'mock'
                  ? `<span class="badge badge-warn">mock data</span>`
                  : `<span class="badge badge-mute">${esc(ct.email_status || 'unknown')}</span>`
            }
            <span class="badge badge-gold">${esc(ct.provider || 'unknown')}</span>
          </div>
        </div>
        ${
          ct.personal_line
            ? `<div class="pitch">
                 <div class="pitch-label">Grounded opening line</div>
                 <q>${esc(ct.personal_line)}</q>
                 ${ct.personal_evidence ? `<div class="pitch-evidence">Based on: ${esc(ct.personal_evidence)}</div>` : ''}
               </div>`
            : `<div class="pitch"><div class="pitch-label">Grounded opening line</div>
                 <span class="muted tiny">No specific, verifiable detail was found on this company's site, so we left it blank instead of inventing one. Use a generic opener.</span></div>`
        }
      </article>`,
      )
      .join('')}
  </div>`;
}

/* ------------------------------------------------------------------ *
 * Flows
 * ------------------------------------------------------------------ */

async function loadStatus() {
  try {
    state.status = await api('/api/status');
    state.user = state.status.authenticated ? (await api('/api/auth/me')).user : null;
  } catch {
    /* offline / first boot */
  }
}

function requireAuthThen(fn) {
  if (state.user) return fn();
  state.pendingAction = fn;
  state.authMode = 'signup';
  state.showAuth = true;
  render();
}

async function doScan(url, focus) {
  const clean = normalizeUrl(url);
  if (!clean) {
    toast('Enter a website URL first.', 'error');
    return;
  }
  state.scanDomain = clean.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  state.busy = 'scan';
  state.notes = [];
  state.segments = [];
  state.companies = [];
  state.contacts = [];
  state.selected.clear();
  state.view = 'app';
  render();

  try {
    const res = await api('/api/scans', { method: 'POST', body: JSON.stringify({ url: clean, focus }) });
    const detail = await api('/api/scans/' + res.scanId);
    state.scan = detail.scan;
    state.segments = detail.segments || [];
    state.notes = (detail.scan.profile && detail.scan.profile.notes) || [];
    if (state.user) state.user.credits = res.balance;
    state.busy = null;
    render();
    toast(`Found ${state.segments.length} buyer segment${state.segments.length === 1 ? '' : 's'}.`, 'ok');
  } catch (e) {
    state.busy = null;
    render();
    toast(e.message || 'The scan failed.', 'error');
    if (e.detail && typeof e.detail.balance === 'number' && state.user) state.user.credits = e.detail.balance;
    render();
  }
}

async function doDiscover(segmentId) {
  state.busy = 'discover';
  state.notes = [];
  render();
  try {
    const res = await api(`/api/scans/${state.scan.id}/discover`, {
      method: 'POST',
      body: JSON.stringify({ segmentId }),
    });
    state.notes = res.notes || [];
    const detail = await api('/api/scans/' + state.scan.id);
    // Load the segment's companies
    const seg = state.segments.find((s) => s.id === segmentId);
    state.activeSegment = seg ? seg.name : res.segment;
    state.companies = await fetchCompanies(segmentId);
    state.selected.clear();
    state.busy = null;
    render();
    const v = state.companies.filter((c) => c.verified).length;
    toast(`${v} live compan${v === 1 ? 'y' : 'ies'} verified.`, 'ok');
    void detail;
  } catch (e) {
    state.busy = null;
    render();
    toast(e.message || 'Discovery failed.', 'error');
  }
}

async function fetchCompanies(segmentId) {
  const res = await api(`/api/scans/${state.scan.id}/companies?segmentId=${encodeURIComponent(segmentId)}`);
  return res.companies || [];
}

async function doImport(text) {
  state.busy = 'discover';
  render();
  try {
    const res = await api(`/api/scans/${state.scan.id}/discover`, {
      method: 'POST',
      body: JSON.stringify({ importText: text }),
    });
    state.notes = res.notes || [];
    state.activeSegment = 'Imported list';
    state.companies = await fetchCompanies('imported');
    state.selected.clear();
    state.busy = null;
    render();
    toast(`Verified ${state.companies.filter((c) => c.verified).length} of ${state.companies.length} domains.`, 'ok');
  } catch (e) {
    state.busy = null;
    render();
    toast(e.message || 'Import failed.', 'error');
  }
}

async function doEnrich() {
  const ids = [...state.selected];
  if (!ids.length) return;
  state.busy = 'enrich';
  render();
  try {
    const res = await api(`/api/scans/${state.scan.id}/enrich`, {
      method: 'POST',
      body: JSON.stringify({ companyIds: ids }),
    });
    const flat = [];
    for (const r of res.results || []) {
      for (const c of r.contacts || []) {
        flat.push({ ...c, company: r.company, domain: r.domain });
      }
    }
    state.contacts = flat;
    if (state.user && typeof res.balance === 'number') state.user.credits = res.balance;
    state.busy = null;
    render();
    if (flat.length === 0) toast('No verified contacts found for those companies. Credits refunded.', 'error');
    else toast(`${flat.length} contact${flat.length === 1 ? '' : 's'} ready.`, 'ok');
  } catch (e) {
    state.busy = null;
    render();
    toast(e.message || 'Enrichment failed.', 'error');
  }
}

/* ------------------------------------------------------------------ *
 * Event delegation
 * ------------------------------------------------------------------ */

document.addEventListener('click', async (ev) => {
  const stop = ev.target.closest('[data-stop]');
  const el = ev.target.closest('[data-act]');
  if (!el) return;

  const act = el.getAttribute('data-act');

  // Overlay: only close when the backdrop itself (or an explicit close) is hit.
  if (act === 'overlay-close') {
    if (stop) return;
    if (ev.target === el || el.classList.contains('modal-close') || el.dataset.act === 'overlay-close') {
      if (ev.target === el) {
        state.showAuth = false;
        state.pendingAction = null;
        render();
      } else if (el.classList.contains('modal-close')) {
        state.showAuth = false;
        state.pendingAction = null;
        render();
      }
    }
    return;
  }

  if (act === 'home') {
    ev.preventDefault();
    state.view = state.user ? 'app' : 'landing';
    state.scan = null;
    state.segments = [];
    state.companies = [];
    state.contacts = [];
    state.selected.clear();
    state.notes = [];
    render();
    return;
  }

  if (act === 'open-signup' || act === 'open-login') {
    state.authMode = act === 'open-signup' ? 'signup' : 'login';
    state.showAuth = true;
    render();
    setTimeout(() => document.getElementById('auth-email')?.focus(), 60);
    return;
  }

  if (act === 'switch-auth') {
    state.authMode = state.authMode === 'signup' ? 'login' : 'signup';
    render();
    return;
  }

  if (act === 'hero-scan') {
    const url = document.getElementById('hero-url')?.value || '';
    if (!url.trim()) {
      toast('Enter a website URL first.', 'error');
      return;
    }
    requireAuthThen(() => {
      state.view = 'app';
      doScan(url, '');
    });
    return;
  }

  if (act === 'scan') {
    const url = document.getElementById('app-url')?.value || '';
    const focus = document.getElementById('app-focus')?.value || '';
    doScan(url, focus.trim());
    return;
  }

  if (act === 'discover') {
    doDiscover(el.getAttribute('data-seg'));
    return;
  }

  if (act === 'show-import') {
    document.getElementById('import-area')?.classList.toggle('hidden');
    return;
  }

  if (act === 'do-import') {
    const text = document.getElementById('import-text')?.value || '';
    if (!text.trim()) {
      toast('Paste at least one domain.', 'error');
      return;
    }
    doImport(text);
    return;
  }

  if (act === 'toggle-co') {
    ev.preventDefault();
    const id = el.getAttribute('data-id');
    if (el.disabled) return;
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    render();
    return;
  }

  if (act === 'select-all') {
    const verified = state.companies.filter((c) => c.verified).map((c) => c.id);
    if (state.selected.size >= verified.length && verified.length > 0) state.selected.clear();
    else verified.forEach((id) => state.selected.add(id));
    render();
    return;
  }

  if (act === 'enrich') {
    doEnrich();
    return;
  }

  if (act === 'back-segments') {
    state.companies = [];
    state.selected.clear();
    state.notes = [];
    render();
    return;
  }

  if (act === 'export') {
    window.location.href = `/api/scans/${state.scan.id}/export`;
    return;
  }

  if (act === 'copy-email') {
    const email = el.getAttribute('data-email') || '';
    try {
      await navigator.clipboard.writeText(email);
      toast('Email copied.', 'ok');
    } catch {
      toast('Could not copy — select it manually.', 'error');
    }
    return;
  }

  if (act === 'copy-all') {
    const emails = state.contacts.map((c) => c.email).filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(emails);
      toast(`${state.contacts.length} emails copied.`, 'ok');
    } catch {
      toast('Could not copy.', 'error');
    }
    return;
  }

  if (act === 'restart') {
    state.scan = null;
    state.segments = [];
    state.companies = [];
    state.contacts = [];
    state.selected.clear();
    state.notes = [];
    render();
    return;
  }

  if (act === 'history') {
    try {
      const res = await api('/api/scans');
      const items = (res.scans || []).filter((s) => s.status === 'ready');
      if (!items.length) {
        toast('No completed scans yet.');
        return;
      }
      let box = document.getElementById('history-modal');
      box?.remove();
      box = document.createElement('div');
      box.id = 'history-modal';
      box.className = 'overlay';
      box.innerHTML = `<div class="modal" data-stop="1" style="max-width:520px">
        <button class="modal-close" data-act="close-history" aria-label="Close">${icons.x}</button>
        <h3>Past scans</h3>
        <p class="lede">Reopen a previous result. Cached scans cost nothing to view.</p>
        <div>${items
          .map(
            (s) => `<div class="hist-item" data-act="open-scan" data-id="${esc(s.id)}">
              <div style="flex:1">
                <div class="hist-domain">${esc(s.domain || s.input_url)}</div>
                <div class="hist-meta">${esc(relTime(s.created_at))} · ${s.company_count || 0} companies</div>
              </div>
              <span class="tiny muted">open →</span>
            </div>`,
          )
          .join('')}</div>
      </div>`;
      document.body.appendChild(box);
    } catch (e) {
      toast('Could not load history.', 'error');
    }
    return;
  }

  if (act === 'close-history') {
    document.getElementById('history-modal')?.remove();
    return;
  }

  if (act === 'open-scan') {
    document.getElementById('history-modal')?.remove();
    try {
      const detail = await api('/api/scans/' + el.getAttribute('data-id'));
      state.scan = detail.scan;
      state.segments = detail.segments || [];
      state.companies = [];
      state.contacts = [];
      state.selected.clear();
      state.notes = (detail.scan.profile && detail.scan.profile.notes) || [];
      state.view = 'app';
      render();
    } catch (e) {
      toast('Could not open that scan.', 'error');
    }
    return;
  }

  if (act === 'logout') {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    state.user = null;
    state.view = 'landing';
    state.scan = null;
    state.segments = [];
    state.companies = [];
    state.contacts = [];
    state.selected.clear();
    render();
    toast('Signed out.');
    return;
  }
});

/* ------------------------------ auth form ------------------------------ */

document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'auth-form') return;
  ev.preventDefault();

  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errBox = document.getElementById('auth-err');
  const btn = document.getElementById('auth-submit');

  errBox.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Please wait…';

  try {
    const path = state.authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    const res = await api(path, { method: 'POST', body: JSON.stringify({ email, password }) });
    state.user = res.user;
    state.showAuth = false;
    const next = state.pendingAction;
    state.pendingAction = null;
    if (next) next();
    else {
      state.view = 'app';
      render();
    }
    toast(state.authMode === 'signup' ? 'Account created. 25 credits added.' : 'Welcome back.', 'ok');
  } catch (e) {
    errBox.textContent = e.message;
    errBox.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = state.authMode === 'signup' ? 'Create account' : 'Sign in';
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (state.showAuth) {
      state.showAuth = false;
      state.pendingAction = null;
      render();
    }
    document.getElementById('history-modal')?.remove();
  }
  // Enter to submit the hero URL
  if (ev.key === 'Enter' && ev.target.id === 'hero-url') {
    document.querySelector('[data-act="hero-scan"]')?.click();
  }
  if (ev.key === 'Enter' && ev.target.id === 'app-url') {
    document.querySelector('[data-act="scan"]')?.click();
  }
});

/* ------------------------------ boot ----------------------------------- */

(async function boot() {
  await loadStatus();
  state.view = state.user ? 'app' : 'landing';
  render();

  // If the landing CTA was used while signed out, resume that intent.
  const params = new URLSearchParams(location.search);
  const urlParam = params.get('url');
  if (urlParam) {
    const input = document.getElementById('hero-url');
    if (input) input.value = urlParam;
  }
})();
