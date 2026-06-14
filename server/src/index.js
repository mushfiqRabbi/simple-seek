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
import { getAllJobs, getJobCount, updateJob, deleteJob, getJobById } from "./db.js";
import { readFileSync } from "node:fs";
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

    console.log(`[api] Deleted job ${id}`);
    res.json({ status: "ok", message: "Job deleted" });
  } catch (err) {
    console.error(`[api] Error deleting job:`, err);
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
      console.log(`[server]   GET  /api/health     — Health check`);
    });
  } catch (err) {
    console.error("[server] Fatal startup error:", err);
    process.exit(1);
  }
}

main();
