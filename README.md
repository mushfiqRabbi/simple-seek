# SimpleSeek — Job Duplication Detection

A personal job-application tracker with AI-powered duplication detection. Right-click on any job page → **SimpleSeek → Check** to see if you've already applied, or **Apply** to check and save the job.

The system uses [Pi coding agent](https://pi.dev) in RPC mode to extract structured job data (company, title, location, deadline) from the page HTML, then checks a **Turso-hosted SQLite database** for duplicates — accessible from any device.

## Architecture

```
Chrome Extension ──POST /api/check-job──► Express Server ──stdin/stdout──► pi --mode rpc
                     { html, url,        │                              │
                       action }          │                              ▼
                                          │                      LLM Backend
                                          │                     (Gemini/GPT)
                                          │
                                          ▼
                                  Turso (Cloud SQLite)
                                  ─────────────────
                                  • Accessible from any device
                                  • Free tier: 5 GB, 100 DBs
                                  • Same SQL as SQLite
```

## Prerequisites

- **Node.js** ≥ 24.x (already installed)
- **Pi coding agent** ≥ 0.79.x (already installed: `pi --version`)
- **Chrome** (for the extension)
- **Turso CLI** — `curl -sSfL https://get.turso.tech | bash`
- **Docker** (optional) — for running via container: `docker compose up -d`

Pi must have at least one LLM provider configured:
```
opencode providers list
```
(OpenCode and Pi share provider configs — Google Gemini and Cloudflare are already configured.)

## Quick Start

### 1. Set up Turso database

```bash
# Install the Turso CLI (if you haven't already)
curl -sSfL https://get.turso.tech | bash

# Sign in (opens browser)
turso auth login

# Create a database
turso db create simpleseek

# Get the connection URL
turso db show simpleseek --url

# Generate an auth token
turso db tokens create simpleseek
```

Add the URL and token to **`server/.env`**:
```
TURSO_DB_URL=libsql://simpleseek-xxxx.turso.io
TURSO_AUTH_TOKEN=eyJ...
```

### 2. Install server dependencies

```bash
cd server
npm install
```

### 3. Start the server

Choose one of these options:

#### Option A — Run directly (Node.js)
```bash
cd server
npm start
```

#### Option B — Run with Docker
```bash
# From the project root
cd /home/arbree/garage/build/simple-seek
docker compose up -d
```

Either way the server starts on `http://localhost:3001`. Pi is automatically launched in RPC mode as a subprocess. The database lives in Turso cloud.

> **Docker DNS note:** If you see `getaddrinfo EAI_AGAIN` errors connecting to Turso from the container, the compose file includes explicit DNS servers (`1.1.1.1`, `8.8.8.8`) to work around Docker's internal resolver. If your host DNS resolves Turso fine, you can remove those lines.

### 4. Load the Chrome extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. The SimpleSeek extension is now installed

### 5. Use it

1. Navigate to any job application page
2. **Right-click** anywhere on the page → **SimpleSeek**

| Option | What it does |
|--------|-------------|
| **Check** | Checks for duplicates and notifies you. Does **not** save anything. |
| **Apply** | Checks for duplicates and, if new, saves the job to your database. |

3. Click the notification to open the dashboard.

### 6. Dashboard

Open `http://localhost:3001/` in your browser to view, edit, and manage all your tracked jobs.

## API Reference

### `POST /api/check-job`

Check if a job is a duplicate and optionally save it.

**Request:**
```json
{
  "html": "<html>...</html>",
  "url": "https://company.com/jobs/123",
  "action": "check"
}
```

| Field | Description |
|-------|-------------|
| `html` | Full page HTML |
| `url`  | Page URL |
| `action` | `"check"` — only check, don't save. `"apply"` — check and save if new (default). |

**Response (new — `apply` action):**
```json
{
  "status": "new",
  "message": "New job saved!",
  "job": {
    "id": 1,
    "company": "Google LLC",
    "title": "Software Engineer",
    "location": "Mountain View, CA",
    "deadline": "2025-07-15",
    "role_type": "Full-time"
  }
}
```

**Response (new — `check` action):**
```json
{
  "status": "new",
  "message": "No duplicate found — this job hasn't been applied to yet.",
  "job": {
    "company": "Google LLC",
    "title": "Software Engineer",
    "location": "Mountain View, CA",
    "deadline": "2025-07-15",
    "role_type": "Full-time"
  }
}
```

**Response (duplicate):**
```json
{
  "status": "duplicate",
  "message": "You already applied to this job on 2026-06-13 23:01:13",
  "existingJob": {
    "id": 1,
    "company": "Google LLC",
    "title": "Software Engineer",
    "location": "Mountain View, CA",
    "applied_at": "2026-06-13 23:01:13"
  }
}
```

### `GET /api/jobs`

List all applied jobs.

**Query parameters:** `?limit=50&offset=0`

### `PUT /api/jobs/:id`

Update a job's fields (status, company, title, location, deadline, role_type, summary).

**Request:**
```json
{
  "status": "interviewing",
  "location": "Remote"
}
```

### `DELETE /api/jobs/:id`

Delete a single job entry.

### `GET /api/health`

Server health check.

## Dashboard

The dashboard is served at `http://localhost:3001/` (also `/dashboard`). It's a single-page HTML app with:

- **Search** — Filter jobs by company, title, or location
- **Edit** — Click ✏️ on any row to update fields (status, dates, notes)
- **Delete single** — Remove a job with confirmation prompt
- **Multi-select delete** — Check multiple jobs and delete them all at once
- **Select All** — Toggle checkbox in the table header
- **Pagination** — Browse through jobs
- **Dark theme** — Easy on the eyes
- **Auto-refresh** — Updates every 60 seconds

## Project Structure

```
├── server/
│   ├── package.json
│   ├── package-lock.json
│   ├── .env                         # Turso credentials + Pi config (gitignored)
│   ├── .env.example                 # Environment template (no secrets)
│   └── src/
│       ├── index.js                 # Express app entry, routes
│       ├── db.js                    # Turso client + CRUD queries
│       ├── pi-client.js             # Pi RPC subprocess manager
│       ├── extractor.js             # HTML→Markdown→Pi extraction pipeline
│       ├── dedup.js                 # Duplicate matching logic
│       ├── dashboard.html           # Web dashboard (single-file)
│       └── schema.sql               # Database schema
├── extension/
│   ├── manifest.json                # Chrome extension manifest (MV3)
│   ├── background.js                # Service worker (context menu + API calls)
│   ├── content.js                   # Content script (reads page HTML)
│   ├── popup.html                   # Extension popup
│   ├── popup.js                     # Popup logic
│   └── icons/                       # Extension icons
├── Dockerfile                  # Docker image (Node 24 + Pi CLI)
├── docker-compose.yml          # One-command deploy with Docker
├── .gitignore
└── README.md
```

## How Duplication Detection Works

1. **Extraction (AI)** — The page HTML is converted to markdown (via Readability + Turndown). Job metadata (location, deadline, etc.) is also extracted directly from the raw HTML since Readability strips sidebar content. Both are sent to Pi, which extracts structured fields: company, title, location, deadline, role type, job ID, and a short summary.

2. **Matching (Database)** — The extracted fields are checked against Turso in priority order:
   - **Priority 1:** URL exact match
   - **Priority 2:** Job ID / Requisition ID match
   - **Priority 3:** Company + Title (case-insensitive)

3. **Storage** — New jobs (via **Apply**) are saved with all extracted metadata plus the original HTML and markdown for future re-analysis.

This approach is cheaper, faster, and more reliable than asking the AI to compare two jobs directly.

## Database

Your data lives in **Turso** — a cloud-hosted, SQLite-compatible database. This means:
- **Accessible from any device** — query it from your phone, laptop, or any backend
- **No local file** — no `data/simpleseek.db`, no manual backups needed
- **Same SQL** — all your existing SQLite queries and schema work unchanged

Free tier includes 5 GB storage, 100 databases, and 500 million rows read per month.

Each job stores:
- **Metadata:** company, title, location, deadline, role_type, job_id
- **Content:** full page markdown, raw HTML, Pi's raw JSON response
- **Status:** applied → interviewing → offer → rejected (editable via dashboard)
- **Timestamps:** applied_at

Query your data from any device:
```bash
turso db shell simpleseek -- "SELECT company, title, status FROM jobs;"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `TURSO_DB_URL` | — | Turso database connection URL (e.g. `libsql://...turso.io`) |
| `TURSO_AUTH_TOKEN` | — | Turso authentication token |

Pi's provider configuration is managed independently via `pi` CLI/TUI.

## Docker

The project includes a `Dockerfile` and `docker-compose.yml` for containerized deployment.

### Build & Run

```bash
docker compose up -d
```

This builds the image from `node:24`, installs Pi globally, copies the server code, and starts on port 3001. Your `~/.pi/` directory is mounted so Pi can access your LLM provider config and write session data.

### Stop

```bash
docker compose down
```

### How it works

The container runs exactly the same code as `npm start`. The only difference is:
- Pi CLI is pre-installed in the image
- Your `~/.pi/` provider config is mounted at runtime (not baked into the image)
- Explicit DNS (`1.1.1.1`, `8.8.8.8`) is configured for reliable Turso resolution
- The server auto-restarts unless stopped (`restart: unless-stopped`)
