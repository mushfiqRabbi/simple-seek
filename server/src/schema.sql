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
