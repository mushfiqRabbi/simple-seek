import Database from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

/**
 * Initialize SQLite database and run schema migrations.
 */
export function initDatabase(dbPath) {
  const resolvedPath = dbPath || join(__dirname, "..", "data", "simpleseek.db");

  // Ensure the data directory exists
  const dataDir = dirname(resolvedPath);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Run schema
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);

  console.log(`[db] SQLite initialized at ${resolvedPath}`);
  return db;
}

/**
 * Get the database instance.
 */
export function getDb() {
  if (!db) throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

/**
 * Insert a new job record.
 * Returns the inserted job row.
 */
export function insertJob({
  url,
  company,
  title,
  location,
  deadline,
  role_type,
  job_id,
  summary,
  markdown,
  raw_html,
  raw_pi_response,
  source_domain,
}) {
  const stmt = db.prepare(`
    INSERT INTO jobs (url, company, title, location, deadline, role_type, job_id, summary, markdown, raw_html, raw_pi_response, source_domain)
    VALUES (@url, @company, @title, @location, @deadline, @role_type, @job_id, @summary, @markdown, @raw_html, @raw_pi_response, @source_domain)
  `);

  const info = stmt.run({
    url,
    company: company ?? null,
    title: title ?? null,
    location: location ?? null,
    deadline: deadline ?? null,
    role_type: role_type ?? null,
    job_id: job_id ?? null,
    summary: summary ?? null,
    markdown: markdown ?? null,
    raw_html: raw_html ?? null,
    raw_pi_response: raw_pi_response ?? null,
    source_domain: source_domain ?? null,
  });

  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(info.lastInsertRowid);
}

/**
 * Find a duplicate job using a priority-based matching strategy.
 * Returns the matched job row or null.
 */
export function findDuplicate({ url, company, title, job_id }) {
  // Priority 1: URL exact match
  const byUrl = db.prepare("SELECT * FROM jobs WHERE url = ? ORDER BY applied_at DESC LIMIT 1");
  const urlMatch = byUrl.get(url);
  if (urlMatch) return urlMatch;

  // Priority 2: Job ID match (if present)
  if (job_id) {
    const byJobId = db.prepare(
      "SELECT * FROM jobs WHERE job_id = ? AND job_id IS NOT NULL ORDER BY applied_at DESC LIMIT 1"
    );
    const jobIdMatch = byJobId.get(job_id);
    if (jobIdMatch) return jobIdMatch;
  }

  // Priority 3: Company + Title exact match (case-insensitive)
  if (company && title) {
    const byCompanyTitle = db.prepare(
      "SELECT * FROM jobs WHERE LOWER(company) = LOWER(?) AND LOWER(title) = LOWER(?) ORDER BY applied_at DESC LIMIT 1"
    );
    const companyTitleMatch = byCompanyTitle.get(company, title);
    if (companyTitleMatch) return companyTitleMatch;
  }

  // No duplicate found
  return null;
}

/**
 * Get all jobs with optional pagination.
 */
export function getAllJobs({ limit = 50, offset = 0 } = {}) {
  const stmt = db.prepare(
    "SELECT * FROM jobs ORDER BY applied_at DESC LIMIT ? OFFSET ?"
  );
  return stmt.all(limit, offset);
}

/**
 * Get a job by ID.
 */
export function getJobById(id) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
}

/**
 * Update job status.
 */
export function updateJobStatus(id, status) {
  db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, id);
  return getJobById(id);
}

/**
 * Update a job's editable fields.
 * Fields: status, company, title, location, deadline, role_type, summary
 * Returns the updated job row.
 */
export function updateJob(id, fields) {
  const allowed = ["status", "company", "title", "location", "deadline", "role_type", "summary"];
  const updates = [];
  const values = [];

  for (const field of allowed) {
    if (fields[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(fields[field]);
    }
  }

  if (updates.length === 0) return getJobById(id);

  values.push(id);
  db.prepare(`UPDATE jobs SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  return getJobById(id);
}

/**
 * Delete a job by ID.
 * Returns true if a row was deleted.
 */
export function deleteJob(id) {
  const info = db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  return info.changes > 0;
}

/**
 * Get total count of jobs.
 */
export function getJobCount() {
  const row = db.prepare("SELECT COUNT(*) as count FROM jobs").get();
  return row.count;
}
