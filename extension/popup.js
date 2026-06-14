/**
 * SimpleSeek Popup Script
 *
 * Shows basic stats from the SimpleSeek server.
 */

const SERVER_URL = "http://localhost:3001";

document.addEventListener("DOMContentLoaded", async () => {
  const statsEl = document.getElementById("stats");
  const statusEl = document.getElementById("status");

  try {
    const response = await fetch(`${SERVER_URL}/api/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const health = await response.json();

    // Fetch job count
    const jobsResponse = await fetch(`${SERVER_URL}/api/jobs?limit=1`);
    const jobsData = await jobsResponse.json();

    statsEl.textContent = `📊 ${jobsData.total || 0} jobs tracked  •  Server: ${health.piConnected ? "✅ Pi connected" : "⏳ Pi connecting..."}`;
    statusEl.innerHTML = `<span class="label">Status:</span> <span class="value" style="color: ${health.piConnected ? '#4CAF50' : '#FFA500'}">${health.piConnected ? 'Ready' : 'Starting up...'}</span>`;
  } catch (err) {
    statsEl.textContent = "📊 Unable to reach server";
    statusEl.innerHTML = `<span class="label error">Error:</span> <span class="value error">${err.message}. Is the server running?</span>`;
  }
});
