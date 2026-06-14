CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT    NOT NULL,                -- Page URL where job was found
  company         TEXT,                             -- Extracted by Pi via LLM
  title           TEXT,                             -- Extracted by Pi via LLM
  location        TEXT,                             -- Extracted by Pi via LLM
  deadline        TEXT,                             -- Application deadline (extracted by Pi)
  role_type       TEXT,                             -- "Full-time", "Contract", "Internship", etc.
  job_id          TEXT,                             -- Requisition / Job ID from posting
  summary         TEXT,                             -- 1-2 sentence LLM summary
  markdown        TEXT,                             -- HTML converted to markdown
  raw_html        TEXT,                             -- Original HTML sent by extension
  raw_pi_response TEXT,                             -- Full response from Pi agent (for debugging)
  status          TEXT    DEFAULT 'applied',        -- applied | rejected | interviewing | offer
  applied_at      TEXT    DEFAULT (datetime('now')),
  source_domain   TEXT                              -- e.g. "linkedin.com", "greenhouse.io"
);

CREATE INDEX IF NOT EXISTS idx_jobs_url ON jobs(url);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
CREATE INDEX IF NOT EXISTS idx_jobs_company_title ON jobs(company, title);
CREATE INDEX IF NOT EXISTS idx_jobs_job_id ON jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_applied_at ON jobs(applied_at);

-- Audit logs: tracks extraction gaps found during automated audits
-- Each row represents one field of one job checked in one audit run
CREATE TABLE IF NOT EXISTS audit_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT    NOT NULL,              -- UUID grouping logs from one audit run
  job_id            INTEGER NOT NULL,
  field             TEXT    NOT NULL,              -- 'role_type', 'location', 'job_id', 'deadline', 'company', 'title', 'summary'
  status            TEXT    NOT NULL,              -- 'ok', 'missing', 'mismatch', 'na'
  found_value       TEXT,                          -- what was found in raw HTML (e.g. 'Full-time')
  stored_value      TEXT,                         -- what was actually stored in DB (e.g. 'null')
  source            TEXT,                          -- 'llm' (Pi/LLM extraction)
  note              TEXT,                          -- human-readable explanation of the gap
  resolved          INTEGER DEFAULT 0,             -- 1 = data auto-patched into job's DB field
  extraction_fixed  INTEGER DEFAULT 0,             -- 0 = extraction code not fixed, 1 = fixed by resolve skill
  created_at        TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_job_id ON audit_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_audit_field ON audit_logs(field);
CREATE INDEX IF NOT EXISTS idx_audit_status ON audit_logs(status);
CREATE INDEX IF NOT EXISTS idx_audit_resolved ON audit_logs(resolved);
CREATE INDEX IF NOT EXISTS idx_audit_run_id ON audit_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
