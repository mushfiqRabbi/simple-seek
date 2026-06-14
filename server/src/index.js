/**
 * SimpleSeek Server
 *
 * Express API server that:
 * 1. Receives raw HTML from the Chrome extension
 * 2. Converts it to Markdown
 * 3. Sends it to Pi (in RPC mode) for structured data extraction
 * 4. Checks for duplicates in SQLite
 * 5. Stores new jobs and returns the result
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { initDatabase } from "./db.js";
import { PiRPCClient } from "./pi-client.js";
import { extractJobInfo } from "./extractor.js";
import { checkDuplicate, saveNewJob } from "./dedup.js";
import { getAllJobs, getJobCount, updateJob, deleteJob, getJobById, getAuditLogs, getAuditStats, resolveAuditLog, getUnresolvedAuditLogs, deleteAuditLogsByJobId, getAuditLogById, markExtractionFixed, query } from "./db.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;

// ─── Global State ────────────────────────────────────────────────────────────

let piClient;

// ─── App Setup ───────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" })); // HTML can be large

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/check-job
 *
 * Main endpoint: receives raw HTML from the extension, checks for duplicates,
 * and optionally stores new jobs.
 *
 * Request:  { html: string, url: string, action?: "check"|"apply" }
 *           action="check"  — only check for duplicates, don't save
 *           action="apply"  — check and save if new (default)
 * Response: { status: "duplicate"|"new", message: string, job?: object, existingJob?: object }
 */
app.post("/api/check-job", async (req, res) => {
  try {
    const { html, url, action } = req.body;

    // Validate
    if (!html || !url) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: html, url",
      });
    }

    const isCheckOnly = action === "check";

    // Step 1: Extract structured info via Pi
    console.log(`[api] Processing job from: ${url} (action=${action || "apply"})`);
    const { extracted, markdown, sourceDomain } = await extractJobInfo(html, url, piClient);

    // Step 2: Check for duplicates
    const duplicate = await checkDuplicate({
      url,
      company: extracted.company,
      title: extracted.title,
      job_id: extracted.job_id,
    });

    if (duplicate) {
      return res.json({
        status: "duplicate",
        message: `You already applied to this job on ${duplicate.applied_at}`,
        existingJob: {
          id: duplicate.id,
          company: duplicate.company,
          title: duplicate.title,
          location: duplicate.location,
          applied_at: duplicate.applied_at,
        },
      });
    }

    // If check-only mode, return without saving
    if (isCheckOnly) {
      return res.json({
        status: "new",
        message: "No duplicate found — this job hasn't been applied to yet.",
        job: {
          company: extracted.company,
          title: extracted.title,
          location: extracted.location,
          deadline: extracted.deadline,
          role_type: extracted.role_type,
        },
      });
    }

    // Step 3: Store the new job
    const saved = await saveNewJob({
      url,
      company: extracted.company,
      title: extracted.title,
      location: extracted.location,
      deadline: extracted.deadline,
      role_type: extracted.role_type,
      job_id: extracted.job_id,
      summary: extracted.summary,
      markdown,
      raw_html: html,
      raw_pi_response: JSON.stringify(extracted),
      source_domain: sourceDomain,
    });

    return res.json({
      status: "new",
      message: "New job saved!",
      job: {
        id: saved.id,
        company: saved.company,
        title: saved.title,
        location: saved.location,
        deadline: saved.deadline,
        role_type: saved.role_type,
      },
    });
  } catch (err) {
    console.error(`[api] Error processing job:`, err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
      error: err.message,
    });
  }
});

/**
 * GET /api/jobs
 *
 * List all applied jobs (for debugging and verification).
 * Supports pagination via ?limit=50&offset=0
 */
