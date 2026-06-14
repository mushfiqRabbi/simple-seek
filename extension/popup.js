/**
 * SimpleSeek Popup — Pipeline Bars Layout
 *
 * Shows status distribution as horizontal bars, extraction gap alerts,
 * Pi connection status, and a dashboard link.
 */

const SERVER_URL = "http://localhost:3001";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function statusClass(status) {
  switch (status) {
    case "applied":      return "applied";
    case "interviewing": return "interview";
    case "offer":        return "offer";
    case "rejected":     return "rejected";
    default:             return "applied";
  }
}

function statusLabel(status) {
  switch (status) {
    case "interviewing": return "Interview";
    case "applied":      return "Applied";
    case "offer":        return "Offer";
    case "rejected":     return "Rejected";
    default:             return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderPipeline(jobs, auditStats, health) {
  // Count statuses
  const counts = { applied: 0, interviewing: 0, offer: 0, rejected: 0 };
  for (const job of jobs) {
    const s = (job.status || "applied").toLowerCase();
    if (counts[s] !== undefined) counts[s]++;
    else counts.applied++; // fallback
  }

  const total = jobs.length;
  const maxCount = Math.max(...Object.values(counts), 1);

  // Update header badge
  $("totalBadge").textContent = `📊 ${total}`;

  // Build bar HTML
  let barsHtml = "";
  const order = ["applied", "interviewing", "offer", "rejected"];
  for (const key of order) {
    const cnt = counts[key];
    const pct = maxCount > 0 ? Math.round((cnt / maxCount) * 100) : 0;
    const barW = cnt > 0 ? Math.max(pct, 8) : 0; // at least 8px so label fits
    barsHtml += `
      <div class="bar-row">
        <span class="bar-label">${statusLabel(key)}</span>
        <div class="bar-track">
          <div class="bar-fill ${statusClass(key)}" style="width:${barW}%">${cnt > 0 ? cnt : ""}</div>
        </div>
        <span class="bar-count">${cnt}</span>
      </div>
    `;
  }

  // Gap alert
  const gaps = auditStats?.extractionIssues ?? 0;
  const gapHtml = gaps > 0
    ? `<div class="gap-alert warning">⚠️ ${gaps} extraction gap${gaps > 1 ? "s" : ""} — <a href="${SERVER_URL}/" target="_blank">check dashboard</a></div>`
    : `<div class="gap-alert ok">✅ All extractions clean</div>`;

  // Pi status
  const piReady = health?.piConnected ?? false;
  const piHtml = piReady
    ? `<span class="pi-status"><span class="pi-dot ready"></span>Pi ready</span>`
    : `<span class="pi-status"><span class="pi-dot busy"></span>Pi connecting...</span>`;

  $("content").innerHTML = `
    ${gapHtml}
    ${barsHtml}
    <hr class="divider">
    <div class="footer-row">
      ${piHtml}
      <a href="${SERVER_URL}/" target="_blank">📋 Dashboard →</a>
    </div>
    <div class="tip">Right-click any job page → SimpleSeek → Check Duplicate</div>
  `;
}

function renderError(err) {
  $("content").innerHTML = `
    <div class="error-state">
      ❌ Server unreachable
      <div class="detail">${err.message}</div>
      <div style="margin-top:10px"><a href="${SERVER_URL}/" target="_blank">Open Dashboard</a></div>
    </div>
  `;
  $("totalBadge").textContent = "📊 —";
}

// ─── Main ────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  try {
    // Fetch all jobs, audit stats, and health in parallel
    const [jobsRes, statsRes, healthRes] = await Promise.all([
      fetch(`${SERVER_URL}/api/jobs?limit=9999`),
      fetch(`${SERVER_URL}/api/audit/stats`),
      fetch(`${SERVER_URL}/api/health`),
    ]);

    if (!jobsRes.ok) throw new Error(`Jobs API: ${jobsRes.status}`);
    if (!statsRes.ok) throw new Error(`Audit stats: ${statsRes.status}`);
    if (!healthRes.ok) throw new Error(`Health: ${healthRes.status}`);

    const jobsData = await jobsRes.json();
    const auditStats = await statsRes.json();
    const health = await healthRes.json();

    renderPipeline(jobsData.jobs || [], auditStats, health);
  } catch (err) {
    // If it's a network/server error, show the error state
    renderError(err);
  }
});
