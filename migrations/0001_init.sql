-- Nectary core schema
-- Design notes:
--  * every tenant-owned row carries user_id (defence in depth against IDOR)
--  * credits are a ledger, not a counter users can write to
--  * contacts carry provenance (provider, confidence) so nothing is unattributed
--  * suppression table is the legal "do not contact" spine (GDPR/POPIA)

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'trial',
  credits       INTEGER NOT NULL DEFAULT 25,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS scans (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  input_url     TEXT NOT NULL,
  domain        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|running|ready|failed
  error         TEXT,
  profile_json  TEXT,       -- business profile extracted server-side
  pages_json    TEXT,       -- which pages were read (audit / evidence)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_scans_user ON scans(user_id, created_at DESC);
-- Re-scans of the same domain by the same user are served from cache (cost control).
CREATE INDEX IF NOT EXISTS idx_scans_domain ON scans(user_id, domain, status);

CREATE TABLE IF NOT EXISTS segments (
  id            TEXT PRIMARY KEY,
  scan_id       TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  fit_score     INTEGER NOT NULL,
  rationale     TEXT,
  buyer_titles  TEXT,       -- JSON array
  pain          TEXT,
  signal        TEXT,       -- why now / buying trigger
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_segments_scan ON segments(scan_id);

CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,
  scan_id       TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  segment_id    TEXT,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  domain        TEXT NOT NULL,
  website       TEXT,
  location      TEXT,
  fit_score     INTEGER NOT NULL DEFAULT 0,
  why_fit       TEXT,
  evidence_url  TEXT,
  source        TEXT NOT NULL DEFAULT 'ai_proposed', -- ai_proposed|import|osm
  verified      INTEGER NOT NULL DEFAULT 0,          -- 1 = we fetched the domain ourselves
  verify_note   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scan_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_companies_segment ON companies(segment_id);
CREATE INDEX IF NOT EXISTS idx_companies_user ON companies(user_id);

CREATE TABLE IF NOT EXISTS contacts (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  full_name     TEXT,
  title         TEXT,
  email         TEXT,
  email_status  TEXT,      -- verified|guessed|unknown|mock
  linkedin      TEXT,
  provider      TEXT,      -- icypeas|prospeo|hunter|mock
  confidence    INTEGER NOT NULL DEFAULT 0,
  personal_line TEXT,
  personal_evidence TEXT,  -- the fetched fact the line is grounded in
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);

CREATE TABLE IF NOT EXISTS ledger (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  delta         INTEGER NOT NULL,   -- negative = spend, positive = grant/refund
  balance_after INTEGER NOT NULL,
  kind          TEXT NOT NULL,      -- grant|scan|enrich|refund|adjust
  ref           TEXT,
  meta          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS suppression (
  email      TEXT PRIMARY KEY,
  reason     TEXT,
  added_by   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  action     TEXT NOT NULL,
  meta       TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at DESC);

-- Cached domain reads so a re-scan costs zero outbound requests.
CREATE TABLE IF NOT EXISTS domain_cache (
  domain     TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
