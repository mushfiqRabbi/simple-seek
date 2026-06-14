/**
 * SimpleSeek Database — Turso (Hosted SQLite)
 *
 * Uses @libsql/client to connect to a remote Turso database.
 * Replaces the previous local better-sqlite3 implementation.
 * All functions are async.
 */

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

/**
 * Initialize the Turso database client and run schema migrations.
 * Reads TURSO_DB_URL and TURSO_AUTH_TOKEN from environment variables.
 */
export async function initDatabase() {
  const url = process.env.TURSO_DB_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    throw new Error(
      "TURSO_DB_URL is not set. Add it to server/.env or environment variables."
    );
  }
  if (!authToken) {
    throw new Error(
      "TURSO_AUTH_TOKEN is not set. Add it to server/.env or environment variables."
    );
  }

  db = createClient({ url, authToken });

  // Run schema — SQLite-compatible, Turso handles it
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
  await db.executeMultiple(schema);

  console.log(`[db] Turso connected: ${url}`);
  return db;
}

/**
 * Get the database client instance.
 */
export function getDb() {
  if (!db) throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

/**
 * Convert a Turso Row object to a plain object.
 * Turso rows are iterable key-value pairs — this ensures
 * we always return plain objects consistent with the old API.
 */
function toPlain(row) {
  if (!row) return null;
  // Row objects spread cleanly
  return { ...row };
}

/**
 * Execute a single SQL statement with positional args.
 * Shorthand that matches the old prepare/run/get mental model.
 */
async function query(sql, args = []) {
  return db.execute({ sql, args });
}

/**
 * Insert a new job record.
 * Returns the inserted job row.
 */
export async function insertJob({
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
  const result = await query(
    `INSERT INTO jobs (url, company, title, location, deadline, role_type, job_id, summary, markdown, raw_html, raw_pi_response, source_domain)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      url,
      company ?? null,
      title ?? null,
      location ?? null,
      deadline ?? null,
      role_type ?? null,
      job_id ?? null,
      summary ?? null,
      markdown ?? null,
      raw_html ?? null,
      raw_pi_response ?? null,
      source_domain ?? null,
    ]
  );

  const selectResult = await query("SELECT * FROM jobs WHERE id = ?", [result.lastInsertRowid]);
  return toPlain(selectResult.rows[0]);
}

/**
 * Find a duplicate job using a priority-based matching strategy.
 * Returns the matched job row or null.
 *
 * Priority: URL → Job ID → Company + Title (case-insensitive)
 */
export async function findDuplicate({ url, company, title, job_id }) {
  // Priority 1: URL exact match
  const urlResult = await query(
    "SELECT * FROM jobs WHERE url = ? ORDER BY applied_at DESC LIMIT 1",
    [url]
  );
  if (urlResult.rows[0]) return toPlain(urlResult.rows[0]);

  // Priority 2: Job ID match (if present)
  if (job_id) {
    const jobIdResult = await query(
      "SELECT * FROM jobs WHERE job_id = ? AND job_id IS NOT NULL ORDER BY applied_at DESC LIMIT 1",
      [job_id]
    );
    if (jobIdResult.rows[0]) return toPlain(jobIdResult.rows[0]);
  }

  // Priority 3: Company + Title exact match (case-insensitive)
  if (company && title) {
    const companyTitleResult = await query(
      "SELECT * FROM jobs WHERE LOWER(company) = LOWER(?) AND LOWER(title) = LOWER(?) ORDER BY applied_at DESC LIMIT 1",
      [company, title]
    );
    if (companyTitleResult.rows[0]) return toPlain(companyTitleResult.rows[0]);
  }

  // No duplicate found
  return null;
}

/**
 * Get all jobs with optional pagination.
 */
export async function getAllJobs({ limit = 50, offset = 0 } = {}) {
  const result = await query(
    "SELECT * FROM jobs ORDER BY applied_at DESC LIMIT ? OFFSET ?",
    [limit, offset]
  );
  return result.rows.map(toPlain);
}

/**
 * Get a job by ID.
 */
export async function getJobById(id) {
  const result = await query("SELECT * FROM jobs WHERE id = ?", [id]);
  return toPlain(result.rows[0]);
}

/**
 * Update job status.
 */
export async function updateJobStatus(id, status) {
  await query("UPDATE jobs SET status = ? WHERE id = ?", [status, id]);
  return getJobById(id);
}

/**
 * Update a job's editable fields.
 * Fields: status, company, title, location, deadline, role_type, summary
 * Returns the updated job row.
 */
export async function updateJob(id, fields) {
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
  await query(
    `UPDATE jobs SET ${updates.join(", ")} WHERE id = ?`,
    values
  );
  return getJobById(id);
}

/**
 * Delete a job by ID.
 * Returns true if a row was deleted.
 */
export async function deleteJob(id) {
  const result = await query("DELETE FROM jobs WHERE id = ?", [id]);
  return result.rowsAffected > 0;
}

/**
 * Get total count of jobs.
 */
export async function getJobCount() {
  const result = await query("SELECT COUNT(*) as count FROM jobs");
  return Number(result.rows[0]?.count ?? 0);
}
