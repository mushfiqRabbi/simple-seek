---
name: simple-seek-resolve
description: >
  Analyzes unresolved audit logs from the SimpleSeek audit system, reads the
  relevant extraction code (server/src/extractor.js), and generates a concrete
  plan to fix extraction gaps. Use when the audit system reports missing or
  mismatched job data fields.
---

# SimpleSeek Resolve

Analyze extraction gaps, fix the pipeline code, and mark them resolved.

**Note:** The audit system now **automatically fills missing data** into the
job's DB fields. So by the time you use this skill, the data is already patched.
Your job is to fix the **root cause** in the extraction code so future jobs
don't have the same gap.

## Setup

Requires the SimpleSeek server to be running on `http://localhost:3001`.

## Instructions

### Step 1: Fetch unresolved audit logs (extraction issues)

Run the resolve helper script from the project root:

```bash
cd /home/mushfiq/garage/build/simple-seek && node .pi/skills/simple-seek-resolve/scripts/resolve.js
```

Or fetch directly from the API:

```bash
curl -s http://localhost:3001/api/audit/unresolved
```

This returns logs where `extraction_fixed=0` — these are gaps where:
- Data WAS auto-patched into the job ✓
- But the extraction code still has a bug that needs fixing ⚠️

Each log has:
- `id` — audit log entry ID
- `job_id` — the job that was audited
- `field` — which field was checked (`role_type`, `location`, `job_id`, etc.)
- `status` — `missing` (data in HTML, null in DB), `mismatch` (different values)
- `found_value` — what Pi found in the raw HTML
- `stored_value` — what was in the database (probably already fixed by auto-apply)
- `resolved` — should be 1 (data was auto-patched)
- `extraction_fixed` — 0 (code still needs fixing)

### Step 2: Group gaps by field

Group the logs by `field` to identify patterns. For example:
- 3 logs all showing `role_type: missing` from `json-ld` source
- 2 logs showing `location: missing` from `visible_text` source

This tells you which extraction logic needs fixing and how common the gap is.

### Step 3: Read the extraction code

Read the current extraction pipeline:

```bash
cat server/src/extractor.js
```

Pay attention to:
1. `extractMetadataFromHtml()` — the regex-based metadata extraction
2. `htmlToMarkdown()` — the Readability + Turndown conversion
3. How extracted metadata is prepended to the markdown

Also read the audit script's extraction methods for reference on how data IS found:

```bash
cat .pi/skills/simple-seek-audit/scripts/audit.js
```

### Step 4: Analyze each gap pattern

For each field group, determine:

1. **Where does the data live in the raw HTML?**
   - JSON-LD (`<script type="application/ld+json">`)?
   - Visible text (specific HTML elements)?
   - Meta tags?
   - Microdata attributes?

2. **Why did the current extractor miss it?**
   - Regex looks for a label pattern the site doesn't use?
   - Readability stripped the relevant section?
   - Pi/LLM got confused by the content?

3. **What's the minimal fix?**
   - Add a new regex pattern to `extractMetadataFromHtml()`?
   - Add JSON-LD parsing?
   - Improve the markdown prepended to Pi's input?

### Step 5: Produce a fix plan

Generate a structured fix plan with this format:

```
## Fix Plan: <field> extraction

### Problem
<describe the gap — what data is missing, where it exists in HTML>

### Root cause
<what in the extraction pipeline causes this>

### Proposed fix
<exact code changes needed — be specific>

### Files to modify
- server/src/extractor.js (function X, line Y)

### Verification
<how to confirm the fix works — re-run audit, check extraction_fixed status>
```

### Step 6: Present to the user

Output the full fix plan. Ask the user if they want to implement it.

If they approve, make the code changes.

### Step 7: Mark extraction as fixed

After implementing the extraction code fix, mark the corresponding audit logs
as extraction_fixed=1 so they no longer show as issues:

```bash
# Mark a single log
curl -s -X PUT http://localhost:3001/api/audit/<ID>/mark-extraction-fixed

# Or mark all logs for a specific field that was fixed
curl -s http://localhost:3001/api/audit?field=role_type\&extraction_fixed=0 | \
  node -e "
    const d = require('fs').readFileSync('/dev/stdin','utf8');
    const logs = JSON.parse(d).logs || [];
    Promise.all(logs.map(l =>
      fetch('http://localhost:3001/api/audit/' + l.id + '/mark-extraction-fixed', { method: 'PUT' })
    )).then(() => console.log('Marked ' + logs.length + ' logs as extraction_fixed'));
  "
```

### Step 8: Re-run audit to confirm

Run a full re-audit to confirm the fix:

```bash
cd /home/mushfiq/garage/build/simple-seek
NODE_PATH=server/node_modules node .pi/skills/simple-seek-audit/scripts/audit.js --full
```

The previously missing fields should now have `extraction_fixed=1` (if marked)
or should no longer appear as gaps because the extractor now catches them.
