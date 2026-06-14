#!/usr/bin/env node

/**
 * SimpleSeek Resolve — Gap Analysis Helper
 *
 * Fetches unresolved audit logs from the SimpleSeek API and groups them
 * by field for the resolve skill to analyze.
 *
 * Usage:
 *   cd /home/mushfiq/garage/build/simple-seek
 *   node .pi/skills/simple-seek-resolve/scripts/resolve.js
 *
 * Requires the SimpleSeek server to be running on http://localhost:3001.
 */

const SERVER = process.env.SERVER_URL || "http://localhost:3001";

async function main() {
  // Fetch unresolved logs
  const res = await fetch(`${SERVER}/api/audit/unresolved`);
  if (!res.ok) {
    console.error(`Error: Server returned ${res.status}. Is the server running on ${SERVER}?`);
    process.exit(1);
  }

  const data = await res.json();
  const logs = data.logs || [];

  if (logs.length === 0) {
    console.log(JSON.stringify({
      status: "no_gaps",
      message: "No unresolved audit logs found. All extraction gaps have been resolved.",
    }));
    return;
  }

  // Group by field
  const byField = {};
  for (const log of logs) {
    if (!byField[log.field]) byField[log.field] = [];
    byField[log.field].push(log);
  }

  // Build summary
  const summary = [];
  for (const [field, entries] of Object.entries(byField)) {
    const statuses = {};
    const sources = new Set();
    for (const e of entries) {
      statuses[e.status] = (statuses[e.status] || 0) + 1;
      if (e.source) sources.add(e.source);
    }
    summary.push({
      field,
      count: entries.length,
      statuses,
      sources: [...sources],
      sample: {
        found_value: entries[0].found_value,
        stored_value: entries[0].stored_value,
        note: entries[0].note,
        job_id: entries[0].job_id,
        job_title: entries[0].job_title,
      },
    });
  }

  console.log(JSON.stringify({
    status: "gaps_found",
    totalGaps: logs.length,
    gapFields: Object.keys(byField).length,
    byField: summary,
    allLogs: logs,
  }));
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