app.get("/api/jobs", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const jobs = await getAllJobs({ limit, offset });
    const total = await getJobCount();

    res.json({ jobs, total, limit, offset });
  } catch (err) {
    console.error(`[api] Error listing jobs:`, err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

/**
 * GET /dashboard
 *
 * Simple dashboard for viewing applied jobs.
 */
app.get(["/", "/dashboard"], (req, res) => {
  const html = readFileSync(join(__dirname, "dashboard.html"), "utf8");
  res.type("html").send(html);
});

/**
 * PUT /api/jobs/:id
 *
 * Update a job's fields (status, company, title, location, deadline, role_type, summary).
 */
app.put("/api/jobs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ status: "error", message: "Invalid job ID" });
    }

    const existing = await getJobById(id);
    if (!existing) {
      return res.status(404).json({ status: "error", message: "Job not found" });
    }

    const updated = await updateJob(id, req.body);
    console.log(`[api] Updated job ${id}:`, JSON.stringify(req.body));
    res.json({ status: "ok", job: updated });
  } catch (err) {
    console.error(`[api] Error updating job:`, err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

/**
 * DELETE /api/jobs/:id
 *
 * Delete a job by ID.
 */
app.delete("/api/jobs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ status: "error", message: "Invalid job ID" });
    }

    const deleted = await deleteJob(id);
    if (!deleted) {
      return res.status(404).json({ status: "error", message: "Job not found" });
    }

    // Also clean up associated audit logs
    const auditRemoved = await deleteAuditLogsByJobId(id);

    console.log(`[api] Deleted job ${id} (also removed ${auditRemoved} audit log(s))`);
    res.json({ status: "ok", message: "Job deleted" });
  } catch (err) {
    console.error(`[api] Error deleting job:`, err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ─── Audit Routes ───────────────────────────────────────────────────────────-

/**
 * GET /api/audit
 *
 * List audit logs with optional filters.
 * Query params: job_id, field, status, resolved, run_id, limit, offset
 */
app.get("/api/audit", async (req, res) => {
  try {
    const filters = {};
    if (req.query.job_id) filters.job_id = parseInt(req.query.job_id);
    if (req.query.field) filters.field = req.query.field;
    if (req.query.status) filters.status = req.query.status;
    if (req.query.resolved !== undefined) filters.resolved = parseInt(req.query.resolved);
    if (req.query.extraction_fixed !== undefined) filters.extraction_fixed = parseInt(req.query.extraction_fixed);
    if (req.query.run_id) filters.run_id = req.query.run_id;
    filters.limit = parseInt(req.query.limit) || 50;
    filters.offset = parseInt(req.query.offset) || 0;

    const logs = await getAuditLogs(filters);
    res.json({ logs, ...filters });
  } catch (err) {
    console.error(`[api] Error listing audit logs:`, err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

/**
 * GET /api/audit/stats
 *
 * Aggregate audit statistics (open gaps by field, latest run info, etc.)
 */
app.get("/api/audit/stats", async (req, res) => {
  try {
    const stats = await getAuditStats();
    res.json(stats);
  } catch (err) {
    console.error(`[api] Error getting audit stats:`, err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

/**
 * GET /api/audit/unresolved
 *
 * Get all unresolved audit logs (for the resolve skill).
 */
app.get("/api/audit/unresolved", async (req, res) => {
  try {
    const logs = await getUnresolvedAuditLogs();
    res.json({ logs });
  } catch (err) {
    console.error(`[api] Error getting unresolved audit logs:`, err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

/**
 * PUT /api/audit/:id/resolve
 *
 * Mark an audit log entry as resolved (acknowledged only, no data change).
 */
app.put("/api/audit/:id/resolve", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ status: "error", message: "Invalid audit log ID" });
    }

    const updated = await resolveAuditLog(id);
    if (!updated) {
      return res.status(404).json({ status: "error", message: "Audit log not found" });
    }

    console.log(`[api] Resolved audit log ${id}`);
    res.json({ status: "ok", log: updated });
  } catch (err) {
    console.error(`[api] Error resolving audit log:`, err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

/**
 * PUT /api/audit/:id/apply
 *
 * Apply an audit log's found_value to the job's DB field, then mark resolved.
 * This is what the resolve skill uses to fix missing data after improving
 * the extraction pipeline.
 *
 * The body can optionally include a 'value' override. If not set, uses
 * the audit log's found_value.
 */
app.put("/api/audit/:id/apply", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ status: "error", message: "Invalid audit log ID" });
    }

    // Fetch the audit log
    const log = await getAuditLogById(id);
    if (!log) {
      return res.status(404).json({ status: "error", message: "Audit log not found" });
    }

    if (log.status !== "missing" && log.status !== "mismatch") {
      return res.status(400).json({ status: "error", message: `Audit log status is "${log.status}", nothing to apply` });
    }

    if (log.resolved === 1) {
      return res.status(400).json({ status: "error", message: "Audit log is already resolved" });
    }

    const field = log.field;
    const value = req.body.value !== undefined ? req.body.value : log.found_value;

    if (!value) {
      return res.status(400).json({ status: "error", message: "No value to apply (found_value is null, provide a 'value' in request body)" });
    }

    const allowedFields = ["company", "title", "location", "deadline", "role_type", "summary", "job_id"];
    if (!allowedFields.includes(field)) {
      return res.status(400).json({ status: "error", message: `Field "${field}" cannot be updated directly. Fix the extraction code instead.` });
    }

    // Update the job's field
    const jobId = log.job_id;
    const updateData = {};
    updateData[field] = value;

    const job = await getJobById(jobId);
    if (!job) {
      return res.status(404).json({ status: "error", message: `Job #${jobId} not found (may have been deleted)` });
    }

    const updatedJob = await updateJob(jobId, updateData);

    // Mark the audit log as resolved
    await resolveAuditLog(id);

    console.log(`[api] Applied fix: job #${jobId} ${field} = "${value}" (from audit log #${id})`);

    res.json({
      status: "ok",
      message: `Job #${jobId} ${field} updated to "${value}"`,
      job: updatedJob,
      auditLogId: id,
    });
  } catch (err) {
    console.error(`[api] Error applying audit log:`, err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

/**
 * PUT /api/audit/:id/mark-extraction-fixed
 *
 * Mark that the extraction pipeline code has been fixed for this audit log.
 * Called by the resolve skill after it implements the extraction code fix.
 * The log should already have resolved=1 (data was auto-patched by audit).
 */
app.put("/api/audit/:id/mark-extraction-fixed", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ status: "error", message: "Invalid audit log ID" });
    }

    const updated = await markExtractionFixed(id);
    if (!updated) {
      return res.status(404).json({ status: "error", message: "Audit log not found" });
    }

    console.log(`[api] Marked extraction_fixed for audit log ${id}`);
    res.json({ status: "ok", log: updated });
  } catch (err) {
    console.error(`[api] Error marking extraction fixed:`, err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ─── Audit State ────────────────────────────────────────────────────────────

async function getLastAuditedId() {
  const result = await query("SELECT COALESCE(MAX(job_id), 0) as lastId FROM audit_logs");
  return Number(result.rows[0]?.lastId ?? 0);
}

/**
 * POST /api/audit/run
 *
 * Run an LLM-powered audit. Reads un-audited jobs from DB, sends each job's
 * raw HTML to Pi for extraction, compares against DB values, writes gaps
 * to audit_logs, and updates the state file.
 *
 * Body: { full?: boolean }  — set full=true to re-audit everything
 *
 * This is the main audit endpoint used by:
 *   - The standalone audit.js CLI wrapper
 *   - The server's internal scheduler
 *   - The resolve skill (after fixing extraction code)
 */
app.post("/api/audit/run", async (req, res) => {
  try {
    if (!piClient || !piClient.ready) {
      return res.status(503).json({ status: "error", message: "Pi client not ready. Wait for Pi to connect and try again." });
    }

    const forceFull = req.body?.full === true;
    const lastId = forceFull ? 0 : await getLastAuditedId();
    const { randomUUID } = await import("node:crypto");
    const runId = randomUUID();

    // Count new jobs
    const countResult = await query(
      "SELECT COUNT(*) as cnt FROM jobs WHERE id > ?",
      [lastId]
    );
    const newCount = Number(countResult.rows[0]?.cnt ?? 0);

    if (newCount === 0) {
      return res.json({
        __audit_result__: true,
        status: "no_new_jobs",
        lastAuditedId: lastId,
        forceFull,
        message: "All jobs already audited. Use --full to re-audit everything.",
      });
    }

    // Fetch new jobs (raw HTML needed for LLM extraction)
    const jobsResult = await query(
      "SELECT id, url, company, title, location, deadline, role_type, job_id, summary, raw_html FROM jobs WHERE id > ? ORDER BY id",
      [lastId]
    );

    let maxId = lastId;
    let totalLogs = 0;
    let jobsChecked = 0;

    for (const row of jobsResult.rows) {
      const id = Number(row.id);
      if (id > maxId) maxId = id;
      jobsChecked++;

      console.log(`[audit] Checking job #${id}...`);

      // Send raw HTML to Pi for extraction
      let extracted = {};
      try {
        extracted = await piClient.extractFromRawHtml(row.raw_html || "");
      } catch (err) {
        console.error(`[audit] Pi extraction failed for job #${id}:`, err.message);
        // Continue with empty extraction — will show as "not found" gaps
      }

      // Compare against DB values
      const stored = {
        company: row.company,
        title: row.title,
        location: row.location,
        deadline: row.deadline,
        role_type: row.role_type,
        job_id: row.job_id,
      };

      const fields = ["company", "title", "location", "deadline", "role_type", "job_id"];

      const allowedAutoFields = ["company", "title", "location", "deadline", "role_type", "job_id"];

      for (const field of fields) {
        const storedVal = stored[field];
        const foundVal = extracted[field];

        let status, foundValue, storedValue, note;
        const sourceVal = "llm";
        let autoApplied = false;

        if (foundVal !== undefined && foundVal !== null && (storedVal === null || storedVal === undefined)) {
          status = "missing";
          foundValue = String(foundVal);
          storedValue = "null";
          note = `Pi found "${foundVal}" in raw HTML but DB has null`;
          // Auto-apply the value to the job's DB field
          if (allowedAutoFields.includes(field)) {
            autoApplied = true;
          }
        } else if (foundVal !== undefined && foundVal !== null && storedVal !== null && String(foundVal).toLowerCase() !== String(storedVal).toLowerCase()) {
          status = "mismatch";
          foundValue = String(foundVal);
          storedValue = String(storedVal);
          note = `Pi found "${foundVal}" in raw HTML but DB has "${storedVal}"`;
          // Auto-apply — Pi's value is likely more correct (from raw HTML)
          if (allowedAutoFields.includes(field)) {
            autoApplied = true;
          }
        } else if (foundVal !== undefined && foundVal !== null && storedVal !== null) {
          status = "ok";
          foundValue = String(foundVal);
          storedValue = String(storedVal);
          note = `"${foundVal}" matches (Pi)`;
        } else {
          status = "na";
          foundValue = null;
          storedValue = storedVal !== null ? String(storedVal) : "null";
          note = "Pi could not find this field in the raw HTML";
        }

        // Dedup: skip if same (job_id, field, status, extraction_not_fixed) already exists
        const existing = await query(
          "SELECT id FROM audit_logs WHERE job_id = ? AND field = ? AND status = ? AND extraction_fixed = 0 LIMIT 1",
          [id, field, status]
        );
        if (existing.rows[0]) continue;

        // Auto-apply: update the job's field with the found value
        if (autoApplied) {
          const updateData = {};
          updateData[field] = foundValue;
          try {
            await updateJob(id, updateData);
          } catch (err) {
            console.error(`[audit] Failed to auto-apply ${field} for job #${id}: ${err.message}`);
          }
        }

        // Insert with resolved=1 (data patched) and extraction_fixed=0 (code still needs fix)
        await query(
          "INSERT INTO audit_logs (run_id, job_id, field, status, found_value, stored_value, source, note, resolved, extraction_fixed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [runId, id, field, status, foundValue, storedValue, sourceVal, note, 1, 0]
        );
        totalLogs++;

        if (autoApplied) {
          console.log(`[audit] Auto-fixed job #${id} ${field} = "${foundValue}"`);
        }
      }
    }

    // Update state
      // lastAuditedId tracked via audit_logs table
    console.log(`[audit] Done: checked ${jobsChecked} job(s), wrote ${totalLogs} log(s), run=${runId}`);

    res.json({
      __audit_result__: true,
      status: "ok",
      runId,
      jobsChecked,
      logsWritten: totalLogs,
      maxId,
      lastAuditedId: maxId,
    });
  } catch (err) {
    console.error(`[audit] Error running audit:`, err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

/**
 * GET /api/health
 *
 * Health check endpoint.
 */
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    piConnected: piClient?.ready ?? false,
    uptime: process.uptime(),
  });
});

// ─── Startup ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    // Initialize database
    await initDatabase();
    console.log("[server] Database initialized");

    // Start Pi RPC client
    piClient = new PiRPCClient({
      promptTimeout: 120_000, // 2 minutes per prompt
    });

    piClient.on("error", (err) => {
      console.error("[server] Pi client error:", err.message);
    });

    // Start Pi (non-blocking — server can run even if Pi takes a moment)
    piClient.start().then(() => {
      console.log("[server] Pi RPC client ready");
    }).catch((err) => {
      console.error("[server] Failed to start Pi RPC client:", err.message);
      console.error("[server] The server will still accept requests, but extraction will fail");
    });

    // Start Express
    app.listen(PORT, () => {
      console.log(`[server] SimpleSeek API running on http://localhost:${PORT}`);
      console.log(`[server] Endpoints:`);
      console.log(`[server]   POST /api/check-job  — Check a job for duplication`);
      console.log(`[server]   GET  /api/jobs       — List all applied jobs (JSON)`);
      console.log(`[server]   PUT  /api/jobs/:id   — Update a job`);
      console.log(`[server]   DELETE /api/jobs/:id  — Delete a job`);
      console.log(`[server]   GET  /               — Dashboard (this page)`);
      console.log(`[server]   GET  /dashboard      — Dashboard (alias)`);
      console.log(`[server]   GET  /api/audit      — List audit logs`);
      console.log(`[server]   GET  /api/audit/stats — Audit stats`);
      console.log(`[server]   GET  /api/audit/unresolved — Unresolved audit logs`);
      console.log(`[server]   PUT  /api/audit/:id/resolve — Resolve an audit log`);
      console.log(`[server]   PUT  /api/audit/:id/mark-extraction-fixed — Mark extraction code fixed`);
      console.log(`[server]   POST /api/audit/run  — Run LLM-powered audit`);
      console.log(`[server]   GET  /api/health     — Health check`);
      console.log(`[server]`);
      console.log(`[server] Audit scheduler: running every 6 hours (first run in 5 min)`);

      // Schedule periodic audit
      scheduleAudit();
    });
  } catch (err) {
    console.error("[server] Fatal startup error:", err);
    process.exit(1);
  }
}

/**
 * Run the audit via the internal POST /api/audit/run endpoint.
 */
async function runAudit() {
  if (!piClient || !piClient.ready) {
    console.log(`[audit] Skipping — Pi client not ready`);
    return;
  }

  console.log(`[audit] Starting scheduled audit...`);

  try {
    const res = await fetch(`http://localhost:${PORT}/api/audit/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full: false }),
    });

    if (!res.ok) {
      console.error(`[audit] Server returned ${res.status}`);
      return;
    }

    const result = await res.json();

    if (result.status === "no_new_jobs") {
      console.log(`[audit] No new jobs to audit (last: ${result.lastAuditedId})`);
    } else if (result.status === "ok") {
      console.log(`[audit] Checked ${result.jobsChecked} job(s), wrote ${result.logsWritten} log(s), run=${result.runId?.substring(0, 8)}...`);
    }
  } catch (err) {
    console.error(`[audit] Failed: ${err.message}`);
  }
}

/**
 * Schedule periodic audit runs.
 * Runs once after 5 minutes, then every 6 hours.
 */
function scheduleAudit() {
  const INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours
  const FIRST_DELAY_MS = 5 * 60 * 1000;     // 5 minutes

  setTimeout(() => {
    runAudit();
    setInterval(runAudit, INTERVAL_MS);
  }, FIRST_DELAY_MS);
}

main();
