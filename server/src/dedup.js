/**
 * Job Duplication Detection
 *
 * Thin wrapper around db.js findDuplicate() with logging.
 * Matching priority: URL → Job ID → Company + Title (case-insensitive).
 */

import { findDuplicate, insertJob } from "./db.js";

/**
 * Check if a job is a duplicate of an existing entry.
 *
 * @param {object} jobInfo - Extracted job information
 * @param {string} jobInfo.url - Page URL
 * @param {string|null} jobInfo.company - Company name
 * @param {string|null} jobInfo.title - Job title
 * @param {string|null} jobInfo.job_id - Requisition/Job ID
 * @returns {object|null} The matched job record, or null if no duplicate
 */
export function checkDuplicate(jobInfo) {
  const duplicate = findDuplicate({
    url: jobInfo.url,
    company: jobInfo.company,
    title: jobInfo.title,
    job_id: jobInfo.job_id,
  });

  if (duplicate) {
    console.log(
      `[dedup] DUPLICATE FOUND: "${duplicate.title}" at ${duplicate.company} ` +
      `(applied ${duplicate.applied_at}) — strategy: ${duplicate._matchStrategy || "auto"}`
    );
  }

  return duplicate;
}

/**
 * Store a new job and return the saved record.
 *
 * @param {object} data - All job data to persist
 * @returns {object} The inserted job row
 */
export function saveNewJob(data) {
  const job = insertJob(data);
  console.log(`[dedup] New job saved: id=${job.id}, "${job.title}" at ${job.company}`);
  return job;
}
